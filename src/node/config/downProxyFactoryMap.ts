import { DownProxy } from "../base/AllAnalysis.js";

type ProxyModule = { default?: () => DownProxy };

function downProxyModuleLoader(moduleLoader: () => Promise<ProxyModule>): (options: any) => DownProxy {
  let mod: DownProxy | undefined;
  let loading: Promise<DownProxy> | undefined;

  return () => {
    return async (sourceUrl, fileName, contentType, assetId) => {
      if (!mod) {
        if (!loading) {
          loading = (async () => {
            const c = await moduleLoader();
            if (!c.default) throw new Error("downProxy 模块未导出 default");
            return c.default();
          })();
        }
        mod = await loading;
      }
      return mod(sourceUrl, fileName, contentType, assetId);
    };
  };
}

export const downProxyFactoryMap: Record<string, (options: any) => DownProxy> = {
  cloudflarePagesDownProxy: downProxyModuleLoader(() => import("../proxy/cloudflarePagesDownProxy/index.js")),
  vercelDownProxy: downProxyModuleLoader(() => import("../proxy/vercelDownProxy/index.js")),
  netlifyDownProxy: downProxyModuleLoader(() => import("../proxy/netlifyDownProxy/index.js")),
};
