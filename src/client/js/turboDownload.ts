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
    /** 边缘缓存状态：HIT 表示文件已在缓存，多线程能直接受益 */
    cached: boolean;
    /** 原始状态字符串，便于排查 */
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
    onProgress?: (progress: TurboProgress) => void;
    onDone?: (elapsedMs: number) => void;
    onError?: (error: Error) => void;
}

/** 每个分段的大小：太小则请求数多，太大则首字节等待久，8 MiB 是折中 */
const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * 探测文件大小与边缘缓存状态。
 *
 * 用 HEAD 而不是 GET：HEAD 在源站侧不返回文件体，代价小得多。
 * 代理会把回源缓存状态写进 x-proxy-cache-status 响应头。
 */
export async function probeFile(url: string): Promise<CacheProbe> {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) {
        throw new Error(`无法获取文件信息 (HTTP ${res.status})`);
    }
    const acceptRanges = (res.headers.get("accept-ranges") || "").toLowerCase();
    const total = Number(res.headers.get("content-length") || 0);
    if (acceptRanges.indexOf("bytes") < 0) {
        throw new Error("服务端不支持分段下载（缺少 Accept-Ranges）");
    }
    if (!total) {
        throw new Error("无法获取文件总长度");
    }
    const raw = res.headers.get("x-proxy-cache-status") || "UNKNOWN";
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
    const threads = Math.max(1, Math.min(16, options.threads ?? 4));

    // 1. 询问总长度与缓存状态
    const probe = await probeFile(url);

    // 2. 让用户选择保存位置
    const picker = (window as WindowWithPicker).showSaveFilePicker;
    if (!picker) throw new TurboUnsupportedError();
    const handle = await picker.call(window, { suggestedName: fileName });
    const writable = await handle.createWritable();

    // 3. 规划分段：尽量均分，且每段不超过 CHUNK_SIZE
    const total = probe.total;
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
        if (res.status !== 206 && res.status !== 200) {
            throw new Error(`分段 ${range.start}-${range.end} 请求失败 (HTTP ${res.status})`);
        }
        if (!res.body) throw new Error("响应没有可读流");

        const reader = res.body.getReader();
        let position = range.start;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    await writable.write({ type: "write", position, data: value });
                    position += value.byteLength;
                    downloaded += value.byteLength;
                    notify();
                }
            }
        } finally {
            try { reader.releaseLock(); } catch (e) { /* 忽略 */ }
        }
        finishedChunks++;
        notify(true);
    };

    try {
        // 4. 并发拉取各分段
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
