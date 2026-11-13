import { abFolders, addFileToFileTree, Folder, joinFile } from "../../base/files.js";
import { Analysis } from "../../base/AllAnalysis.js";


export interface GithubRepository {
    user: string
    repository: string,
    authorizationToken?: string,
    per_page?: number,
    page?: number
}

/** 单条 release 资源 */
interface ReleaseAsset {
    browser_download_url: string,
    name: string,
    updated_at: string,
    size: number,
    content_type: string
    id: number
}

/** 单条 release */
interface ReleaseInfo {
    tag_name: string,
    name: string,
    body: string,
    published_at: string,
    draft?: boolean,
    prerelease?: boolean,
    assets: ReleaseAsset[]
}

/** 每页拉取的 release 数量，取 GitHub 允许的最大值 100 */
const PAGE_SIZE = 100;

/** 最多翻多少页，防止异常情况下无限循环 */
const MAX_PAGES = 20;

/**
 * 拉取仓库的全部 release。
 *
 * GitHub 的 /releases 接口默认只返回第 1 页、每页 30 条。
 * Desktop 仓库的 release 数量已逼近这个阈值，一旦超过，
 * 最旧的 release 会被静默丢弃（表现为站点上少了几个版本）。
 * 因此这里主动翻页拉全量。
 *
 * @param config 仓库配置
 * @param pageSize 每页条数，0 或未指定时使用 100
 * @param maxPages 最多翻页数
 */
async function fetchAllReleases(config: GithubRepository, pageSize: number, maxPages: number): Promise<ReleaseInfo[]> {
    const headers = new Headers();
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    if (config.authorizationToken) {
        headers.set("Authorization", `Bearer ${config.authorizationToken}`);
    }

    const all: ReleaseInfo[] = [];
    for (let page = 1; page <= maxPages; page++) {
        const qurl = new URL(`https://api.github.com/repos/${config.user}/${config.repository}/releases`);
        qurl.searchParams.append("per_page", `${pageSize}`);
        qurl.searchParams.append("page", `${page}`);

        let tagInfo: Response;
        try {
            tagInfo = await fetch(qurl, { headers: headers });
        } catch (e) {
            throw new Error("Github Api 请求失败! 请检查网络是否畅通。" + e);
        }
        if (!tagInfo.ok) {
            throw new Error("仓库名称或者用户名错误，或者达到GitHub速率限制,详细信息:" + tagInfo.status + " " + tagInfo.statusText + " " + tagInfo.url + " " + await tagInfo.text());
        }

        const pageData = await tagInfo.json() as ReleaseInfo[];
        if (!Array.isArray(pageData) || pageData.length === 0) {
            // 没有更多数据了，正常结束
            break;
        }
        all.push(...pageData);
        // 最后一页返回的数据不足一页，说明已到末尾
        if (pageData.length < pageSize) {
            break;
        }
    }
    return all;
}

async function githubReleasesFileTree(config: GithubRepository): Promise<Folder> {
    const fileTree: Folder = { children: [], name: "githubReleasesRoot" };

    // 显式指定的 page 保留原有语义（只取那一页），未指定则翻页拉全量
    let tagInfo: ReleaseInfo[];
    if (config.page) {
        tagInfo = await fetchAllReleases(config, config.per_page || PAGE_SIZE, config.page);
    } else {
        tagInfo = await fetchAllReleases(config, config.per_page || PAGE_SIZE, MAX_PAGES);
    }

    for (const { tag_name, name, body, published_at, assets } of tagInfo) {
        const tagFolder: Folder = {
            title: name,
            content: "",
            children: [],
            updateTime: new Date(published_at).getTime(),
            size: 0,
            name: "githubReleasesTagRoot"
        };
        for (const { browser_download_url, size, name, updated_at, content_type, id } of assets) {
            if (name.includes("Source code")) continue;

            joinFile(tagFolder, {
                downloadUrl: browser_download_url,
                updateTime: new Date(updated_at).getTime(),
                size: size,
                contentType: content_type,
                name: name,
                downloadCorsAllow: "loose",
                // 记录 asset id，供下载代理改用 asset API 回源
                assetId: id
            });
        }
        let tagPath: string = tag_name;
        if (tagPath == "root") {
            tagPath = "";
        }
        if (tagPath.startsWith("root/")) {
            tagPath = tagPath.substring(5);
        }
        if (tagPath) {
            const pathArray = tagPath.split("/");
            tagFolder.name = pathArray.pop()!;
            addFileToFileTree(fileTree, pathArray, tagFolder);
        } else {
            abFolders(fileTree, tagFolder);
        }
    }
    return fileTree;
}
export function githubReleasesFilesAnalysis(config: GithubRepository): Analysis {
    return () => githubReleasesFileTree(config);
}
