/**
 * 下载速递 —— 浏览器内多线程分段下载。
 *
 * 服务端（Pages 的下载代理）已经完整支持 Range：
 * Accept-Ranges、206 Partial Content、多区间 multipart、416、304 都已验证。
 * 这里在客户端把一个文件拆成 N 段并发拉取，再用 File System Access API
 * 按偏移量写入同一个文件，从而在不安装任何客户端的前提下获得多线程加速。
 *
 * 浏览器支持情况：
 *   - Chromium 系（Chrome / Edge / Opera / Brave）：完整支持，可流式写盘
 *   - Firefox / Safari：无 File System Access API，降级为「复制 aria2 命令」
 */

/** File System Access API 的最小类型声明（标准 lib 里没有） */
interface FileSystemWritableFileStream extends WritableStream {
    write(data: BufferSource | Blob | string | {
        type: "write";
        position: number;
        data: BufferSource | Blob | string;
    }): Promise<void>;
    close(): Promise<void>;
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
        super("当前浏览器不支持流式写盘（需要 Chrome / Edge），已降级为复制下载命令");
        this.name = "TurboUnsupportedError";
    }
}

export interface TurboProgress {
    /** 已下载字节 */
    done: number;
    /** 总字节 */
    total: number;
    /** 当前速度（字节/秒） */
    speed: number;
    /** 已完成分段数 / 总分段数 */
    finishedChunks: number;
    totalChunks: number;
}

export interface TurboOptions {
    /** 并发线程数 */
    threads?: number;
    /** 进度回调（已做节流，约每 200ms 一次） */
    onProgress?: (progress: TurboProgress) => void;
    /** 完成回调 */
    onDone?: (elapsedMs: number) => void;
    /** 出错回调 */
    onError?: (error: Error) => void;
}

/** 单个分段的大小上限，避免一次性请求过大 */
const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * 多线程分段下载。
 *
 * @param url       文件下载地址
 * @param fileName  建议的文件名
 * @param options   配置
 */
export async function turboDownload(url: string, fileName: string, options: TurboOptions = {}): Promise<void> {
    const threads = Math.max(1, Math.min(16, options.threads ?? 8));

    // 1. 询问总长度
    const headRes = await fetch(url, { method: "HEAD" });
    if (!headRes.ok) {
        throw new Error(`无法获取文件信息 (HTTP ${headRes.status})`);
    }
    const acceptRanges = (headRes.headers.get("accept-ranges") || "").toLowerCase();
    const total = Number(headRes.headers.get("content-length") || 0);
    if (acceptRanges.indexOf("bytes") < 0) {
        throw new Error("服务端不支持分段下载（缺少 Accept-Ranges）");
    }
    if (!total) {
        throw new Error("无法获取文件总长度");
    }

    // 2. 让用户选择保存位置
    const picker = (window as WindowWithPicker).showSaveFilePicker;
    if (!picker) throw new TurboUnsupportedError();
    const handle = await picker.call(window, { suggestedName: fileName });
    const writable = await handle.createWritable();

    // 3. 规划分段
    const chunkSize = Math.max(CHUNK_SIZE, Math.ceil(total / threads));
    const ranges: Array<{ start: number; end: number }> = [];
    for (let start = 0; start < total; start += chunkSize) {
        ranges.push({ start, end: Math.min(start + chunkSize - 1, total - 1) });
    }

    const startedAt = performance.now();
    let downloaded = 0;
    let finishedChunks = 0;
    let lastNotify = 0;
    let failed: Error | undefined;

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
        failed = error instanceof Error ? error : new Error(String(error));
        try { await writable.abort(); } catch (e) { /* 忽略 */ }
        options.onError?.(failed);
        throw failed;
    }
}

/**
 * 生成 aria2 命令行（Motrix 等客户端可直接粘贴执行）。
 *
 * aria2c 原生支持多线程分段 + 断点续传，比浏览器内方案更稳，
 * 因此在不支持 File System Access API 的浏览器上作为降级方案提供。
 */
export function buildAria2Command(url: string, fileName: string, threads = 16): string {
    const name = fileName.replace(/"/g, "");
    return `aria2c -x${threads} -s${threads} -k1M --file-allocation=none -c --console-log-level=warn -d . -o "${name}" "${url}"`;
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
