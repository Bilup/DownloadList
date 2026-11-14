import { defineClientConfig } from 'vuepress/client'
import Layout from "./layouts/Layout.vue";
import NotFound from "./layouts/NotFound.vue";
import Folder from "./layouts/Folder.vue";
import File from "./layouts/File.vue";
import "./css/main.css"

/**
 * 控制台欢迎语。
 *
 * 字符画为「双线空心 + 斜体」风格：
 *   竖笔画用两条平行线（`| |`）表示笔画的两侧，笔画内部是空的；
 *   横笔画用 `__` / `_` 表示上下两条边；
 *   整体逐行左移形成斜体，参照 Hydro 的写法。
 *
 * 用数组 + join 而不是模板字符串：模板字符串里的缩进会被原样打进输出，
 * 字符画一旦缩进错位就会散架。数组写法能保证每行的前导空格精确可控。
 */
if (!__VUEPRESS_SSR__) {
    console.log([
        "    _____                         _   _",
        "  |    /    _     _     _   _   |   |",
        " |    \\   / |   | |   |   |    |   |",
        "|    /   | |   | |   |   |    |___|",
        "|____/   | |   | |   |   |        |",
        "         \\_|   \\_|    \\___/"
    ].join("\n"));
    console.log("欢迎下载Bilup~🎉");
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