#!/usr/bin/env node
/**
 * The `curl` the setup-skill harness puts on the agent's PATH (run.mjs
 * writes a bin/curl that execs this with SETUP_SKILLS_RUN set). The
 * Gateway's host and the app hosts answer from the run's state.json the
 * way the setup files say a live Gateway does: `/.well-known/*` is the
 * OAuth discovery document (200 JSON), `/mcp` wants a token (401 JSON), and
 * everything else is the Gateway's page, or Access's login redirect (302 to
 * `<team>.cloudflareaccess.com/cdn-cgi/access/login/...`) once `access on`
 * has run. Any other host fails to resolve, as a machine with no network
 * would, so a provider is never reached from here. Understood: `-o`,
 * `-w` (%{http_code}, %{response_code}, %{content_type}, %{redirect_url},
 * %{url_effective}, %{size_download}), `-I`, `-L`, `-f`; the rest of
 * curl's flags are accepted and ignored. Every call is logged to
 * other-commands.log.
 */
import fs from "node:fs";
import path from "node:path";

const runDir = process.env["SETUP_SKILLS_RUN"];
if (!runDir) {
  process.stderr.write("fake curl: SETUP_SKILLS_RUN isn't set (run it through the harness's bin shim)\n");
  process.exit(70);
}
const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));

/** Flags that take a value, so the value isn't read as the URL. */
const VALUE_FLAGS = new Set([
  "-o", "--output", "-w", "--write-out", "-H", "--header", "-X", "--request", "-d", "--data", "--data-raw",
  "--data-binary", "--data-urlencode", "-m", "--max-time", "--connect-timeout", "-u", "--user", "-A", "--user-agent",
  "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "--retry", "--retry-delay", "--resolve", "-T", "--upload-file",
  "-F", "--form", "--max-redirs", "--cacert", "--proto", "--url",
]);
const options = { output: null, writeOut: null, head: false, follow: false, fail: false, url: null };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("-")) {
    options.url ??= arg;
    continue;
  }
  if (arg.startsWith("--")) {
    const [flag, inline] = arg.split(/=(.*)/s);
    const value = VALUE_FLAGS.has(flag) ? (inline ?? argv[++i]) : null;
    if (flag === "--output") options.output = value;
    else if (flag === "--write-out") options.writeOut = value;
    else if (flag === "--head") options.head = true;
    else if (flag === "--location") options.follow = true;
    else if (flag === "--fail") options.fail = true;
    else if (flag === "--url") options.url ??= value;
    continue;
  }
  // Short flags, possibly combined (-sS, -sSL, -sSo file): a value flag takes the rest or the next argument.
  for (let j = 1; j < arg.length; j++) {
    const flag = `-${arg[j]}`;
    if (VALUE_FLAGS.has(flag)) {
      const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i];
      if (flag === "-o") options.output = value;
      else if (flag === "-w") options.writeOut = value;
      break;
    }
    if (flag === "-I") options.head = true;
    else if (flag === "-L") options.follow = true;
    else if (flag === "-f") options.fail = true;
  }
}

if (!options.url) {
  process.stderr.write("curl: try 'curl --help' for more information\n");
  log("(no url)");
  process.exit(2);
}
let url;
try {
  url = new URL(options.url.includes("://") ? options.url : `https://${options.url}`);
} catch {
  process.stderr.write(`curl: (3) URL rejected: ${options.url}\n`);
  log("(bad url)");
  process.exit(3);
}

const host = url.hostname.toLowerCase();
const gatewayHost = (state.gatewayUrl ?? "https://gateway.invalid").replace(/^https?:\/\//, "").toLowerCase();
const base = (state.appBaseDomain ?? "").toLowerCase();
const app = (state.apps ?? []).find((candidate) => `${candidate.id}.${base}` === host) ?? null;
if (host !== gatewayHost && !app) {
  process.stderr.write(`curl: (6) Could not resolve host: ${host}\n`);
  log("(unresolved: no network in the setup-skill harness)");
  process.exit(6);
}

const access = state.access ?? { on: false, team: null };
const where = app ? `${app.name ?? app.id}` : "EveryApp";
let response;
if (host === gatewayHost && url.pathname.startsWith("/.well-known/")) {
  response = {
    status: 200,
    type: "application/json",
    body: JSON.stringify({
      issuer: `https://${gatewayHost}`,
      authorization_endpoint: `https://${gatewayHost}/oauth/authorize`,
      token_endpoint: `https://${gatewayHost}/oauth/token`,
      registration_endpoint: `https://${gatewayHost}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    }),
  };
} else if (host === gatewayHost && /^\/mcp(?:\/|$)/.test(url.pathname)) {
  response = { status: 401, type: "application/json", body: JSON.stringify({ error: "unauthorized", error_description: "A bearer token is required" }), headers: { "www-authenticate": `Bearer resource_metadata="https://${gatewayHost}/.well-known/oauth-protected-resource"` } };
} else if (access.on && access.team) {
  const kid = app ? "b".repeat(64) : "a".repeat(64);
  const login = `https://${access.team}.cloudflareaccess.com/cdn-cgi/access/login/${host}?kid=${kid}&redirect_url=${encodeURIComponent(url.pathname + url.search)}&meta=eyJraWQiOiJmYWtlIn0`;
  response = options.follow
    ? { status: 200, type: "text/html; charset=utf-8", body: `<!DOCTYPE html><html><head><title>Cloudflare Access</title></head><body>Sign in to ${access.team}</body></html>`, effective: login }
    : { status: 302, type: "text/html", body: "", redirect: login, headers: { location: login } };
} else {
  response = { status: 200, type: "text/html; charset=utf-8", body: `<!DOCTYPE html><html><head><title>${where}</title></head><body>Sign in</body></html>` };
}

if (options.head) {
  const headers = { "content-type": response.type, ...(response.headers ?? {}) };
  process.stdout.write(`HTTP/2 ${response.status}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
} else if (options.output) {
  if (options.output !== "/dev/null") fs.writeFileSync(options.output, response.body);
} else {
  process.stdout.write(response.body);
}
if (options.writeOut) {
  const values = {
    http_code: String(response.status),
    response_code: String(response.status),
    content_type: response.type,
    redirect_url: response.redirect ?? "",
    url_effective: response.effective ?? url.href,
    size_download: String(Buffer.byteLength(response.body)),
    http_version: "2",
    exitcode: "0",
    time_total: "0.123456",
    remote_ip: "104.16.0.1",
  };
  const text = options.writeOut
    .replace(/%\{([a-z_]+)\}/g, (_, name) => values[name] ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r");
  process.stdout.write(text);
}
const failed = options.fail && response.status >= 400;
if (failed) process.stderr.write(`curl: (22) The requested URL returned error: ${response.status}\n`);
log(`-> ${response.status} ${response.type}${response.redirect ? ` ${response.redirect.replace(/kid=[^&]*/, "kid=…")}` : ""}`);
process.exit(failed ? 22 : 0);

function log(note) {
  fs.appendFileSync(path.join(runDir, "other-commands.log"), `${new Date().toISOString()} curl ${argv.join(" ")} ${note}\n`);
}
