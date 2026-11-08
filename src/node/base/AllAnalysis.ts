import {abFolders, addFileToFileTree, deepGetAllFile, Folder, reCalcFolder} from "./files.js";


/**
 * 下载代理函数。
 *
 * @param sourceUrl    源站真实地址
 * @param fileName     文件名（用于 Content-Disposition）
 * @param contentType  内容类型
 * @param assetId      GitHub Release 资源的 asset id（可选）。
 *                     提供时代理可改用 asset API 回源，规避 Cloudflare 出口 IP
 *                     访问 /releases/download/** 被限制的问题。
 */
export type DownProxy = (sourceUrl:string,fileName:string,contentType?:string,assetId?:number)=>Promise<string>;
export type Analysis = ()=>Promise<Folder>;
export interface AnalysisConfig{
    /**一个函数,接收源url,返回下载url*/
    downProxy?:DownProxy,
    /**挂载路径*/
    mountPath?:string,
    /**驱动*/
    analysis:Analysis
}


/**
 *  加载配置文件并执行代理
 * */
async function analysisAndDownProxy(config:AnalysisConfig):Promise<Folder>{
    const folder:Folder = await config.analysis();
    if(!config.downProxy){
        return folder;
    }
    const allFile = deepGetAllFile(folder);
    for (let file of allFile) {
        file.downloadUrl = await config.downProxy(file.downloadUrl,file.name,file.contentType,file.assetId);
        file.downloadCorsAllow = "allow";
    }
    return folder;
}

/**
 * 从配置文件加载文件树
 * */
export async function allAnalysis(config:AnalysisConfig[]):Promise<Folder>{
    const rootFolder:Folder = {children:[],name:"defaultRoot"};
    for (let configElement of config) {
        const f = await analysisAndDownProxy(configElement);
        let mountPath = configElement.mountPath || "";
        if(mountPath.startsWith("/")){
            mountPath = mountPath.substring(1);
        }
        if(mountPath.endsWith("/")){
            mountPath = mountPath.substring(0,mountPath.length-1);
        }
        if(mountPath) {
            const pathArray = mountPath.split("/");
            f.name = pathArray.pop()!;
            addFileToFileTree(rootFolder, pathArray, f);
        }else {
            abFolders(rootFolder, f);
        }
    }
    // 最后计算文件夹的大小和更新时间
    reCalcFolder(rootFolder);
    return rootFolder;
}