import { viteBundler } from '@vuepress/bundler-vite'
import { defineUserConfig } from 'vuepress'
import { FileList } from './src/node/index.js'
import { githubReleasesFilesAnalysis } from "./src/node/analysis/githubReleasesFilesAnalysis/index.js";
import cloudflarePagesDownProxy from "./src/node/proxy/cloudflarePagesDownProxy/index.js";

export default defineUserConfig({
  bundler: viteBundler(),
  pagePatterns: [],
  lang: 'zh-CN',
  public: `./public`,
  title: 'Bilup',
  description: 'Bilup - 更好的Turbowarp',
  head: [['link', { rel: 'icon', href: '/Logo.svg' }]],
  shouldPrefetch: true,
  theme: FileList([
    {
      mountPath: "/",
      analysis: githubReleasesFilesAnalysis({
        user: "Bilup",
        repository: "desktop",
        authorizationToken: process.env.githubToken,
        per_page: 10,
      }),
      hideReadme: true, // 隐藏 README
      downProxy: cloudflarePagesDownProxy(), // 代理正常使用
    },
  ])
})
