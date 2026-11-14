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
/**
 * 2. 边缘缓存使用 `cf.cacheEverything` + `cf.cacheTtl`
 *    GitHub Release 资源最终落到 Azure Blob，其响应没有 Cache-Control，
 *    Cloudflare 默认不缓存（实测 cf-cache-status: DYNAMIC）。
 *    开启 cacheEverything 后大文件可命中边缘缓存（实测 HIT，字节数与
 *    源站一致，magic bytes 正确）。
 *
 * 2.1 回源主路径必须是「路径稳定」的 URL
 *    实测结论（对比实验，四种策略同一文件对照）：
 *      - 原始 URL（github.com/.../releases/download/...）
 *        首次 MISS 后持续 HIT，命中率 15/15
 *      - asset API 的 302 目标（release-assets.githubusercontent.com）
 *        Location 带时效签名（se/sig 参数），每次都不同，
 *        缓存键随之抖动，命中率仅约 6 成
 *    因此主路径用原始 URL，asset API 签名地址降为兜底。
 *
 * 2.2 cf.cacheKey 对跨到 GitHub 的子请求无效
 *    文档称 cacheKey 可固定缓存键，但实测对 github.com 的子请求
 *    仍然按最终 URL（含签名）计算缓存键，设置后依旧 MISS。
 *    该选项保留但不依赖它。
 *
 * 2.3 模块级缓存（isolate 内存）
 *    - assetId -> 签名 URL：签名有效期约 5 分钟，缓存 4 分钟，
 *      可把 GitHub API 调用量降低一到两个数量级。
 *    - KV 代理表 / 令牌：KV 读取本身有 30 秒最小边缘缓存，
 *      再叠加模块级缓存后，稳态下每请求的 KV 读次数可降到 0。
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
    /**
     * GitHub Release 资源的 asset id。
     *
     * GitHub 会阻断 Cloudflare 出口 IP 直接访问
     * `/releases/download/**`（实测返回 504），但 asset API
     * （api.github.com/repos/{owner}/{repo}/releases/assets/{id}）
     * 会 302 到 release-assets.githubusercontent.com，该域名不受此限制。
     * 因此回源优先走 asset API，失败再回退到原始 URL。
     */
    assetId?: number;
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

/** KV 中存放代理条目的 key（所有条目合并为一份 JSON，避免逐条写入） */
export const KV_TABLE_KEY = "proxy-table";

/**
 * 代理表分片数量。
 *
 * KV 单个值上限 25 MiB（实测 25 MiB 可写、26 MiB 返回 HTTP 413），
 * 而整张表放在一个键里迟早会撞上限 —— 一旦撞上，KV 拒绝写入，
 * 同步作业失败，新版本就发布不出去。
 *
 * 分片依据：代理键本身就是 sha1(源URL) 的前 16 位十六进制，
 * 取其**首位字符**作为分片号，天然均匀、无需额外索引。
 * 因此查表时可以直接由请求里的 key 定位到分片，不必读整表。
 *
 * 16 片的容量：每片上限 25 MiB → 原始数据合计 400 MiB，
 * 按每版本约 10 KiB 计，约可支撑 39000 个 release。
 *
 * 分片键命名：proxy-table.shard.<0-f>
 *
 * 注意：键名里不能出现 `#`、`?`、`/` —— `#` 在 URL 中是 fragment 分隔符，
 * 会被解析层丢弃，导致请求落到错误的键上。这里统一用 `.` 作分隔符。
 */
export const KV_SHARD_COUNT = 16;

/** 分片键前缀 */
export const KV_SHARD_PREFIX = KV_TABLE_KEY + ".shard.";

/** 分片清单键，记录各分片的当前内容哈希，用于跳过未变化的写入 */
export const KV_MANIFEST_KEY = KV_TABLE_KEY + ".manifest";

