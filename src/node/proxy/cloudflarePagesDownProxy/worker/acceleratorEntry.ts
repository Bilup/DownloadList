import {downloadProxy, ProxyEntry, ProxyOptions, KVStore} from "./cloudflarePagesDownloadPorxy.js";

/**
 * 独立下载加速 Worker 入口（Cloudflare Workers）。
 *
 * 与 Pages 内置的 `_worker.js` 使用同一套代理核心逻辑，区别在于：
 *
 * 1. 代理表通过 KV 动态下发
 *    构建期内联的静态表仅作为兜底。新增 release 时只需重写 KV 中的一条记录，
 *    不必重新部署 Worker —— 重新部署会让边缘缓存全部失效，导致下载速度骤降。
 *
 * 2. 独立部署，与站点发布解耦
 *    站点构建（Pages）与下载加速互不影响：站点改版不会中断下载，
 *    下载代理表更新也不需要重新构建整个站点。
 *
 * 环境变量绑定（部署时配置）：
 *   PROXY_KV  -> KV namespace，存放键 "proxy-table" 的代理表 JSON
 */

declare const PROXY_CONFIG: { [key: string]: ProxyEntry };
declare const PROXY_OPTIONS: ProxyOptions;

export default {
    async fetch(request: Request, env?: { PROXY_KV?: KVStore }): Promise<Response> {
        return downloadProxy(request, PROXY_CONFIG, PROXY_OPTIONS, env && env.PROXY_KV);
    }
};
