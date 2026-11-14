import {downloadProxy, ProxyEntry, ProxyOptions, KVStore} from "./cloudflarePagesDownloadPorxy.js";

/**
 * Worker 入口模板。
 *
 * 构建期会把下面的 PROXY_CONFIG / PROXY_OPTIONS 占位符替换为真实的 JSON 字面量，
 * 再交给 esbuild 打包成单个 ESM 文件。
 *
 * KV 绑定（PROXY_KV）说明：
 *   代理表以 KV 中的数据为最新，构建期内联的静态表仅作兜底。
 *   这样新增 release 时只需更新 KV（60 秒内全网生效），
 *   无需重新构建部署站点 —— 重新部署会清空边缘缓存，导致下载速度骤降。
 *   未绑定 KV 或 KV 不可用时自动回退到静态表，行为与之前完全一致。
 */

declare const PROXY_CONFIG: { [key: string]: ProxyEntry };
declare const PROXY_OPTIONS: ProxyOptions;

export default {
    async fetch(request: Request, env?: { PROXY_KV?: KVStore }, ctx?: ExecutionContext): Promise<Response> {
        return downloadProxy(request, PROXY_CONFIG, PROXY_OPTIONS, env && env.PROXY_KV, ctx);
    }
};
