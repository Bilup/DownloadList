/**
 * 多线程分段下载。
 *
 * 服务端（Pages 的下载代理）完整支持 Range：Accept-Ranges、206 Partial Content、
 * 多区间 multipart、416、304 都已实测通过，且不同分段请求会命中边缘缓存。
 *
 * 何时多线程更快、何时更慢（关键，决定了默认策略）：
 *
 *   文件已在边缘缓存（HIT）
 *     → 每个分段直接从边缘缓存吐出，不再回源。
 *       多条连接可以突破单连接的 RTT 瓶颈，高延迟链路上提升明显。
 *
 *   文件尚未缓存（MISS）
 *     → Cloudflare 需要先把**整个文件**从源站拉下来填满缓存，
 *       分段请求才拿得到自己的那一段。
 *       多个分段请求会各自触发一次完整回源（边缘缓存不做请求合并），
 *       既互相抢带宽又把源站打爆 —— **这种情况多线程反而更慢**。
 *
 * 所以这里先探测缓存状态，再据此给出建议。
 */

/** File System Access API 的最小类型声明（标准 lib 里没有） */
interface FileSystemWritableFileStream extends WritableStream {
    write(data: BufferSource | Blob | string | {
        type: "write";
        position: number;
        data: BufferSource | Blob | string;
    }): Promise<void>;
    close(): Promise<void>;
    abort?: () => Promise<void>;
}

