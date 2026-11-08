import { viteBundler } from '@vuepress/bundler-vite'
import { defineUserConfig } from 'vuepress'
import { FileList } from './src/node/index.js'
import { githubReleasesFilesAnalysis } from "./src/node/analysis/githubReleasesFilesAnalysis/index.js";
import { cloudflarePagesDownProxy } from "./src/node/proxy/cloudflarePagesDownProxy/index.js";
import { fileUrlTreeAnalysis } from "./src/node/analysis/fileUrlTreeAnalysis/index.js";
import { huggingFaceDatasetsAnalysis } from "./src/node/analysis/huggingFaceDatasetsAnalysis/index.js";
import { vercelDownProxy } from './src/node/proxy/vercelDownProxy/index.js';
import { netlifyDownProxy } from './src/node/proxy/netlifyDownProxy/index.js';
import { giteeReleasesFilesAnalysis } from './src/node/analysis/giteeReleasesFilesAnalysis/index.js';
import { githubReposAnalysis } from './src/node/analysis/githubReposAnalysis/index.js';
import { giteeReposAnalysis } from './src/node/analysis/giteeReposAnalysis/index.js';

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
      downProxy: cloudflarePagesDownProxy(),
      hideReadme: true,
    },
  ])
})
