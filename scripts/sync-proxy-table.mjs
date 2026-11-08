/**
 * 把代理表同步到 KV。
 *
 * Pages 的 `_worker.js` 以 KV 中的代理表为最新数据，构建期内联的静态表仅作兜底。
 * 因此新增 release 时：
 *
 *   1. 跑一次构建，产出 .vuepress/proxy-table.json（代理表副本）
 *   2. 执行本脚本把该表写入 KV
 *   3. KV 边缘缓存在 60 秒内全网生效
 *
 * 同步 KV 不会触发重新部署，因此边缘缓存得以保留，下载速度不受影响。
 *
 * 同时写入 GitHub 令牌：GitHub 会阻断 Cloudflare 出口 IP 直接访问
 * /releases/download/**（实测返回 504），代理需要用令牌调 asset API 回源。
 * 令牌从环境变量 GITHUB_TOKEN 读取，未设置则跳过（代理会回退到原始 URL）。
 *
 * 用法：
 *   CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id> [GITHUB_TOKEN=<gh-token>] \
 *     node scripts/sync-proxy-table.mjs [代理表文件路径]
 */

import {readFileSync, existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const KV_NAMESPACE_TITLE = "bilup-download-proxy";
const KV_TABLE_KEY = "proxy-table";
const KV_TOKEN_KEY = "github-token";
const API = "https://api.cloudflare.com/client/v4";

function env(name) {
    const v = process.env[name];
    if (!v) throw new Error(`缺少环境变量 ${name}`);
    return v;
}

function log(...args) {
    console.log("[sync-kv]", ...args);
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
    if (!text) return null;
    // KV 的 values 端点返回 application/octet-stream 纯文本，不是 JSON 包装
    const contentType = res.headers.get("content-type") || "";
    if (contentType.indexOf("application/json") < 0) return text;
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

async function resolveNamespaceId(accountId) {
    const namespaces = await cf(`/accounts/${accountId}/storage/kv/namespaces`);
    const found = namespaces.find((n) => n.title === KV_NAMESPACE_TITLE);
    if (!found) {
        throw new Error(`未找到 KV 命名空间 "${KV_NAMESPACE_TITLE}"，请先运行 deploy-accelerator.mjs`);
    }
    return found.id;
}

async function main() {
    const accountId = env("CLOUDFLARE_ACCOUNT_ID");
    const tablePath = process.argv[2]
        ? resolve(process.cwd(), process.argv[2])
        : resolve(ROOT, ".vuepress/proxy-table.json");

    if (!existsSync(tablePath)) {
        throw new Error(`代理表文件不存在: ${tablePath}`);
    }
    const table = JSON.parse(readFileSync(tablePath, "utf8"));
    const count = Object.keys(table).length;
    if (count === 0) {
        throw new Error("代理表为空，拒绝写入（会覆盖掉线上可用的表）");
    }
    log(`读取代理表: ${count} 条 (${tablePath})`);

    const namespaceId = await resolveNamespaceId(accountId);
    const value = JSON.stringify(table);
    await cf(`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${KV_TABLE_KEY}`, {
        method: "PUT",
        body: value
    });
    log(`已写入 KV (${namespaceId}): ${count} 条, ${value.length} 字节，约 60 秒内全网生效`);

    // 写入 GitHub 令牌，供代理用 asset API 回源
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken && ghToken.length > 0) {
        await cf(`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${KV_TOKEN_KEY}`, {
            method: "PUT",
            body: ghToken
        });
        log(`GitHub 令牌已写入 KV (${KV_TOKEN_KEY})`);
    } else {
        log(`未提供 GITHUB_TOKEN，跳过令牌写入（代理将回退到原始 URL，冷缓存可能 504）`);
    }
}

main().catch((error) => {
    console.error("[sync-kv] 失败:", error && error.message ? error.message : error);
    process.exit(1);
});