interface SaveFilePickerOptions {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

interface FileSystemFileHandle {
    createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
    name: string;
}

interface WindowWithPicker {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
}

export const turboSupported = (): boolean =>
    typeof window !== "undefined" && typeof (window as WindowWithPicker).showSaveFilePicker === "function";

export class TurboUnsupportedError extends Error {
    constructor() {
        super("当前浏览器不支持流式写盘（需要 Chrome / Edge）");
        this.name = "TurboUnsupportedError";
    }
}

/** 缓存状态探测结果 */
export interface CacheProbe {
    /** 文件总长度（字节） */
    total: number;
    /** 边缘缓存是否命中：HIT 表示文件已在缓存，多线程能直接受益 */
    cached: boolean;
    /** 原始状态字符串（cf-cache-status），便于排查 */
    raw: string;
}

export interface TurboProgress {
    done: number;
    total: number;
    speed: number;
    finishedChunks: number;
    totalChunks: number;
}

export interface TurboOptions {
    threads?: number;
    /** 已知文件总长度；提供则跳过内部探测，避免重复请求 */
    knownTotal?: number;
    /** 进度回调（已做节流，约每 200ms 一次） */
    onProgress?: (progress: TurboProgress) => void;
    /** 完成回调 */
    onDone?: (elapsedMs: number) => void;
    /** 出错回调 */
    onError?: (error: Error) => void;
}

/** 每个分段的大小：太小则请求数多，太大则首字节等待久，8 MiB 是折中 */
const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * 写盘缓冲大小。
 *
 * File System Access API 的 WritableStream **一次只能处理一个 write**，
 * 多个并发 write 调用会被串行排队。而网络分块通常只有 64KB 左右，
 * 169MB 的文件会产生约 2640 次 write 调用 —— 写盘就成了瓶颈，
 * 多线程下载反而比单线程还慢。
 *
 * 所以每个线程先在内存里攒够 1 MiB 再写一次，
 * write 调用次数降到约 1/16，且内存占用依然恒定。
 */
const WRITE_BUFFER_SIZE = 1024 * 1024;

/**
 * 最大并发线程数。
 *
 * 每个分段都是一次独立的 Worker 请求，超出并发槽的部分会排队，
 * 排队的分段不仅没提速，还占着连接、白白消耗请求配额
 * （Workers Free 是 10 万次/天，16 段就是 16 倍消耗）。
 *
 * 8 是实测下来收益与开销的平衡点：再往上收益递减，开销线性上升。
 */
const MAX_THREADS = 8;

/**
 * 探测文件大小与边缘缓存状态。
 *
 * 用 `GET Range: bytes=0-1` 而不是 HEAD —— 实测两者的缓存行为不同：
 *   HEAD → cf-cache-status: DYNAMIC（HEAD 不享受边缘缓存）
 *          首次探测必然报 MISS，对**已缓存**的文件也会误判。
 *   GET Range: bytes=0-1 → 准确反映缓存状态，且只传 2 字节。
 *
 * 缓存状态的含义（实测得出，决定了整个功能的正确用法）：
 *
 *   Cloudflare 缓存的是**完整对象**（200 响应），**不缓存 206 部分响应**。
 *   所以 Range 请求的回源状态永远是 MISS —— 除非完整对象已经缓存好了，
 *   此时 Range 请求能直接命中那个完整对象并切出所需区间。
 *
 *   实测：某文件普通下载（完整 GET）之前，Range 探测回源状态为 MISS；
 *        普通下载完成后再探测 → MISS → HIT → HIT。
 *
 *   这意味着：
 *     冷缓存时，N 个分段各自独立回源，源站要承受 N 个并发连接，
 *     实测 16 段并发时聚合速度只有 301 KB/s，比单线程的 478 KB/s 还慢。
 *     热缓存时，分段直接从边缘缓存切出，多线程才有真实收益。
 *
 *   所以前端据此决定是否启用多线程，而不是「提示一下就算了」——
 *   冷缓存下让用户点下去，注定是更慢的结果。
 */
export async function probeFile(url: string): Promise<CacheProbe> {
    /**
     * 探测用「完整 GET + 立即中止响应体」，而不是 Range 请求。
     *
     * 原因一：Range 请求命中边缘缓存时，Cloudflare 会按 Range 变体分别缓存，
     *   从 Range 探测的结果**判断不出完整对象是否已在缓存里**。
     *
     * 原因二：完整 GET 会把完整对象真正灌进边缘缓存（客户端中止也不影响
     *   Cloudflare 继续回源并缓存）—— 所以这一次探测顺带就把缓存预热了，
     *   探测结束时缓存已经就绪，多线程立刻可用。
     *
     * 查询串加随机数：让每次探测都绕开 Cloudflare 对 Worker 响应的那层缓存，
     * 强制 Worker 真正执行，从而拿到**当前**的缓存状态。
     * 不加的话第二次探测会命中当初缓存的响应快照，
     * 里面的状态是写入那一刻的陈旧值（实测踩过：明明已缓存却显示未缓存）。
     */
    const probeUrl = url
        + (url.indexOf("?") >= 0 ? "&" : "?")
        + "_probe=" + Math.random().toString(36).slice(2);

    const res = await fetch(probeUrl);
    if (!res.ok) {
        throw new Error(`无法获取文件信息 (HTTP ${res.status})`);
    }

    /**
     * 缓存状态读 `cf-cache-status`，**不是** `x-proxy-cache-status`。
     *
     * 这两个头说的不是一回事：
     *   cf-cache-status       → Cloudflare 边缘缓存**当前是否命中**
     *                          （由 CF 每次返回缓存响应时重写，值永远正确）
     *   x-proxy-cache-status → Worker 内部**回源层**的状态。
     *                          Pages 层缓存命中时 Worker 根本不执行，
     *                          响应是旧快照，这个头是写入那刻的陈旧值 —— 不可用。
     */
    const raw = (res.headers.get("cf-cache-status") || "UNKNOWN").toUpperCase();
    const total = Number(res.headers.get("content-length") || 0);

    // 立刻中止传输：只要响应头，不要文件内容
    try { await res.body?.cancel(); } catch (e) { /* 忽略 */ }

    if (!total) {
        throw new Error("无法获取文件总长度");
    }
    return { total, cached: raw === "HIT", raw };
}

/**
 * 多线程分段下载。
 *
 * @param url       文件下载地址
 * @param fileName  建议的文件名
 * @param options   配置
 */
export async function turboDownload(url: string, fileName: string, options: TurboOptions = {}): Promise<void> {
    const threads = Math.max(1, Math.min(MAX_THREADS, options.threads ?? 4));

    // 1. 询问总长度（已探测过则直接复用，避免重复请求）
    const total = options.knownTotal && options.knownTotal > 0
        ? options.knownTotal
        : (await probeFile(url)).total;

    // 2. 让用户选择保存位置
    const picker = (window as WindowWithPicker).showSaveFilePicker;
    if (!picker) throw new TurboUnsupportedError();
    const handle = await picker.call(window, { suggestedName: fileName });
    const writable = await handle.createWritable();

    // 3. 规划分段：尽量均分，且每段不超过 CHUNK_SIZE
    const chunkCount = Math.min(threads, Math.max(1, Math.ceil(total / CHUNK_SIZE)));
    const chunkSize = Math.ceil(total / chunkCount);
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize;
        if (start >= total) break;
        ranges.push({ start, end: Math.min(start + chunkSize - 1, total - 1) });
    }