/**
 * 从代理键推导分片号。
 *
 * 代理键有两种形态：
 *   - sha1 前 16 位十六进制（新键），如 "760ae7081ada9d46"
 *   - 历史 hashCode 的十进制字符串（旧别名键），如 "24542234"
 * 两种形态的首字符都落在 0-9a-f 范围内，可直接作为分片号。
 */
export function shardIdOf(key: string): string {
    if (!key) return "0";
    const first = key.charAt(0).toLowerCase();
    return /^[0-9a-f]$/.test(first) ? first : "0";
}

/** KV 存储接口（只声明用到的部分，便于在无 KV 绑定的环境复用同一份核心逻辑） */
export interface KVStore {
    /**
     * 读取 KV 值。
     *
     * type 为 "text" 时返回字符串；传入 options 时返回该类型下的解析结果。
     */
    get(key: string, type?: string): Promise<unknown>;
    get(key: string, options: { type?: string; cacheTtl?: number }): Promise<unknown>;
}

/**
 * 从 KV 中加载代理表。
 *
 * 这是可选能力：未绑定 KV 时（当前 Pages 部署即为此情形）直接使用构建期内联的静态表，
 * 行为与改造前完全一致。绑定 KV 后，代理表以 KV 中的数据为最新，
 * 新增 release 时只需更新 KV，无需重新部署（重新部署会使边缘缓存全部失效）。
 * KV 不可用或数据损坏时回退到静态表，保证服务不中断。
 */
export async function loadProxyConfigFromKV(
    kv: KVStore | undefined,
    fallback: { [key: string]: ProxyEntry }
): Promise<{ [key: string]: ProxyEntry }> {
    if (!kv) return fallback;

    // 模块级缓存命中则直接返回，避免每次下载都打 KV。
    // 缓存丢失只会导致多读一次 KV，不影响正确性。
    const cached = readModuleCache(proxyTableCache);
    if (cached) return cached;

    try {
        // cacheTtl 设为 30 秒（KV 允许的最小值），让代理表的更新
        // 尽快在各地边缘节点生效。KV 本身是最终一致的，
        // 默认 60 秒会让新版本的下载链接在部分节点短暂 404。
        const raw = await kv.get(KV_TABLE_KEY, { type: "text", cacheTtl: 30 });
        if (typeof raw !== "string" || raw.length === 0) return fallback;
        // 记录原始体积，供诊断端点观测 KV 单值用量
        // （单值上限 25 MiB，实测超过会被 API 以 HTTP 413 拒绝）
        proxyTableBytes = raw.length;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return fallback;
        // 合并：KV 为最新数据，内联表作为兜底（KV 中缺失的条目仍可解析）
        const merged: { [key: string]: ProxyEntry } = {};
        Object.keys(fallback).forEach(function (k) { merged[k] = fallback[k]; });
        Object.keys(parsed).forEach(function (k) {
            const entry = parsed[k];
            if (entry && typeof entry.url === "string" && entry.url.length > 0) {
                merged[k] = entry as ProxyEntry;
            }
        });
        proxyTableCache = { value: merged, expiresAt: Date.now() + PROXY_TABLE_TTL_MS };
        return merged;
    } catch (error) {
        return fallback;
    }
}

/**
 * 从路径中提取候选代理键。
 *
 * 代理键有两种形态：sha1 前 16 位十六进制（新键）与历史 hashCode
 * 的十进制字符串（旧别名键）。这里只挑出形似代理键的路径段，
 * 避免对 "down" 这类固定字面量做无谓的分片查询。
 */
export function extractCandidateKeys(pathname: string): string[] {
    const segments = pathname.split("/").filter(function (s) { return s.length > 0; });
    const out: string[] = [];
    for (const segment of segments) {
        if (/^[0-9a-f]{16}$/i.test(segment) || /^[0-9]{1,12}$/.test(segment)) {
            out.push(segment);
        }
    }
    return out;
}

