import { DownProxy } from "../../base/AllAnalysis.js";
import { writeFileSync, mkdirSync } from "fs";
import { onExtendsBundlerOptions, onGenerated } from "../../base/eventManager.js";
import { ProxyOptions } from "vite";
import { createHash } from "crypto";
import { bundleProxyWorker, ProxyEntry, resolveWorkerEntry } from "../proxyWorkerBundle.js";

const PROXY_PREFIX = "/api/netlifydown/";

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
    return createHash("sha1").update(sourceUrl).digest("hex").slice(0, 16);
}

async function netlifyReleaseConfigurationFile(destPath: string) {
    mkdirSync("./.netlify/edge-functions/server", { recursive: true });
    const entry = resolveWorkerEntry(import.meta.url, "worker/entry.ts");
    const workerSource = await bundleProxyWorker(entry, proxyConfig, proxyOptions);
    writeFileSync("./.netlify/edge-functions/server/server.js", workerSource);
    writeFileSync("./.netlify/edge-functions/manifest.json", JSON.stringify({
        "version": 1,
        "functions": [
            {
                "path": "/api/netlifydown/*",
                "name": "flist server handler",
                "function": "server"
            }
        ]
    }));
}

/**
 * 如果被引用了就注册生成配置文件的事件
 * */
onGenerated(async (app) => netlifyReleaseConfigurationFile(app.dir.dest()));
/**
 * 配置dev代理和netlify一样工作
 * */
onExtendsBundlerOptions(async (options, app) => {
    if (app.options.bundler.name === '@vuepress/bundler-vite') {
        const proxy: Record<string, string | ProxyOptions> = {};
        for (const proxyConfigKey in proxyConfig) {
            const proxyConfigValue = proxyConfig[proxyConfigKey].url;
            proxy[PROXY_PREFIX + proxyConfigKey + "/**"] = {
                target: new URL(proxyConfigValue).toString(),
                changeOrigin: true,
                rewrite: (requestPath: string) => {
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

async function netlifyDownProxyInner(sourceUrl: string, fileName: string, contentType?: string): Promise<string> {
    const key = sourceKey(sourceUrl);
    proxyConfig[key] = {
        url: sourceUrl,
        name: fileName,
        type: contentType
    };
    return PROXY_PREFIX + key + "/" + encodeURIComponent(fileName);
}


/**
 * 使用netlify的下载代理
 * */
function netlifyDownProxy(): DownProxy {
    return (sourceUrl, fileName, contentType) => netlifyDownProxyInner(sourceUrl, fileName, contentType);
}

export default netlifyDownProxy;
