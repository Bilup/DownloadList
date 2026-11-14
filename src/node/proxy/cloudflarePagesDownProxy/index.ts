import {DownProxy} from "../../base/AllAnalysis.js";
import {writeFileSync} from "fs";
import {path} from "vuepress/utils";
import {createHash} from "crypto";
import {onExtendsBundlerOptions, onGenerated} from "../../base/eventManager.js";
import {ProxyOptions} from "vite";
import {bundleProxyWorker, ProxyEntry, resolveWorkerEntry} from "../proxyWorkerBundle.js";

/**
 * Cloudflare Pages 下载代理
 *
 * 相比原实现的关键改动：
 *
 * 1. 代理前缀由随机数改为稳定值
 *    原实现用 Math.random() 生成 /down/<random>/ 前缀，导致：
 *      - 每次构建都会生成全新路径，已分发的下载链接全部失效
 *      - 路径不可预测，无法作为稳定的边缘缓存键
 *    现改为固定前缀 /down/，并用“源 URL 的 sha1”作为条目键，
 *    同一源地址在任何一次构建中都映射到同一路径，链接长期有效。
 *
 * 2. 代理表由“路径 -> URL”改为“路径片段 -> 条目”
 *    条目中携带 url/name/type，使 Worker 能正确设置
 *    Content-Disposition 与 Content-Type，而不必依赖源站的响应头。
 *
 * 3. Worker 改为 esbuild 打包（见 proxyWorkerBundle.ts）
 *    原实现用 downloadProxy.toString() 把函数源码拼进 _worker.js，
 *    一旦函数内部引用了其他模块导出的辅助函数就会运行时报错。
 *
 * 4. 哈希改用 sha1
 *    原实现使用 32 位 hashCode，存在碰撞风险（不同源地址映射到同一路径）。
 *
 * 5. 保留旧路径兼容
 *    findProxyEntry 按“逐段匹配”查找，因此旧版 /down/<随机>/<hash>/<文件名>
 *    形式的历史链接在改造后依然可以解析到正确的源地址。
 */

const PROXY_PREFIX = "/down/";

/**
 * 下载链接的版本号。
 *
 * 为什么需要它：
 *
 * Cloudflare 会缓存 Worker 的**最终响应**（响应带 `Cache-Control: max-age=86400,
 * immutable` 时），缓存键是完整 URL（含查询串）。缓存命中时 Worker **不会执行**，
 * 直接返回当初缓存的那份响应快照。
 *
 * 麻烦之处在于「每次命中都会刷新 Age」—— 旧条目因此**无限续命、永不过期**：
 * Worker 代码更新上线后，用户依然持续命中旧条目，新加的响应头迟迟不生效。
 * 实测确认：同一 URL 第二次请求时 x-proxy-cache-status 与首次完全相同、
 * Age 停在首次的值，说明 Worker 根本没有重新执行。
 *
 * 解决办法：给链接加一个版本参数。版本一变，URL 就变，缓存键随之改变，
 * Worker 必然重新执行、老条目不再被使用。
 *
 * **维护规则**：改动 Worker 的响应头构造（新增/修改任何响应头）时，
 * 必须把这里的版本号 +1，否则用户会继续命中旧条目。
 *
 * 注：`Accept-Ranges` 是例外 —— Cloudflare 接管缓存后会自己处理 Range 语义，
 * 不再透传这个头，bump 版本也救不回来。判断分段能力一律看状态码（206）。
 */
const PROXY_VERSION = 3;

/** 代理条目的键 -> 条目 */
const proxyConfig: { [key: string]: ProxyEntry } = {};

/** Worker 行为配置 */
const proxyOptions = {
    /** 边缘缓存 TTL（秒）：7 天 */
    cacheTtl: 604800,
    /** 是否在响应头回显客户端地址族（默认关闭，避免污染边缘缓存） */
    exposeClientInfo: false
};

/** 计算源地址的稳定键 */
function sourceKey(sourceUrl: string): string {
    // 使用 sha1 前 16 位十六进制，碰撞概率可忽略且长度适中
    return createHash("sha1").update(sourceUrl).digest("hex").slice(0, 16);
}