/**
 * 按分片从 KV 查一条代理条目。
 *
 * 查找顺序：
 *   1. 分片键 proxy-table#<片号> —— 正常路径，只读约 1/16 的数据
 *   2. 旧的整表键 proxy-table —— 迁移期兜底，也覆盖历史链接
 *   3. 构建期内联的静态表 —— KV 不可用时的最后兜底
 *
 * 分片缺失（返回空）会被负缓存 60 秒，避免对不存在的分片反复回源。
 */
export async function findEntryFromKV(
    kv: KVStore | undefined,
    pathname: string,
    fallback: { [key: string]: ProxyEntry }
): Promise<ProxyEntry | undefined> {
    const candidates = extractCandidateKeys(pathname);
    if (candidates.length === 0) {
        // 路径里没有形似代理键的段，退回整表匹配（兼容非常规历史路径）
        const table = await loadProxyConfigFromKV(kv, fallback);
        return findProxyEntry(pathname, table);
    }

    for (const key of candidates) {
        const entry = await lookupByShard(kv, key, fallback);
        if (entry) return entry;
    }
    return undefined;
}

/**
 * 在单个分片内查找指定键，必要时回退整表与内联表。
 */
async function lookupByShard(
    kv: KVStore | undefined,
    key: string,
    fallback: { [key: string]: ProxyEntry }
): Promise<ProxyEntry | undefined> {
    if (!kv) return fallback[key];

    const shardId = shardIdOf(key);
    const shardKey = KV_SHARD_PREFIX + shardId;

    try {
        let shard = readModuleCache(shardCache.get(shardKey));
        if (!shard) {
            const raw = await kv.get(shardKey, { type: "text", cacheTtl: 30 });
            const parsed = (typeof raw === "string" && raw.length > 0)
                ? JSON.parse(raw)
                : {};
            shard = {
                value: (parsed && typeof parsed === "object") ? parsed as { [key: string]: ProxyEntry } : {},
                expiresAt: Date.now() + PROXY_TABLE_TTL_MS
            };
            shardCache.set(shardKey, shard);
        }
        const hit = shard.value[key];
        if (hit && typeof hit.url === "string" && hit.url.length > 0) {
            return hit;
        }
    } catch (error) {
        // 分片读取失败不致命，继续走整表与内联兜底
    }

    // 迁移期兜底：整表键（内容可能已过时，但能覆盖分片未覆盖到的条目）
    const legacy = await loadProxyConfigFromKV(kv, fallback);
    const hit = legacy[key];
    if (hit && typeof hit.url === "string" && hit.url.length > 0) return hit;

    return fallback[key];
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

/**
 * 构造 Content-Disposition，兼容非 ASCII 文件名
 */
export function buildContentDisposition(name: string | undefined, inline: boolean): string | undefined {
    if (!name) return undefined;
    const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(name);
    const type = inline ? "inline" : "attachment";
    return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * 从 GitHub 的 browser_download_url 反推出 asset API 地址。
 *
 * https://github.com/{owner}/{repo}/releases/download/{tag}/{file}
 *   -> https://api.github.com/repos/{owner}/{repo}/releases/assets/{id}
 *
 * asset id 无法从 URL 推导，必须在构建期从 API 取得并随条目一起保存；
 * 此处仅在能拿到 assetId 时使用。
 */
export function buildAssetApiUrl(sourceUrl: string, assetId: number): string | undefined {
    const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\//.exec(sourceUrl);
    if (!match) return undefined;
    return `https://api.github.com/repos/${match[1]}/${match[2]}/releases/assets/${assetId}`;
}

/** KV 中存放 GitHub 令牌的 key */
export const KV_TOKEN_KEY = "github-token";

/**
 * 模块级（isolate 内存）缓存。
 *
 * Workers 的 isolate 会在内存不足时被回收重建，因此这里的所有条目
 * 都必须能「丢失后重新获取」，不能成为正确性的前提。
 *
 * 作用是把高频重复的外部调用挡在isolate 之外：
 * - 签名 URL：避免每次下载都打一次 GitHub asset API（限额 5000 次/小时）
 * - KV 代理表与令牌：避免每次下载都读 KV（Free 计划 10 万读/天）
 */
interface ModuleCacheEntry<T> {
    value: T;
    expiresAt: number;
}

/** 签名 URL 的缓存时长：GitHub 签名约 5 分钟有效，取 4 分钟留出余量 */
const SIGNED_URL_TTL_MS = 4 * 60 * 1000;

/** KV 代理表的模块级缓存时长：与 KV 自身 30 秒边缘缓存叠加，取 60 秒 */
const PROXY_TABLE_TTL_MS = 60 * 1000;

/** GitHub 令牌的模块级缓存时长：令牌有效期以小时计，取 5 分钟 */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** assetId -> 签名后的实际下载地址 */
const signedUrlCache = new Map<string, ModuleCacheEntry<string>>();

/** KV 代理表的模块级缓存 */
let proxyTableCache: ModuleCacheEntry<{ [key: string]: ProxyEntry }> | undefined;

/**
 * 分片代理表的模块级缓存。
 *
 * 按需加载：只缓存实际被访问过的分片。
 * 分片键形如 proxy-table#<0-f>，每个分片约 1/16 的表数据。
 */
const shardCache = new Map<string, ModuleCacheEntry<{ [key: string]: ProxyEntry }>>();

/**
 * 最近一次从 KV 读到的代理表原始字节数。
 *
 * KV 单值上限 25 MiB（实测 25 MiB 可写、26 MiB 被 HTTP 413 拒绝），
 * 这个数字用于诊断端点展示当前占用比例，便于提前发现逼近上限的情况。
 */
let proxyTableBytes = 0;

/** GitHub 令牌的模块级缓存 */
let tokenCache: ModuleCacheEntry<string> | undefined;

/**
 * 解析 GitHub asset API 重定向目标中的签名过期时间。
 *
 * release-assets.githubusercontent.com 的 Location 形如：
 * https://release-assets.githubusercontent.com/...?se=2026-11-08T12%3A00%3A00Z&sig=...
 * 其中 se 即签名过期时间（URL 编码后的 ISO 8601）。
 *
 * 解析失败时返回 0，表示「无法判断过期时间」，由调用方按 TTL 保守处理。
 */
export function parseSignedExpiry(location: string): number {
    const match = /[?&]se=([^&]+)/.exec(location);
    if (!match) return 0;
    try {
        const decoded = decodeURIComponent(match[1]);
        const parsed = Date.parse(decoded);
        return Number.isFinite(parsed) ? parsed : 0;
    } catch (error) {
        return 0;
    }
}

/**
 * 读取模块级缓存，命中且未过期则返回。
 */
function readModuleCache<T>(entry: ModuleCacheEntry<T> | undefined): T | undefined {
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) return undefined;
    return entry.value;
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
 * @param proxyConfig  路径片段 -> 代理条目 的映射（构建期内联的静态表）
 * @param options      行为配置
 * @param kv           可选的 KV 存储。不传时使用 proxyConfig；
 *                     传入时以 KV 中的代理表为最新，KV 不可用则回退到 proxyConfig
 */
export async function downloadProxy(request: Request, proxyConfig: { [key: string]: ProxyEntry }, options?: ProxyOptions, kv?: KVStore): Promise<Response> {
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
    // 注意：_routes.json 只把 /down/** 交给 Worker，因此诊断路径必须落在 /down/ 之下，
    // 否则会被静态资源路由接管，永远到不了这里。
    if (url.pathname.split("/").filter(Boolean).indexOf("_diag") >= 0
        && url.pathname.indexOf("/down/") === 0) {
        // 主动读一次 KV，让体积数据在首次访问时就是真实的。
        // 诊断端点是人工访问、频率极低，且 KV 自带 30 秒边缘缓存，代价可忽略。
        try {
            await loadProxyConfigFromKV(kv, proxyConfig);
        } catch (error) {
            // 读取失败不影响诊断端点本身
        }
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
            requestUrl: url.pathname,
            moduleCache: {
                signedUrlCount: signedUrlCache.size,
                proxyTableCached: readModuleCache(proxyTableCache) !== undefined,
                tokenCached: readModuleCache(tokenCache) !== undefined,
                shardCacheCount: shardCache.size
            },
            kvUsage: {
                // 分片模式下，单个分片的上限仍是 25 MiB；
                // 整表容量 = 分片数 × 单片上限
                shardCount: KV_SHARD_COUNT,
                tableBytes: proxyTableBytes,
                tableLimitBytes: 25 * 1024 * 1024,
                tableUsagePercent: proxyTableBytes > 0
                    ? Number(((proxyTableBytes / (25 * 1024 * 1024)) * 100).toFixed(3))
                    : 0,
                // 整表理论容量（原始字节）
                totalCapacityBytes: KV_SHARD_COUNT * 25 * 1024 * 1024
            }
        }, null, 2), {
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
    }

    // 代理表优先取自 KV（可动态更新），不可用时回退到构建期内联的静态表。
    // 采用分片查找：按请求中的 key 定位分片，只读约 1/16 的表数据，
    // 既避免整表超出 KV 单值上限，也让每次下载的 KV 读取量大幅下降。
    const entry = await findEntryFromKV(kv, url.pathname, proxyConfig);
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

    /**
     * 回源时的边缘缓存选项。
     *
     * cacheEverything：源站（Azure Blob）不带 Cache-Control，默认不缓存，
     * 必须显式开启，否则永远 DYNAMIC。
     *
     * cacheKey：把子请求的缓存键固定为「稳定的源站 URL」。
     * 这是本次改造的核心 —— asset API 的 302 目标带时效签名，
     * 每次都不同，不固定缓存键就永远 MISS。
     *
     * 注意：cacheKey 替换的是「路径与查询串」部分，
     * 因此传入的是源站 URL 的 path+query，而非完整 URL，
     * 避免把 https:// 前缀也计入键中。
     *
     * bypass 为真时不写入边缘缓存（用于 ?fresh=1 强制回源）。
     */
    function buildCacheOptions(stableKey: string, bypass?: boolean): any {
        if (bypass) {
            // cacheTtlByStatus 全 -1 = 任何状态都不缓存，
            // 保证强制回源拿到的永远是源站最新内容。
            return {
                cacheEverything: true,
                cacheTtl: -1,
                cacheTtlByStatus: { "200-299": -1, "300-399": -1, "400-599": -1 },
                cacheKey: stableKey
            };
        }
        return {
            cacheEverything: true,
            cacheTtl: ttl,
            cacheTtlByStatus: { "200-299": ttl, "300-399": -1, "400-599": -1 },
            cacheKey: stableKey
        };
    }

    /**
     * 从源站 URL 中提取稳定的缓存键成分（path + query，去掉 origin）。
     */
    function toStableCacheKey(sourceUrl: string): string {
        try {
            const parsed = new URL(sourceUrl);
            return parsed.pathname + parsed.search;
        } catch (error) {
            return sourceUrl;
        }
    }

    /**
     * 依次尝试若干个源地址，返回第一个可用响应。
     *
     * 5xx/504 多为源站侧对当前出口 IP 的拒绝，404 则可能是该条路径
     * 已被源站调整（如 release 重新发布后路径失效），
     * 两种情况都应继续尝试下一个候选。
     *
     * @param onUse 选中某个候选时的回调，用于记录实际走的是哪条路径
     * @param bypassCache 为真时不写入边缘缓存（强制回源）
     */
    async function fetchOrigin(
        candidates: Array<{ url: string; headers: Headers; cacheKey?: string }>,
        onUse?: (candidate: { url: string; headers: Headers; cacheKey?: string }) => void,
        bypassCache?: boolean
    ): Promise<Response | undefined> {
        for (const candidate of candidates) {
            try {
                const response = await fetch(candidate.url, {
                    method: method,
                    headers: candidate.headers,
                    redirect: "follow",
                    cf: buildCacheOptions(candidate.cacheKey || candidate.url, bypassCache)
                } as any);
                if (response.status === 504 || response.status === 502 || response.status === 404) {
                    try { await response.body?.cancel(); } catch (e) { /* 忽略 */ }
                    continue;
                }
                if (onUse) onUse(candidate);
                return response;
            } catch (error) {
                continue;
            }
        }
        return undefined;
    }

    /**
     * 读取 GitHub 令牌（模块级缓存优先）。
     */
    async function getToken(): Promise<string | null> {
        const cached = readModuleCache(tokenCache);
        if (cached) return cached;
        if (!kv) return null;
        try {
            const raw = await kv.get(KV_TOKEN_KEY, { type: "text", cacheTtl: 30 });
            if (typeof raw === "string" && raw.length > 0) {
                tokenCache = { value: raw, expiresAt: Date.now() + TOKEN_TTL_MS };
                return raw;
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 通过 asset API 换取真实的签名下载地址。
     *
     * 这里手动处理重定向（redirect: "manual"），目的有二：
     * 1. 拿到 Location 里的签名与过期时间，便于缓存与过期重试；
     * 2. 后续对签名 URL 的请求可以带上稳定的 cacheKey，让边缘缓存命中。
     *
     * @returns 签名地址；无法获取时返回 undefined
     */
    async function resolveSignedUrl(assetId: number, sourceUrl: string, headers: Headers): Promise<string | undefined> {
        const cacheKey = String(assetId);
        const cached = readModuleCache(signedUrlCache.get(cacheKey));
        if (cached) return cached;

        const assetUrl = buildAssetApiUrl(sourceUrl, assetId);
        if (!assetUrl) return undefined;
        const token = await getToken();
        if (!token) return undefined;

        const assetHeaders = new Headers();
        assetHeaders.set("accept", "application/octet-stream");
        assetHeaders.set("authorization", "Bearer " + token);
        assetHeaders.set("x-github-api-version", "2022-11-28");
        assetHeaders.set("user-agent", headers.get("user-agent") || "bilup-download-proxy");
        assetHeaders.set("accept-encoding", "identity");
        // Range 交给后续对签名 URL 的请求处理，这里不带 Range，
        // 避免把分段请求的语义带到重定向解析阶段。
        assetHeaders.set("cache-control", "no-store");

        try {
            const response = await fetch(assetUrl, {
                method: "GET",
                headers: assetHeaders,
                redirect: "manual"
            } as any);
            const location = response.headers.get("location");
            if (!location) return undefined;

            // 按签名中的过期时间决定缓存时长；解析不出则用保守的默认 TTL
            const expiry = parseSignedExpiry(location);
            const ttlMs = expiry > 0
                ? Math.max(0, Math.min(expiry - Date.now() - 30 * 1000, SIGNED_URL_TTL_MS))
                : SIGNED_URL_TTL_MS;
            // 剩余有效期过短时不缓存，避免缓存一个马上要失效的地址
            if (ttlMs > 0) {
                signedUrlCache.set(cacheKey, { value: location, expiresAt: Date.now() + ttlMs });
            }
            return location;
        } catch (error) {
            return undefined;
        }
    }

    // 组装候选源地址：原始 URL 优先，签名后的 asset 地址兜底
    //
    // 顺序很重要（实测结论）：
    // - 原始 URL（github.com/.../releases/download/...）的路径稳定，
    //   边缘缓存键稳定，实测首次 MISS 后持续 HIT。
    // - asset API 的 302 目标带时效签名（se/sig），每次都不同，
    //   即使显式指定 cf.cacheKey 也会被 Cloudflare 忽略（跨到 GitHub 的
    //   子请求按最终 URL 计算缓存键），实测命中率仅约 6 成。
    // 因此以原始 URL 为主路径，签名地址仅在原始 URL 不可用时兜底。
    //
    // 例外：客户端带 ?fresh=1 时强制回源。
    // 场景是「同一 tag 下替换了同名文件」——原始 URL 没变，边缘缓存里
    // 仍存着旧内容（默认 TTL 7 天），只有走签名地址才能拿到最新文件。
    // 签名地址每次都不同，缓存键必然不同，因此必然真回源。
    const wantFresh = url.searchParams.has("fresh") || url.searchParams.has("nocache");
    const stableCacheKey = toStableCacheKey(entry.url);
    const candidates: Array<{ url: string; headers: Headers; cacheKey?: string }> = [];

    if (wantFresh && entry.assetId) {
        // 强制回源模式：丢弃模块级签名缓存，重新换取一个新签名
        signedUrlCache.delete(String(entry.assetId));
        const signed = await resolveSignedUrl(entry.assetId, entry.url, originHeaders);
        if (signed) {
            candidates.push({ url: signed, headers: new Headers(originHeaders), cacheKey: stableCacheKey });
        }
    }

    if (!wantFresh || candidates.length === 0) {
        candidates.push({ url: entry.url, headers: originHeaders, cacheKey: stableCacheKey });
        if (!wantFresh && entry.assetId) {
            const signed = await resolveSignedUrl(entry.assetId, entry.url, originHeaders);
            if (signed) {
                const signedHeaders = new Headers(originHeaders);
                candidates.push({ url: signed, headers: signedHeaders, cacheKey: stableCacheKey });
            }
        }
    }

    let originResponse: Response;
    let usedSignedUrl = false;
    try {
        const result = await fetchOrigin(candidates, function (candidate) {
            usedSignedUrl = candidate.url !== entry.url;
        }, wantFresh);
        if (!result) {
            throw new Error("所有候选源地址均不可用");
        }
        originResponse = result;

        /**
         * 签名过期重试。
         *
         * 签名 URL 有时效（约 5 分钟），若缓存的签名在取回时恰好过期，
         * 源站会返回 403/404。此时丢弃缓存的签名、重新换取一个新的签名，
         * 再试一次。这条路径只在「实际走的是签名地址」且「签名失效」时触发，
         * 正常情况下第一次就能拿到内容。
         *
         * 若主路径（原始 URL）本身返回 404，说明资源确实不存在，
         * 不做签名重试，避免无谓的 GitHub API 调用。
         */
        if (usedSignedUrl && (originResponse.status === 403 || originResponse.status === 404) && entry.assetId) {
            signedUrlCache.delete(String(entry.assetId));
            const refreshed = await resolveSignedUrl(entry.assetId, entry.url, originHeaders);
            if (refreshed) {
                const retry = await fetchOrigin([
                    { url: refreshed, headers: new Headers(originHeaders), cacheKey: stableCacheKey }
                ]);
                if (retry) {
                    try {
                        await originResponse.body?.cancel();
                    } catch (error) {
                        // 忽略取消失败，原始响应体未消费时无需处理
                    }
                    originResponse = retry;
                }
            }
        }
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
    } else {
        responseHeaders.set("x-proxy-cache-status", "UNKNOWN");
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
        // 强制回源时不留任何缓存，避免调用方拿到被缓存的旧内容
        responseHeaders.set("cache-control",
            wantFresh ? "no-store, no-cache, must-revalidate" : "public, max-age=86400, immutable");
    }

    // 强制回源标记：便于调用方确认本次确实绕过了边缘缓存
    if (wantFresh) {
        responseHeaders.set("x-proxy-fresh", "1");
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
