import { defineUserConfig } from "vuepress";
import { FileList } from "vuepress-theme-flist";

export default defineUserConfig({
  lang: "zh-CN",
  title: "Bilup下载中心",
  description: "Bilup客户端官方下载中心",

  theme: FileList([
    {
      mountPath: "/BilupDesktop",
      analysis: githubReleasesFilesAnalysis({
        user: "Bilup",
        repository: "desktop",
      }),
      hideReadme: true,
      downProxy: cloudflarePagesDownProxy(),
    },
  ]),
});
