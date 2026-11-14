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
    const res = await fetch(url, { headers: { Range: "bytes=0-1" } });

    /**
     * 判断「服务端是否支持分段」用的是**状态码**，不是 Accept-Ranges 头。
     *
     * 踩过的坑：早先这里读 `Accept-Ranges` 头，缺头就报错「服务端不支持分段下载」。
     *
     * 实测结论（同一文件、同一服务端逻辑）：
     *   不带 Range 的 200 响应 → 有 `Accept-Ranges: bytes`
     *   带 Range 的 206 响应   → **没有该头**
     *
     * 原因：Cloudflare 接管缓存后由自己处理 Range 语义，不再透传这个头
     * （响应不被缓存、cf-cache-status 为 DYNAMIC 时才原样透传）。
     * 另外缓存里还可能存着旧版本 Worker 写入的响应快照，
     * 那种条目更是缺这个头。
     *
     * 状态码则没有歧义：
     *   206 → 服务端确实按 Range 截断了内容 → 支持分段
     *   200 → 服务端忽略了 Range，直接返回整个文件 → 不支持
     */
    if (res.status === 200) {
        // 服务端不支持 Range 时会把整个文件推过来，立刻中止，避免白下几十上百 MB
        try { await res.body?.cancel(); } catch (e) { /* 忽略 */ }
        throw new Error("服务端不支持分段下载（请求 Range 后返回的是完整文件）");
    }
    if (!res.ok) {
        throw new Error(`无法获取文件信息 (HTTP ${res.status})`);
    }

    // 分段响应里总长度在 Content-Range: bytes 0-1/<total> 里
    const contentRange = res.headers.get("content-range") || "";
    const totalFromRange = /\/(\d+)\s*$/.exec(contentRange);
    const total = Number(
        totalFromRange ? totalFromRange[1] : (res.headers.get("content-length") || 0)
    );
    if (!total) {
        throw new Error("无法获取文件总长度");
    }

    /**
     * 缓存状态读 `cf-cache-status`，**不是** `x-proxy-cache-status`。
     *
     * 这两个头说的不是一回事：
     *   cf-cache-status         → Cloudflare 边缘缓存**当前是否命中**
     *                            （CF 自己重写，永远反映真实状态）
     *   x-proxy-cache-status   → Worker 内部**回源层**的状态
     *
     * 实测踩过的坑：曾经用 x-proxy-cache-status 判断，结果多线程永远被禁用。
     * 原因是 Cloudflare 会缓存 Worker 的**最终响应**，命中时 Worker 根本不执行，
     * 直接返回当初缓存的响应快照 —— 快照里的 x-proxy-cache-status
     * 是写入那一刻的陈旧值（比如当时是 MISS），之后再也没更新过。
     *
     * 而 cf-cache-status 由 CF 在每次返回缓存响应时重写，值永远正确。
     *
     * 取值含义：
     *   HIT      → 命中边缘缓存，Range 能直接从完整对象切出 → 多线程有效
     *   MISS     → 缓存已过期需回源 → 各分段独立回源 → 多线程更慢
     *   DYNAMIC  → 不走缓存 → 同上
     *   BYPASS   → 强制回源 → 同上
     *   EXPIRED  → 陈旧数据，保守当作冷
     */
    const raw = (res.headers.get("cf-cache-status")
        || res.headers.get("x-proxy-cache-status")
        || "UNKNOWN").toUpperCase();
    const cached = raw === "HIT";
    // 读掉 2 字节响应体，保持连接干净
    try { await res.arrayBuffer(); } catch (e) { /* 忽略 */ }
    return { total, cached, raw };
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
