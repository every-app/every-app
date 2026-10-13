/**
 * Walk a LOCAL gateway's MCP connector through OAuth the way an MCP client
 * does, playing the browser too: discovery, dynamic registration (as Codex
 * registers) or a client ID metadata document (--cimd), authorize, consent,
 * token, tools/list and tools/call on both protocol eras, refresh,
 * revocation. With --conformance it then runs the MCP conformance suite's
 * authorization-server scenarios against the same gateway, completing their
 * browser step the same way.
 *
 * The gateway must run on exactly http://localhost:<port> or
 * http://127.0.0.1:<port> (OAuth accepts no other http issuer), with that
 * origin as its GATEWAY_URL. See docs/runbooks/mcp-oauth.md, "Test locally".
 *
 * Usage (from apps/every-app-gateway, the gateway running):
 *   EVERYAPP_EMAIL=you@example.com EVERYAPP_PASSWORD=… \
 *     node scripts/mcp-oauth-local.mjs --gateway http://localhost:19300 \
 *     [--org <slug>] [--read-only] [--conformance] \
 *     [--cimd <client id URL> --redirect-uri <one its document lists>]
 *
 * --cimd connects as a public client with a metadata document instead of
 * registering one; the gateway fetches the document from the internet, so
 * it must be a public https URL (Claude Code's, for one, lists loopback
 * redirect URIs on any port: http://localhost:<port>/callback).
 *
 * Prints what each step returned, never a token or secret.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { parseArgs } from "node:util";

const CONFORMANCE_SUITE = "@modelcontextprotocol/conformance@0.2.0-alpha.12";
const CALLBACK = "http://localhost:1455/auth/callback";
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

const { values: args } = parseArgs({
  options: {
    gateway: { type: "string", default: process.env.GATEWAY_URL },
    org: { type: "string" },
    "read-only": { type: "boolean", default: false },
    conformance: { type: "boolean", default: false },
    cimd: { type: "string" },
    "redirect-uri": { type: "string" },
  },
});
const gateway = (args.gateway ?? "").replace(/\/$/, "");
const email = process.env.EVERYAPP_EMAIL;
const password = process.env.EVERYAPP_PASSWORD;
if (!gateway || !email || !password || (args.cimd && !args["redirect-uri"])) {
  console.error(
    "Usage: EVERYAPP_EMAIL=… EVERYAPP_PASSWORD=… node scripts/mcp-oauth-local.mjs --gateway http://localhost:<port> [--org <slug>] [--read-only] [--conformance] [--cimd <client id URL> --redirect-uri <URI>]",
  );
  process.exit(2);
}
const resource = `${gateway}/mcp`;

let failures = 0;
function step(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** The browser's cookie jar. */
const cookies = new Map();
function absorb(response) {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair, ...attributes] = cookie.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    if (attributes.some((part) => /^\s*max-age=0\s*$/i.test(part))) {
      cookies.delete(name);
    } else {
      cookies.set(name, pair.slice(separator + 1));
    }
  }
  return response;
}
const cookieHeader = () =>
  [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");

async function browser(path, init = {}) {
  return absorb(
    await fetch(new URL(path, gateway), {
      redirect: "manual",
      ...init,
      headers: { cookie: cookieHeader(), ...init.headers },
    }),
  );
}

async function signIn() {
  const response = await browser("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: gateway },
    body: JSON.stringify({ email, password }),
  });
  step("sign in", response.ok, `HTTP ${response.status}`);
  if (!response.ok) process.exit(1);

  const organizations = await (
    await browser("/api/auth/organization/list")
  ).json();
  const organization = args.org
    ? organizations.find((org) => org.slug === args.org)
    : organizations[0];
  step(
    "pick an organization",
    Boolean(organization),
    organization ? organization.name : "none found",
  );
  if (!organization) process.exit(1);
  return organization.id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function registerClient(redirectUri) {
  // As Codex registers: no token_endpoint_auth_method.
  const response = await fetch(`${gateway}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Every App local test client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const client = await response.json();
  step(
    "register a client (DCR)",
    response.status === 201 && client.token_endpoint_auth_method === "none",
    `HTTP ${response.status}, token_endpoint_auth_method ${client.token_endpoint_auth_method}`,
  );
  return client;
}

/** Play the browser from an authorization URL to the client's callback. */
async function authorizeAndConsent(authorizationUrl, organizationId) {
  const url = new URL(authorizationUrl);
  const authorize = await browser(`${url.pathname}${url.search}`);
  const consent = new URL(authorize.headers.get("location") ?? "/", gateway);
  step(
    "authorize → consent page",
    authorize.status === 302 && consent.pathname === "/oauth/consent",
    `HTTP ${authorize.status} → ${consent.pathname}, ${authorize.headers.get("cache-control")}, ${authorize.headers.get("x-frame-options")}`,
  );
  const decision = await browser("/oauth/consent/decision", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: gateway,
      "sec-fetch-site": "same-origin",
    },
    body: new URLSearchParams({
      handle: consent.searchParams.get("handle") ?? "",
      decision: "approve",
      client_id: url.searchParams.get("client_id") ?? "",
      redirect_uri: url.searchParams.get("redirect_uri") ?? "",
      organization_id: organizationId,
      app_mode: "all",
      access: args["read-only"] ? "read" : "write",
    }),
  });
  const callback = new URL(decision.headers.get("location") ?? "about:blank");
  step(
    "approve consent → client callback",
    decision.status === 302 && callback.searchParams.has("code"),
    `HTTP ${decision.status} → ${callback.origin}${callback.pathname}, iss ${callback.searchParams.get("iss")}`,
  );
  return callback;
}

async function token(params) {
  const response = await fetch(`${gateway}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  // A revocation answers 200 with no body.
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

let requestId = 0;
async function mcp(accessToken, method, params = {}, era = MODERN) {
  const name = typeof params.name === "string" ? params.name : null;
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(method === "initialize" ? {} : { "mcp-protocol-version": era }),
    ...(era === MODERN ? { "mcp-method": method } : {}),
    ...(era === MODERN && name ? { "mcp-name": name } : {}),
  };
  const meta = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "local-test", version: "1" },
  };
  const response = await fetch(resource, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: (requestId += 1),
      method,
      params: era === MODERN ? { ...params, _meta: meta } : params,
    }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function discover() {
  const challenge = await fetch(resource, { method: "POST" });
  const header = challenge.headers.get("www-authenticate") ?? "";
  step(
    "401 names the resource metadata",
    challenge.status === 401 &&
      header.includes(
        `resource_metadata="${gateway}/.well-known/oauth-protected-resource/mcp"`,
      ),
    header,
  );
  const prm = await (
    await fetch(`${gateway}/.well-known/oauth-protected-resource/mcp`)
  ).json();
  step(
    "protected resource metadata",
    prm.resource === resource && prm.authorization_servers?.[0] === gateway,
    `resource ${prm.resource}`,
  );
  const as = await (
    await fetch(`${gateway}/.well-known/oauth-authorization-server`)
  ).json();
  step(
    "authorization server metadata",
    as.issuer === gateway &&
      as.token_endpoint_auth_methods_supported?.includes("none"),
    `CIMD ${as.client_id_metadata_document_supported}, auth methods ${as.token_endpoint_auth_methods_supported?.join(" ")}`,
  );
}

async function walkTheFlow(organizationId) {
  const callbackUri = args.cimd ? args["redirect-uri"] : CALLBACK;
  const client = args.cimd
    ? { client_id: args.cimd }
    : await registerClient(CALLBACK);
  const { verifier, challenge } = pkce();
  const authorizationUrl = `${gateway}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: callbackUri,
    scope: "mcp:read offline_access",
    state: "local-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  })}`;
  const callback = await authorizeAndConsent(authorizationUrl, organizationId);

  const issued = await token({
    grant_type: "authorization_code",
    code: callback.searchParams.get("code") ?? "",
    redirect_uri: callbackUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource,
  });
  step(
    "exchange the code",
    issued.status === 200,
    `HTTP ${issued.status}, scope "${issued.body.scope}", expires_in ${issued.body.expires_in}`,
  );
  const access = issued.body.access_token;

  const listed = await mcp(access, "tools/list");
  const names = listed.body?.result?.tools?.map((tool) => tool.name) ?? [];
  step(`tools/list (${MODERN})`, listed.status === 200, names.join(", "));
  const whoami = await mcp(access, "tools/call", {
    name: "everyapp_whoami",
    arguments: {},
  });
  step(
    "tools/call everyapp_whoami",
    whoami.status === 200 && !whoami.body?.result?.isError,
    JSON.stringify(whoami.body?.result?.structuredContent ?? whoami.body),
  );
  const init = await mcp(
    access,
    "initialize",
    {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: "local-test", version: "1" },
    },
    LEGACY,
  );
  step(
    `initialize (${LEGACY})`,
    init.body?.result?.protocolVersion === LEGACY,
    init.body?.result?.serverInfo?.title,
  );
  const legacyList = await mcp(access, "tools/list", {}, LEGACY);
  step(
    `tools/list (${LEGACY})`,
    legacyList.status === 200,
    `${legacyList.body?.result?.tools?.length} tools`,
  );
  const legacyCall = await mcp(
    access,
    "tools/call",
    { name: "everyapp_whoami", arguments: {} },
    LEGACY,
  );
  step(
    `tools/call everyapp_whoami (${LEGACY})`,
    legacyCall.status === 200 && !legacyCall.body?.result?.isError,
    `access ${legacyCall.body?.result?.structuredContent?.connection?.access}`,
  );

  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: issued.body.refresh_token,
    client_id: client.client_id,
  });
  step(
    "refresh with client_id only",
    refreshed.status === 200 &&
      refreshed.body.access_token !== issued.body.access_token,
    `HTTP ${refreshed.status}, scope "${refreshed.body.scope}"`,
  );
  const afterRefresh = await mcp(refreshed.body.access_token, "tools/list");
  step("tools/list with the new token", afterRefresh.status === 200);

  const revoked = await token({
    token: refreshed.body.refresh_token,
    client_id: client.client_id,
  });
  const afterRevoke = await mcp(refreshed.body.access_token, "tools/list");
  step(
    "revoke → /mcp refuses the token",
    revoked.status === 200 && afterRevoke.status === 401,
    `revocation HTTP ${revoked.status}, then /mcp HTTP ${afterRevoke.status}`,
  );
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The suite's authorization-server scenarios: metadata, then a full code
 * grant whose browser step this script completes.
 */
