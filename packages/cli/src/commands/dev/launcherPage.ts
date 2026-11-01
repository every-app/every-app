/** Minimal launcher page served at the bare base host in stub mode. */
export function devLauncherHtml(
  appId: string,
  appName: string | undefined,
  host: string,
): string {
  const label = appName ?? appId;
  return [
    "<!doctype html><html><head><meta charset=utf-8>",
    "<title>every app — dev launcher</title>",
    "<style>body{font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}a{color:#0a7;font-size:1.25rem}p{color:#666}</style>",
    "</head><body>",
    "<h1>every app <small style='color:#999;font-weight:400'>dev launcher</small></h1>",
    "<p>Signed in as <code>dev@everyapp.localhost</code> (seeded dev user — stub mode).</p>",
    `<p><a href="http://${appId}.${host}/">${label} →</a></p>`,
    "</body></html>",
  ].join("");
}