    const startedAt = performance.now();
    let downloaded = 0;
    let finishedChunks = 0;
    let lastNotify = 0;

    const notify = (force = false) => {
        const now = performance.now();
        if (!force && now - lastNotify < 200) return;
        lastNotify = now;
        const elapsed = (now - startedAt) / 1000;
        options.onProgress?.({
            done: downloaded,
            total,
            speed: elapsed > 0 ? Math.round(downloaded / elapsed) : 0,
            finishedChunks,
            totalChunks: ranges.length
        });
    };

    const worker = async (range: { start: number; end: number }) => {
        const res = await fetch(url, {
            headers: { Range: `bytes=${range.start}-${range.end}` }
        });
        /**
         * 必须严格是 206。
         *
         * 早先这里写成「206 或 200 都接受」是个危险的漏洞：
         * 若服务端忽略了 Range 而返回 200（整个文件），
         * 后续会把完整文件从 range.start 偏移处写入 —— 下载下来的文件是坏的，
         * 而且坏得不容易被发现（大小对不上、内容错位）。
         * 宁可明确失败，也不产出损坏的文件。
         */
        if (res.status !== 206) {
            try { await res.body?.cancel(); } catch (e) { /* 忽略 */ }
            throw new Error(
                `分段 ${range.start}-${range.end} 请求失败 (HTTP ${res.status}，预期 206 分段响应)`
            );
        }
        if (!res.body) throw new Error("响应没有可读流");

        const reader = res.body.getReader();
        let position = range.start;
        // 攒够 WRITE_BUFFER_SIZE 再落盘，避免 WritableStream 被海量小写入拖垮
        const buffer = new Uint8Array(WRITE_BUFFER_SIZE);
        let buffered = 0;

        const flush = async () => {
            if (buffered === 0) return;
            await writable.write({ type: "write", position, data: buffer.slice(0, buffered) });
            position += buffered;
            buffered = 0;
        };

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                const need = value.byteLength;
                if (buffered + need > buffer.length) {
                    await flush();
                    if (need > buffer.length) {
                        // 单个分块就超过缓冲区，直接整块写入
                        await writable.write({ type: "write", position, data: value });
                        position += need;
                    } else {
                        buffer.set(value, 0);
                        buffered = need;
                    }
                } else {
                    buffer.set(value, buffered);
                    buffered += need;
                }
                downloaded += need;
                notify();
            }
            await flush();
        } finally {
            try { reader.releaseLock(); } catch (e) { /* 忽略 */ }
        }
        finishedChunks++;
        notify(true);
    };

    try {
        // 4. 并发拉取各分段
        //
        // 早先这里让各分段错开 120ms 启动，为的是别让 N 个分段同时打满
        // Worker 并发槽 —— 但那是在冷缓存场景下的顾虑，而冷缓存下多线程
        // 整体就没有收益（前端已直接禁用），根本走不到这里。
        //
        // 命中边缘缓存时各分段都能立刻从边缘切出、无需排队，
        // 错开启动只剩纯粹的延迟损耗（16 段就是 1.9 秒），所以直接并发。
        await Promise.all(ranges.map((range) => worker(range)));
        await writable.close();
        notify(true);
        options.onDone?.(performance.now() - startedAt);
    } catch (error) {
        const failed = error instanceof Error ? error : new Error(String(error));
        try { if (writable.abort) await writable.abort(); } catch (e) { /* 忽略 */ }
        options.onError?.(failed);
        throw failed;
    }
}

/** 把字节数格式化成人类可读的速度 */
export function formatSpeed(bytesPerSecond: number): string {
    if (!bytesPerSecond) return "0 B/s";
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let value = bytesPerSecond;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
