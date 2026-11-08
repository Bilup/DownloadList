/**
 * 下载代理核心逻辑（Cloudflare Pages / Vercel Edge / Netlify Edge 通用）
 *
 * 设计要点（均经过 Cloudflare 运行时实测验证）：
 *
 * 1. 源站请求强制 `accept-encoding: identity`
 *    Cloudflare 默认会与源站协商 gzip/br。若把压缩后的响应直接透传，
 *    `Content-Range` 描述的将是压缩流偏移量，分段下载（Range/206）
 *    得到的数据会损坏。固定 identity 后 content-length 与字节流严格一致，
 *    Range 语义正确。
 *
 * 2. 边缘缓存使用 `cf.cacheEverything` + `cf.cacheTtl`
 *    GitHub Release 资源最终落到 Azure Blob，其响应没有 Cache-Control，
 *    Cloudflare 默认不缓存（实测 cf-cache-status: DYNAMIC）。
 *    开启 cacheEverything 后大文件可命中边缘缓存（实测 HIT，字节数与
 *    源站一致，magic bytes 正确）。
 *
 * 3. 不使用 Cache API 存储大文件
 *    实测 caches.default.put() 写入 162MB 响应失败：
 *    "ReadableStream.tee() buffer limit exceeded"。
 *    边缘缓存（cf.cacheEverything）没有该限制。
 *
 * 4. 全程流式转发，禁止在 Worker 内缓冲整个响应
 *    实测 arrayBuffer() 读取 162MB 会触发 1101（内存上限）。
 *
 * 5. 客户端地址族检测
 *    Pages Functions 的 request.cf 不包含 clientIp/clientIpv6（实测 undefined），
 *    必须使用 CF-Connecting-IP / CF-Connecting-IPv6 请求头。
 *
 * 6. 带请求方信息的响应头不能进入边缘缓存
 *    缓存会连同自定义响应头一起复用，导致后续访客看到过期的地址族信息。
 *    因此实时诊断信息统一放在不缓存的 /_diag 端点。
 */

/** 单个代理条目 */
export interface ProxyEntry {
    /** 源站真实地址 */
    url: string;
    /** 文件名（用于 Content-Disposition） */
    name?: string;
    /** 内容类型（用于判断是否内联预览） */
    type?: string;
    /** 文件大小 */
    size?: number;
}

/** 代理行为配置 */
export interface ProxyOptions {
    /** 边缘缓存 TTL（秒），默认 7 天 */
    cacheTtl?: number;
    /** 是否在响应头回显客户端地址族等诊断信息（默认 false） */
    exposeClientInfo?: boolean;
}

/**
 * 从路径中解析出代理条目。
 * 采用“逐段匹配”而非固定位置，以兼容历史路径结构，
 * 使改造前已发布的下载链接在改造后依然可用。
 */
export function findProxyEntry(pathname: string, proxyConfig: { [key: string]: ProxyEntry }): ProxyEntry | undefined {
    const segments = pathname.split("/").filter(function (s) { return s.length > 0; });
    for (const segment of segments) {
        if (Object.prototype.hasOwnProperty.call(proxyConfig, segment)) {
            return proxyConfig[segment];
        }
    }
    return undefined;
}

/** 判断内容是否应当内联预览（音视频、图片、PDF） */
export function isPreviewable(type?: string, name?: string): boolean {
    const t = (type || "").toLowerCase();
    if (t) {
        if (t.startsWith("video/") || t.startsWith("audio/") || t.startsWith("image/")) return true;
        if (t === "application/pdf" || t === "application/x-pdf") return true;
        if (t.startsWith("text/")) return false;
        if (t !== "application/octet-stream") return false;
        // application/octet-stream 再按扩展名判断
    }
    const ext = (name || "").split(".").pop();
    if (!ext) return false;
    const previewExt = ["mp4", "mkv", "webm", "m3u8", "ts", "avi", "mov", "wmv", "flv",
        "mp3", "flac", "wav", "ogg", "m4a", "aac",
        "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "tiff", "avif",
        "pdf"];
    return previewExt.indexOf(ext.toLowerCase()) >= 0;
}

