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
    // 导出代理表副本到构建目录之外，供外部工具（如独立的加速 Worker、运维脚本）
    // 读取或同步到 KV。写到 dist 之外，避免随站点一起公开暴露内部映射。
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

async function cloudflarePagesDownProxyInner(sourceUrl: string, fileName: string, contentType?: string): Promise<string> {
    const key = sourceKey(sourceUrl);
    const entry: ProxyEntry = {
        url: sourceUrl,
        name: fileName,
        type: contentType
    };
    proxyConfig[key] = entry;
    // 登记旧版 hashCode 别名，保证历史链接继续可用
    const legacyKey = legacyHashCode(sourceUrl);
    if (!Object.prototype.hasOwnProperty.call(proxyConfig, legacyKey)) {
        proxyConfig[legacyKey] = entry;
    }
    return PROXY_PREFIX + key + "/" + encodeURIComponent(fileName);
}

function cloudflarePagesDownProxy(): DownProxy {
    return (sourceUrl, fileName, contentType) => cloudflarePagesDownProxyInner(sourceUrl, fileName, contentType);
}

export default cloudflarePagesDownProxy;
