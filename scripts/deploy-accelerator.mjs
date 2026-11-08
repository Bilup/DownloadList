/**
 * 部署独立的 Cloudflare Workers 下载加速器。
 *
 * 与 Pages 内置的 `_worker.js` 的区别：
 *   - Pages 的 Worker 随站点一起部署，代理表编译进产物；
 *     新增 release 必须重新构建并部署站点，而重新部署会让边缘缓存全部失效。
 *   - 本加速器的代理表放在 KV 里，构建产物只保留一份兜底副本；
 *     日常更新代理表只需写 KV（KV 有边缘缓存，60 秒内全网生效），
 *     不会打断正在进行的下载缓存。
 *
 * 脚本只操作 Workers 脚本与 KV 命名空间，不涉及任何 zone / DNS / 自定义域名，
 * 因此不会影响账号下已有的域名配置。
 *
 * 用法：
 *   CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id> \
 *     node scripts/deploy-accelerator.mjs [--dry-run]
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const WORKER_NAME = "bilup-download-accelerator";
const WORKER_ENTRY = resolve(ROOT, "src/node/proxy/cloudflarePagesDownProxy/worker/acceleratorEntry.ts");
const KV_NAMESPACE_TITLE = "bilup-download-accelerator";
const KV_TABLE_KEY = "proxy-table";
const OUT_DIR = resolve(ROOT, "accelerator/dist");

const DRY_RUN = process.argv.includes("--dry-run");

const API = "https://api.cloudflare.com/client/v4";

function env(name) {
    const v = process.env[name];
    if (!v) throw new Error(`缺少环境变量 ${name}`);
    return v;
}

function log(...args) {
    console.log("[accelerator]", ...args);
}

async function cf(path, options = {}) {
    const token = env("CLOUDFLARE_API_TOKEN");
    const res = await fetch(API + path, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(options.headers || {})
        }
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`API ${path} 返回非 JSON (${res.status}): ${text.slice(0, 300)}`);
    }
    if (!json.success) {
        throw new Error(`API ${path} 失败 (${res.status}): ${JSON.stringify(json.errors).slice(0, 400)}`);
    }
    return json.result;
}

/** 读取构建阶段导出的代理表副本（.vuepress/proxy-table.json） */
function readInlineProxyTable() {
    const tablePath = resolve(ROOT, ".vuepress/proxy-table.json");
    if (existsSync(tablePath)) {
        return JSON.parse(readFileSync(tablePath, "utf8"));
    }
    log("未找到 .vuepress/proxy-table.json，将使用空代理表（仅 KV 生效）");
    return {};
}

async function ensureKvNamespace(accountId) {
    const namespaces = await cf(`/accounts/${accountId}/storage/kv/namespaces`);
    const found = namespaces.find((n) => n.title === KV_NAMESPACE_TITLE);
    if (found) {
        log(`KV 命名空间已存在: ${KV_NAMESPACE_TITLE} (${found.id})`);
        return found.id;
    }
    const created = await cf(`/accounts/${accountId}/storage/kv/namespaces`, {
        method: "POST",
        body: JSON.stringify({title: KV_NAMESPACE_TITLE})
    });
    log(`KV 命名空间已创建: ${created.id}`);
    return created.id;
}

async function syncKvTable(accountId, namespaceId, table) {
    const value = JSON.stringify(table);
    await cf(`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${KV_TABLE_KEY}`, {
        method: "PUT",
        body: value
    });
    log(`代理表已写入 KV: ${Object.keys(table).length} 条, ${value.length} 字节`);
}

async function buildWorker(table, options) {
    const result = await build({
        entryPoints: [WORKER_ENTRY],
        bundle: true,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        write: false,
        define: {
            PROXY_CONFIG: JSON.stringify(table),
            PROXY_OPTIONS: JSON.stringify(options)
        }
    });
    return result.outputFiles[0].text;
}