async function conformance(organizationId) {
  const port =
    Number(process.env.CONFORMANCE_CALLBACK_PORT) || (await freePort());
  const client = await registerClient(`http://127.0.0.1:${port}/callback`);
  const suite = spawn(
    "npx",
    [
      "-y",
      CONFORMANCE_SUITE,
      "authorization",
      "--url",
      gateway,
      "--client-id",
      client.client_id,
      "--resource",
      resource,
      "--port",
      String(port),
      "--spec-version",
      MODERN,
    ],
    { env: { ...process.env, NO_COLOR: "1" } },
  );
  let output = "";
  let handled = false;
  const onOutput = (chunk) => {
    output += chunk;
    const match = /^(http\S+\/oauth\/authorize\?\S+)$/m.exec(output);
    if (match && !handled) {
      handled = true;
      void authorizeAndConsent(match[1], organizationId).then((callback) =>
        // Deliver the code to the suite's own callback server.
        fetch(callback),
      );
    }
  };
  suite.stdout.on("data", onOutput);
  suite.stderr.on("data", onOutput);
  const code = await new Promise((resolve) => suite.on("close", resolve));
  console.log(
    output
      .split("\n")
      .filter((line) => /passed|failed|✓|✗|SUCCESS|FAILURE|WARNING/i.test(line))
      .join("\n"),
  );
  step(
    "conformance: authorization server scenarios",
    code === 0,
    `exit ${code}`,
  );
}

await discover();
const organizationId = await signIn();
await walkTheFlow(organizationId);
if (args.conformance) await conformance(organizationId);
console.log(failures ? `\n${failures} step(s) failed` : "\nAll steps passed");
process.exit(failures ? 1 : 0);