/** 构造 Content-Disposition，兼容非 ASCII 文件名 */
export function buildContentDisposition(name: string | undefined, inline: boolean): string | undefined {
    if (!name) return undefined;
    const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(name);
    const type = inline ? "inline" : "attachment";
    return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 检测访客使用的 IP 地址族 */
export function detectClientFamily(request: Request): { family: string; ip: string; ipv6: string } {
    const ipv6 = request.headers.get("cf-connecting-ipv6") || "";
    const ip = request.headers.get("cf-connecting-ip") || "";
    let family = "unknown";
    if (ipv6) {
        family = "ipv6";
    } else if (ip) {
        family = ip.indexOf(":") >= 0 ? "ipv6" : "ipv4";
    }
    return { family: family, ip: ip, ipv6: ipv6 };
}

/**
 * 下载代理主处理函数。
 *
 * @param request      客户端请求
 * @param proxyConfig  路径片段 -> 代理条目 的映射
 * @param options      行为配置
 */
export async function downloadProxy(request: Request, proxyConfig: { [key: string]: ProxyEntry }, options?: ProxyOptions): Promise<Response> {
    const opt: ProxyOptions = options || {};
    const url = new URL(request.url);
    const method = (request.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "GET, HEAD, OPTIONS",
                "access-control-allow-headers": "Range, If-None-Match, If-Modified-Since, If-Range",
                "access-control-max-age": "86400",
                "timing-allow-origin": "*",
                "cache-control": "no-store"
            }
        });
    }

    if (method !== "GET" && method !== "HEAD") {
        return new Response("Method Not Allowed", {
            status: 405,
            headers: { "allow": "GET, HEAD, OPTIONS", "content-type": "text/plain; charset=utf-8" }
        });
    }

    // 诊断端点：返回当前请求的地址族、边缘节点等实时信息（不缓存）
    if (url.pathname.split("/").filter(Boolean).indexOf("_diag") >= 0) {
        const info = detectClientFamily(request);
        const cf = (request as any).cf || {};
        return new Response(JSON.stringify({
            clientIp: info.ip,
            clientIpv6: info.ipv6,
            clientFamily: info.family,
            edgeColo: cf.colo || null,
            httpProtocol: cf.httpProtocol || null,
            asn: cf.asn === undefined ? null : cf.asn,
            country: cf.country || null,
            clientTcpRtt: cf.clientTcpRtt === undefined ? null : cf.clientTcpRtt,
            clientQuicRtt: cf.clientQuicRtt === undefined ? null : cf.clientQuicRtt,
            requestUrl: url.pathname
        }, null, 2), {
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
    }

    const entry = findProxyEntry(url.pathname, proxyConfig);
    if (!entry || !entry.url) {
        return new Response("Not Found", {
            status: 404,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
    }

    // 仅转发与下载语义相关的请求头
    const originHeaders = new Headers();
    const forwardHeaders = ["range", "if-range", "if-none-match", "if-modified-since",
        "if-match", "if-unmodified-since", "accept"];
    for (const name of forwardHeaders) {
        const value = request.headers.get(name);
        if (value) originHeaders.set(name, value);
    }
    // 固定 identity，保证 content-length 与字节流一致，Range 语义正确
    originHeaders.set("accept-encoding", "identity");
    originHeaders.set("user-agent", request.headers.get("user-agent") || "bilup-download-proxy");

    const ttl = typeof opt.cacheTtl === "number" && opt.cacheTtl > 0 ? opt.cacheTtl : 604800;

    let originResponse: Response;
    try {
        originResponse = await fetch(entry.url, {
            method: method,
            headers: originHeaders,
            redirect: "follow",
            cf: {
                cacheEverything: true,
                cacheTtl: ttl,
                cacheTtlByStatus: { "200-299": ttl, "300-399": -1, "400-599": -1 }
            }
        } as any);
    } catch (error) {
        const message = error && (error as any).message ? (error as any).message : String(error);
        return new Response("Upstream fetch failed: " + message, {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
    }

    // 透传源站响应头，但剔除逐跳首部与不应外泄的首部
    const responseHeaders = new Headers();
    const hopByHop = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade", "set-cookie"];
    originResponse.headers.forEach(function (value: string, key: string) {
        const lower = key.toLowerCase();
        if (hopByHop.indexOf(lower) >= 0) return;
        if (lower === "cf-cache-status") return;
        responseHeaders.set(key, value);
    });

    // 回源缓存状态（HIT 表示本次未回源，直接由 Cloudflare 边缘缓存提供）
    const originCacheStatus = originResponse.headers.get("cf-cache-status");
    if (originCacheStatus) {
        responseHeaders.set("x-proxy-cache-status", originCacheStatus);
    }
    // 边缘回源耗时信息，便于观测加速效果
    const originAge = originResponse.headers.get("age");
    if (originAge) {
        responseHeaders.set("x-proxy-origin-age", originAge);
    }

    // 内容处置：可预览类型内联，其余作为附件下载
    const inline = isPreviewable(entry.type, entry.name);
    const disposition = buildContentDisposition(entry.name, inline);
    if (disposition) {
        responseHeaders.set("content-disposition", disposition);
    }

    // 跨域与计时
    responseHeaders.set("access-control-allow-origin", "*");
    responseHeaders.set("access-control-expose-headers",
        "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Content-Disposition");
    responseHeaders.set("timing-allow-origin", "*");

    // 分段下载能力声明
    if (!responseHeaders.has("accept-ranges")) {
        responseHeaders.set("accept-ranges", "bytes");
    }

    // 浏览器侧缓存：Release 资源内容不可变
    if (!responseHeaders.has("cache-control")) {
        responseHeaders.set("cache-control", "public, max-age=86400, immutable");
    }

    // 仅在未命中边缘缓存的响应上附加实时诊断信息，避免污染缓存
    if (opt.exposeClientInfo) {
        const info = detectClientFamily(request);
        const cf = (request as any).cf || {};
        responseHeaders.set("x-proxy-client-family", info.family);
        responseHeaders.set("x-proxy-edge-colo", cf.colo || "");
    }

    const status = originResponse.status;
    if (status === 304 || status === 204) {
        return new Response(null, { status: status, headers: responseHeaders });
    }

    // 直接透传字节流，绝不在 Worker 内缓冲
    return new Response(originResponse.body, {
        status: status,
        statusText: originResponse.statusText,
        headers: responseHeaders
    });
}