/**
 * 旧版使用的 32 位 hashCode。
 * 保留它是为了让改造前已经分发出去的下载链接在改造后依然可用：
 * 旧链接形如 /down/<随机前缀>/<hashCode>/<文件名>，
 * 由于 Worker 侧按“逐段匹配”查找代理表，
 * 只要把旧的 hashCode 也登记为别名即可继续命中。
 */
function legacyHashCode(sourceUrl: string): string {
    let hash = 0;
    for (let i = 0; i < sourceUrl.length; i++) {
        hash = ((hash << 5) - hash) + sourceUrl.charCodeAt(i);
        hash |= 0;
    }
    return String(hash);
}

function getDownProxyRoutes() {
    return {
        "version": 1,
        "include": [PROXY_PREFIX + "**"],
        "exclude": []
    };
}

async function cloudflarePagesReleaseConfigurationFile(destPath: string) {
    const entry = resolveWorkerEntry(import.meta.url, "worker/entry.ts");
    const workerSource = await bundleProxyWorker(entry, proxyConfig, proxyOptions);
    writeFileSync(path.join(destPath, "_worker.js"), workerSource);
    writeFileSync(path.join(destPath, "_routes.json"), JSON.stringify(getDownProxyRoutes()));
    // 导出代理表副本到构建目录之外，供 CI 同步到 KV。
    // 写到 dist 之外，避免随站点一起公开暴露内部映射。
    writeFileSync(path.join(destPath, "..", "proxy-table.json"), JSON.stringify(proxyConfig));
}

onGenerated(async (app) => cloudflarePagesReleaseConfigurationFile(app.dir.dest()));

onExtendsBundlerOptions(async (options, app) => {
    if (app.options.bundler.name === '@vuepress/bundler-vite') {
        const proxy: Record<string, string | ProxyOptions> = {};
        for (const proxyConfigKey in proxyConfig) {
            const proxyConfigValue = proxyConfig[proxyConfigKey].url;
            proxy[PROXY_PREFIX + proxyConfigKey + "/**"] = {
                target: new URL(proxyConfigValue).toString(),
                changeOrigin: true,
                rewrite: (requestPath: string) => {
                    // 保留源地址自身的路径与查询串
                    const target = new URL(proxyConfigValue);
                    const idx = requestPath.indexOf("/**");
                    const rest = idx >= 0 ? requestPath.slice(idx + 3) : "";
                    return target.pathname + rest + target.search;
                },
                followRedirects: true
            };
        }
        options.viteOptions ??= {};
        options.viteOptions.server ??= {};
        options.viteOptions.server.proxy = { ...options.viteOptions.server.proxy, ...proxy };
    }
});

async function cloudflarePagesDownProxyInner(sourceUrl: string, fileName: string, contentType?: string, assetId?: number): Promise<string> {
    const key = sourceKey(sourceUrl);
    const entry: ProxyEntry = {
        url: sourceUrl,
        name: fileName,
        type: contentType
    };
    // 记录 asset id：Worker 可据此改用 GitHub asset API 回源，
    // 规避 Cloudflare 出口 IP 访问 /releases/download/** 被限制的问题。
    if (typeof assetId === "number" && assetId > 0) {
        entry.assetId = assetId;
    }
    proxyConfig[key] = entry;
    // 登记旧版 hashCode 别名，保证历史链接继续可用
    const legacyKey = legacyHashCode(sourceUrl);
    if (!Object.prototype.hasOwnProperty.call(proxyConfig, legacyKey)) {
        proxyConfig[legacyKey] = entry;
    }
    // 版本参数用于绕开 Cloudflare 对旧响应条目的缓存（见 PROXY_VERSION 的说明）
    return PROXY_PREFIX + key + "/" + encodeURIComponent(fileName) + "?v=" + PROXY_VERSION;
}

function cloudflarePagesDownProxy(): DownProxy {
    return (sourceUrl, fileName, contentType, assetId) => cloudflarePagesDownProxyInner(sourceUrl, fileName, contentType, assetId);
}

export default cloudflarePagesDownProxy;
