import {App, Theme,} from "vuepress";
import { getDirname, path } from 'vuepress/utils'
import {createFileTreePages} from "./base/pages.js";
import {allAnalysis} from "./base/AllAnalysis.js";
import {
    callExtendsBundlerOptions,
    callOnGenerated,
    callOnInitialized,
    callOnWatched,
    Closable
} from "./base/eventManager.js";
import {nprogressPlugin} from "@vuepress/plugin-nprogress";
import { loadAnalysisConfigFromDir } from "./config/loadAnalysisConfigFromDir.js";

const __dirname = getDirname(import.meta.url)

export function FileList():Theme{
    return ()=>{
        return {
            name:"Bilup",
            clientConfigFile: path.join(__dirname, "../client/index.ts"),
            plugins: [
                nprogressPlugin()
            ],
            onInitialized:async (app)=>{
                await callOnInitialized(app);
                const analysisConfig = loadAnalysisConfigFromDir("mounts");
                const fileTree = await allAnalysis(analysisConfig);
                const pageList = await Promise.all(createFileTreePages(app,fileTree));
                app.pages.push(...pageList);
            },
            onGenerated:async (app)=>{
                await callOnGenerated(app);
            },
            onWatched:async (app: App, watchers: Closable[], restart: () => Promise<void>)=>{
                await callOnWatched(app, watchers, restart);
            },
            extendsBundlerOptions: async (options,app)=>{
                await callExtendsBundlerOptions(options,app);
            }
        }
    }
}