async function deployWorker(accountId, source, namespaceId) {
    const metadata = {
        main_module: "worker.js",
        bindings: [
            {
                name: "PROXY_KV",
                type: "kv_namespace",
                namespace_id: namespaceId
            }
        ],
        compatibility_date: "2026-11-08",
        compatibility_flags: ["nodejs_compat"],
        // 免费计划必须使用 bundled 计费模式。
        // 省略该字段会默认为 standard，在 Free Plan 下 Worker 运行时报 1042 错误。
        usage_model: "bundled"
    };

    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    form.append("worker.js", new Blob([source], {type: "application/javascript+module"}), "worker.js");

    const token = env("CLOUDFLARE_API_TOKEN");
    const res = await fetch(`${API}/accounts/${accountId}/workers/scripts/${WORKER_NAME}`, {
        method: "PUT",
        headers: {Authorization: `Bearer ${token}`},
        body: form
    });
    const json = await res.json();
    if (!json.success) {
        throw new Error(`部署 Worker 失败 (${res.status}): ${JSON.stringify(json.errors).slice(0, 400)}`);
    }
    log(`Worker 已部署: ${WORKER_NAME}`);
    return json.result;
}

/**
 * 启用 workers.dev 子域路由。
 *
 * 通过 API 直传脚本不会自动创建 workers.dev 路由，
 * 未启用时请求会命中 "error code: 1042"（找不到 Worker）。
 *
 * 注意：
 *   1. 此端点只接受 POST，PUT/PATCH 会返回 405。
 *   2. 开启该路由的权限高于普通 User API Token（会返回 405），
 *      此时只要路由已启用即可，不视为失败。
 */
async function enableWorkersDev(accountId, enabled = true) {
    let current = null;
    try {
        current = await cf(`/accounts/${accountId}/workers/scripts/${WORKER_NAME}/subdomain`);
    } catch (error) {
        current = null;
    }
    if (current && current.enabled === enabled) {
        log(`workers.dev 路由已是 ${enabled ? "启用" : "禁用"} 状态，跳过`);
        return current;
    }
    try {
        const result = await cf(`/accounts/${accountId}/workers/scripts/${WORKER_NAME}/subdomain`, {
            method: "POST",
            body: JSON.stringify({enabled, previews_enabled: false})
        });
        log(`workers.dev 路由: ${result.enabled ? "已启用" : "已禁用"}`);
        return result;
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (message.indexOf("405") >= 0) {
            log("当前凭据无权修改 workers.dev 路由（405），跳过；请在控制台确认路由已启用");
            return null;
        }
        throw error;
    }
}

async function main() {
    const accountId = env("CLOUDFLARE_ACCOUNT_ID");
    const table = readInlineProxyTable();
    const options = {
        cacheTtl: 604800,
        exposeClientInfo: false
    };

    const source = await buildWorker(table, options);
    mkdirSync(OUT_DIR, {recursive: true});
    writeFileSync(resolve(OUT_DIR, "worker.js"), source);
    log(`Worker 已打包: ${source.length} 字节 -> ${OUT_DIR}/worker.js`);

    if (DRY_RUN) {
        log("--dry-run: 跳过 KV 同步与部署");
        return;
    }

    const namespaceId = await ensureKvNamespace(accountId);
    await syncKvTable(accountId, namespaceId, table);
    await deployWorker(accountId, source, namespaceId);
    await enableWorkersDev(accountId, true);

    // 报告 Worker 的访问地址。注意：workers.dev 域名在部分网络环境下会被 DNS 污染，
    // 如需自定义域名请在 Cloudflare 控制台手动绑定，本脚本不改动任何域名配置。
    const subdomain = await cf(`/accounts/${accountId}/workers/subdomain`);
    log(`访问地址: https://${WORKER_NAME}.${subdomain.subdomain}.workers.dev/down/<key>/<filename>`);
    log("（本脚本未配置任何域名 / DNS / 路由）");
}

main().catch((error) => {
    console.error("[accelerator] 失败:", error && error.message ? error.message : error);
    process.exit(1);
});
