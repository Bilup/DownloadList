{
  mountPath: "/BilupDesktop",
  analysis: githubReposAnalysis({
    user: "Bilup",
    repository: "desktop",
    hideReadme: true
  }),
  downProxy: cloudflarePagesDownProxy(),
}
