import { defineUserConfig } from "vuepress";
import { FileList } from "vuepress-theme-flist";

export default defineUserConfig({
  lang: "zh-CN",
  title: "DLGrass",
  description: "我的文件列表",

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
