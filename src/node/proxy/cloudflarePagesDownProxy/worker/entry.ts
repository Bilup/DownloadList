import {downloadProxy, ProxyEntry, ProxyOptions} from "./cloudflarePagesDownloadPorxy.js";

/**
 * Worker 入口模板。
 *
 * 构建期会把下面的 PROXY_CONFIG / PROXY_OPTIONS 占位符替换为真实的 JSON 字面量，
 * 再交给 esbuild 打包成单个 ESM 文件。
 */

declare const PROXY_CONFIG: { [key: string]: ProxyEntry };
declare const PROXY_OPTIONS: ProxyOptions;

export default {
    async fetch(request: Request): Promise<Response> {
        return downloadProxy(request, PROXY_CONFIG, PROXY_OPTIONS);
    }
};
