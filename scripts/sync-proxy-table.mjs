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
import {createHash} from "node:crypto";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const KV_NAMESPACE_TITLE = "bilup-download-proxy";
const KV_TABLE_KEY = "proxy-table";
const KV_TOKEN_KEY = "github-token";
/**
 * 分片键前缀，与 Worker 侧保持一致。
 *
 * 注意：键名里绝不能出现 `#`、`?`、`/` 这类字符 ——
 * `#` 在 URL 里是 fragment 分隔符，`fetch` 会把它之后的内容丢弃，
 * 导致请求实际落到别的键上（曾因此把 16 个分片全部误写到整表键）。
 * 这里用 `.` 作分隔符，同时所有键名一律经 encodeURIComponent 处理。
 */
const KV_SHARD_PREFIX = KV_TABLE_KEY + ".shard.";
/** 分片清单键，记录各分片内容哈希 */
const KV_MANIFEST_KEY = KV_TABLE_KEY + ".manifest";
const API = "https://api.cloudflare.com/client/v4";

/** KV 键名统一走这里：URL 编码，防止特殊字符被解释成 URL 语法 */
function kvValuePath(accountId, namespaceId, key) {
    return `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
}

function env(name) {
    const v = process.env[name];
    if (!v) throw new Error(`缺少环境变量 ${name}`);
    return v;
}

function log(...args) {
    console.log("[sync-kv]", ...args);
}

/**
 * 调用 Cloudflare API，失败时自动退避重试。
 *
 * 重试的两种触发条件：
 *   1. HTTP 429 —— KV 对「同一键」限制 1 次/秒。连续推送多个提交、
 *      或手动重跑工作流时，两次流水线可能在同一秒写同一个键而撞限。
 *   2. HTTP 5xx —— Cloudflare 偶发 503 (no healthy upstream)。
 *
 * 写入操作本身是幂等的（同样的表反复写入结果相同），重试安全。
 */
async function cf(path, options = {}) {
    const token = env("CLOUDFLARE_API_TOKEN");
    const maxAttempts = 6;
    let lastError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await fetch(API + path, {
            ...options,
            headers: {
                Authorization: `Bearer ${token}`,
                "content-type": "application/json",
                ...(options.headers || {})
            }
        });
        const text = await res.text();

        // KV 的 values 端点返回 application/octet-stream 纯文本，不是 JSON 包装
        const contentType = res.headers.get("content-type") || "";

        if (res.status === 429 || res.status >= 500) {
            const retryAfter = Number(res.headers.get("retry-after")) || 0;
            // 429 至少等 1.2 秒（KV 同键限速是 1 次/秒）
            const waitMs = Math.max(retryAfter * 1000, 1200) * attempt;
            lastError = `HTTP ${res.status} ${res.statusText}`;
            if (attempt < maxAttempts) {
                log(`API ${path} 返回 ${lastError}，${waitMs}ms 后重试 (${attempt}/${maxAttempts - 1})`);
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
            }
            throw new Error(`API ${path} 重试耗尽，最后一次失败 (${res.status}): ${text.slice(0, 300)}`);
        }

        if (!text) return null;
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
    throw new Error(`API ${path} 重试耗尽: ${lastError}`);
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

    /**
     * 按分片拆分代理表。
     *
     * KV 单个值的上限是 25 MiB，超过会被 API 拒绝：
     *   HTTP 413 {"code":10024,"message":"Value size ... exceeds maximum allowed size of 25MiB"}
     * （实测 25 MiB 可写入、26 MiB 被拒）
     *
     * 整表放在一个键里迟早会撞上限，撞上之后同步作业失败，
     * 新版本就发布不出去。因此按「代理键的首位十六进制字符」拆成 16 片，
     * 每片一个 KV 键。代理键本身就是 sha1(源URL) 的前 16 位，
     * 天然均匀分布，且查表时能直接由 key 定位分片，无需额外索引。
     *
     * 16 片的总容量 = 16 × 25 MiB = 400 MiB 原始数据，
     * 按每版本约 10 KiB 计，约可支撑 39000 个 release。
     */
    const SHARD_COUNT = 16;
    const VALUE_LIMIT = 25 * 1024 * 1024;

    const shards = new Map();
    for (const [key, entry] of Object.entries(table)) {
        const first = key.charAt(0).toLowerCase();
        const shardId = /^[0-9a-f]$/.test(first) ? first : "0";
        if (!shards.has(shardId)) shards.set(shardId, {});
        shards.get(shardId)[key] = entry;
    }

    const shardBodies = new Map();
    for (const [shardId, entries] of shards) {
        const body = JSON.stringify(entries);
        if (body.length > VALUE_LIMIT) {
            throw new Error(
                `分片 ${shardId} 有 ${Object.keys(entries).length} 条，` +
                `${body.length} 字节已超过 KV 单值上限 ${VALUE_LIMIT} 字节。` +
                `需要增加分片数量（当前 ${SHARD_COUNT} 片）。`
            );
        }
        shardBodies.set(shardId, body);
    }

    /**
     * 读取分片清单，跳过内容未变化的分片。
     *
     * KV 免费版每日写入上限 1000 次，若每次同步都写全部 16 片，
     * 一天迭代 60 次就会撞限。清单里记录各分片当前内容的哈希，
     * 只有变化了的分片才需要写入。
     */
    let manifest = null;
    try {
        const raw = await cf(
            kvValuePath(accountId, namespaceId, KV_MANIFEST_KEY),
            { method: "GET" }
        );
        if (typeof raw === "string" && raw.length > 0) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") manifest = parsed;
        }
    } catch (error) {
        log("未找到分片清单，将写入全部分片");
    }

    const prevShards = (manifest && manifest.shards) || {};
    let written = 0;
    let skipped = 0;
    const newShards = {};

    /**
     * KV 对同一 namespace 的写入有速率限制，连续快速写入会返回 429。
     * 实测一次同步 16 片时命中过一次 429（靠退避重试化解）。
     * 这里主动在片与片之间留出间隔，让写入平滑通过，
     * 避免每次同步都触发重试、拖慢流水线。
     */
    const WRITE_INTERVAL_MS = 150;

    for (const [shardId, body] of shardBodies) {
        const hash = createHash("sha1").update(body).digest("hex").slice(0, 16);
        newShards[shardId] = hash;
        if (prevShards[shardId] === hash) {
            skipped++;
            continue;
        }
        if (written > 0) {
            await new Promise((r) => setTimeout(r, WRITE_INTERVAL_MS));
        }
        await cf(
            kvValuePath(accountId, namespaceId, KV_SHARD_PREFIX + shardId),
            { method: "PUT", body }
        );
        written++;
    }

    // 整表键保留一份作兜底：分片读取失败或迁移期未覆盖到时仍能查到。
    // 体积超过上限时跳过写入 —— 分片已经是完整数据源，不影响功能。
    const valueUsage = value.length / VALUE_LIMIT;
    if (value.length <= VALUE_LIMIT) {
        await new Promise((r) => setTimeout(r, WRITE_INTERVAL_MS));
        await cf(kvValuePath(accountId, namespaceId, KV_TABLE_KEY), {
            method: "PUT",
            body: value
        });
    } else {
        log(`整表 ${value.length} 字节已超单值上限，跳过整表键（分片已是完整数据源）`);
    }

    // 写入清单，供下次同步比对
    await new Promise((r) => setTimeout(r, WRITE_INTERVAL_MS));
    await cf(
        kvValuePath(accountId, namespaceId, KV_MANIFEST_KEY),
        { method: "PUT", body: JSON.stringify({ shards: newShards, count }) }
    );

    const totalShardBytes = [...shardBodies.values()].reduce((a, b) => a + b.length, 0);
    log(`分片写入完成: 写入 ${written} 片，跳过 ${skipped} 片（未变化），` +
        `共 ${shardBodies.size} 片 / ${totalShardBytes} 字节` +
        `（整表 ${value.length} 字节，占单片上限 ${(valueUsage * 100).toFixed(2)}%）`);

    if (valueUsage > 0.5) {
        log(`⚠ 整表已占单片上限的 ${(valueUsage * 100).toFixed(1)}%，` +
            `接近上限时需要增加分片数量（当前 ${SHARD_COUNT} 片）`);
    }

    // 写入 GitHub 令牌，供代理用 asset API 回源
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken && ghToken.length > 0) {
        // 先验令牌有效性，失效则直接失败，避免把坏令牌写进 KV
        await checkGitHubToken(ghToken);
        await cf(kvValuePath(accountId, namespaceId, KV_TOKEN_KEY), {
            method: "PUT",
            body: ghToken
        });
        log(`GitHub 令牌已写入 KV (${KV_TOKEN_KEY})`);
    } else {
        log(`未提供 GITHUB_TOKEN，跳过令牌写入（代理将回退到原始 URL，冷缓存可能 504）`);
    }
}

/**
 * 检查 GitHub 令牌是否仍然有效。
 *
 * 令牌失效时，代理的 asset API 回源会 401/403，
 * 冷缓存的新版本首次下载就会失败，且问题隐蔽（缓存命中时一切正常）。
 * 因此在同步前先验一次，失效则让流水线明确失败。
 */
async function checkGitHubToken(token) {
    const res = await fetch("https://api.github.com/rate_limit", {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"
        }
    });
    if (!res.ok) {
        throw new Error(`GitHub 令牌校验失败 (${res.status} ${res.statusText})，请更新 GITHUB_TOKEN`);
    }
    const json = await res.json();
    const core = json && json.resources && json.resources.core;
    if (core) {
        log(`GitHub 令牌有效，API 配额剩余 ${core.remaining}/${core.limit}`);
    }
}

main().catch((error) => {
    console.error("[sync-kv] 失败:", error && error.message ? error.message : error);
    process.exit(1);
});
