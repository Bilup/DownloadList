import {downloadProxy, ProxyEntry, ProxyOptions} from "../cloudflarePagesDownProxy/worker/cloudflarePagesDownloadPorxy.js";

/**
 * Vercel Edge / Netlify Edge 的 Worker 入口。
 * PROXY_CONFIG / PROXY_OPTIONS 在构建期由 esbuild 注入为 JSON 字面量。
 */

declare const PROXY_CONFIG: { [key: string]: ProxyEntry };
declare const PROXY_OPTIONS: ProxyOptions;

export default async function handler(request: Request): Promise<Response> {
    return downloadProxy(request, PROXY_CONFIG, PROXY_OPTIONS);
}
