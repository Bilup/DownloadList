import { defineUserConfig } from "vuepress";
import { FileList } from "vuepress-theme-flist";

export default defineUserConfig({
  lang: "zh-CN",
  title: "Bilup Desktop",
  description: "Bilup客户端官方下载站",

  theme: FileList({
    logo: "/Logo.svg",
    
    fileList: [
      {
        mountPath: "/BilupDesktop",
        analysis: githubReleasesFilesAnalysis({
          user: "Bilup",
          repository: "desktop",
        }),
        hideReadme: true,
        downProxy: cloudflarePagesDownProxy(),
      },
    ],
  }),
});
