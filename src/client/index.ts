import { defineClientConfig } from 'vuepress/client'
import Layout from "./layouts/Layout.vue";
import NotFound from "./layouts/NotFound.vue";
import Folder from "./layouts/Folder.vue";
import File from "./layouts/File.vue";
import "./css/main.css"

if (!__VUEPRESS_SSR__) {
    console.log("欢迎下载Bilup🎉");
}
export default defineClientConfig({
    enhance({ app, router, siteData }) {},
    setup() {},
    rootComponents: [],
    layouts:{
        Layout,
        NotFound,
        File,
        Folder
    }
})