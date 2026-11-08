import {build} from "esbuild";
import {path} from "vuepress/utils";
import {fileURLToPath} from "url";

/**
 * 统一的 Worker 打包工具。
 *
 * 原实现使用 `downloadProxy.toString()` 把函数源码直接拼进产物，
 * 这在函数内部引用了其他模块导出的辅助函数时会直接运行时报错
 * （辅助函数不会随 toString() 一起被带过去）。
 *
 * 改为 esbuild 打包后，模块依赖会被正确内联，
 * 三个平台（Cloudflare Pages / Vercel Edge / Netlify Edge）行为保持一致。
 */

/** 代理条目 */
export interface ProxyEntry {
    url: string;
    name?: string;
    type?: string;
    size?: number;
    /**
     * GitHub Release 资源的 asset id。
     * 提供时代理优先用 asset API 回源（见 cloudflarePagesDownloadPorxy.ts）。
     */
    assetId?: number;
}

/** 代理行为配置 */
export interface ProxyOptions {
    cacheTtl?: number;
    exposeClientInfo?: boolean;
}

/**
 * 将指定入口打包为单个 ESM 文件，并把代理表与配置注入为 JSON 字面量。
 *
 * @param entryPath 入口文件的绝对路径
 * @param proxyConfig 代理表
 * @param proxyOptions 行为配置
 */
export async function bundleProxyWorker(entryPath: string, proxyConfig: { [key: string]: ProxyEntry }, proxyOptions: ProxyOptions): Promise<string> {
    const result = await build({
        entryPoints: [entryPath],
        bundle: true,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        write: false,
        define: {
            PROXY_CONFIG: JSON.stringify(proxyConfig),
            PROXY_OPTIONS: JSON.stringify(proxyOptions)
        }
    });
    return result.outputFiles[0].text;
}

/**
 * 解析同级目录下的 worker 入口路径。
 * @param fromFile 调用方所在文件（import.meta.url）
 * @param relative 相对路径
 */
export function resolveWorkerEntry(fromFile: string, relative: string): string {
    const dir = path.dirname(fileURLToPath(fromFile));
    return path.join(dir, relative);
}
