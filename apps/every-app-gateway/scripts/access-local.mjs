/**
 * A stand-in for Cloudflare Access on your machine, to try the gateway's
 * Access sign-in against a LOCAL gateway (docs/runbooks/cloudflare-access.md,
 * "Test locally"). It serves:
 *
 *  - an Access for SaaS OIDC application at
 *    /cdn-cgi/access/sso/oidc/<client id>: an authorization page where you
 *    pick the email to "log in" as, a token endpoint that checks the client
 *    secret and PKCE (S256), the JWKS and the discovery document;
 *  - the team domain's signing keys at /cdn-cgi/access/certs;
 *  - with --proxy-port, the outer ring: a reverse proxy in front of the
 *    gateway that asks who you are once per host (/cdn-cgi/access/login),
 *    sets a CF_Authorization cookie, then adds a signed
 *    Cf-Access-Jwt-Assertion to every request, as Access does.
 *    /cdn-cgi/access/logout forgets you. The paths the runbook says to
 *    bypass pass without the header (the browser's CF_Authorization cookie
 *    still goes along): on the gateway's host /mcp, /mcp/*, /oauth/token,
 *    /oauth/register, /.well-known/* and /api/deploy/*; on app hosts
 *    (<app>.localhost:<proxy port>) /mcp and /mcp/*. With --apps-aud, app
 *    hosts are a separate Access application with that AUD, as the runbook
 *    recommends.
 *
 * Usage (from apps/every-app-gateway; jose comes from its node_modules):
 *   node scripts/access-local.mjs [--port 19410] [--email you@example.com]
 *     [--proxy-port 19301 --gateway http://localhost:19300]
 *     [--apps-aud local-apps-aud]
 *
 * It prints the .dev.vars lines that point the gateway at it. With the
 * proxy, the gateway's GATEWAY_URL is the proxy's URL: the browser only ever
 * talks to the proxy, as it would to Access. Keys are new on every start.
 * Nothing here is for production: it signs whatever email you type.
 */
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "19410" },
    email: { type: "string", default: "" },
    "client-id": { type: "string", default: "local-access-client" },
    "client-secret": { type: "string", default: "local-access-secret" },
    aud: { type: "string", default: "local-access-aud" },
    "apps-aud": { type: "string" },
    label: { type: "string", default: "Company SSO (local)" },
    "proxy-port": { type: "string" },
    gateway: { type: "string" },
  },
});

const port = Number(args.port);
const team = `http://localhost:${port}`;
const clientId = args["client-id"];
const clientSecret = args["client-secret"];
const issuer = `${team}/cdn-cgi/access/sso/oidc/${clientId}`;
const oidcPath = new URL(issuer).pathname;
const proxyPort = args["proxy-port"] ? Number(args["proxy-port"]) : null;
const gateway = args.gateway ? new URL(args.gateway) : null;
if (proxyPort && !gateway) {
  console.error("--proxy-port needs --gateway <the gateway's vite dev URL>");
  process.exit(2);
}

async function signingKey() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const kid = randomBytes(8).toString("hex");
  return {
    privateKey,
    kid,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}
const teamKey = await signingKey();
const oidcKey = await signingKey();

function sign(key, claims) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iat: now, exp: now + 600, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .sign(key.privateKey);
}

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function send(res, status, body, headers = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, {
    "content-type": json ? "application/json" : "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function page(title, inner) {
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:12vh auto;padding:0 1rem}input,button{font:inherit;padding:.4rem;width:100%;margin:.3rem 0}</style>
<h1>${escape(title)}</h1>${inner}<p><small>Mock Cloudflare Access for local testing.</small></p>`;
}

// ---- The Access for SaaS OIDC application --------------------------------

const codes = new Map();

function loginForm(params) {
  const hidden = [...params]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`,
    )
    .join("");
  return page(
    "Sign in with mock Access",
    `<form method="post">${hidden}<label>Email<input name="email" type="email" required value="${escape(args.email)}" autofocus></label><button>Continue</button></form>`,
  );
}

async function authorization(req, res, url) {
  const params =
    req.method === "POST"
      ? new URLSearchParams(await readBody(req))
      : url.searchParams;
  if (params.get("client_id") !== clientId) {
    return send(res, 400, page("Unknown client", "<p>client_id</p>"));
  }
  if (
    params.get("response_type") !== "code" ||
    params.get("code_challenge_method") !== "S256" ||
    !params.get("code_challenge") ||
    !params.get("redirect_uri") ||
    !params.get("state")
  ) {
    return send(
      res,
      400,
      page(
        "Bad request",
        "<p>Needs code, PKCE (S256), redirect_uri, state.</p>",
      ),
    );
  }
  const email = params.get("email");
  if (req.method !== "POST" || !email) {
    params.delete("email");
    return send(res, 200, loginForm(params));
  }
  const code = randomBytes(16).toString("hex");
  codes.set(code, {
    email: email.trim(),
    redirectUri: params.get("redirect_uri"),
    challenge: params.get("code_challenge"),
  });
  const back = new URL(params.get("redirect_uri"));
  back.searchParams.set("code", code);
  back.searchParams.set("state", params.get("state"));
  res.writeHead(302, { location: back.toString() });
  res.end();
}

async function token(req, res) {
  const form = new URLSearchParams(await readBody(req));
  let id = form.get("client_id");
  let secret = form.get("client_secret");
  const basic = req.headers.authorization;
  if (basic?.startsWith("Basic ")) {
    [id, secret] = Buffer.from(basic.slice(6), "base64")
      .toString()
      .split(":")
      .map(decodeURIComponent);
  }
  if (id !== clientId || secret !== clientSecret) {
    return send(res, 401, { error: "invalid_client" });
  }
  const pending = codes.get(form.get("code") ?? "");
  codes.delete(form.get("code") ?? "");
  const challenge = createHash("sha256")
    .update(form.get("code_verifier") ?? "")
    .digest("base64url");
  if (
    !pending ||
    pending.redirectUri !== form.get("redirect_uri") ||
    pending.challenge !== challenge
  ) {
    return send(res, 400, { error: "invalid_grant" });
  }
  const idToken = await sign(oidcKey, {
    iss: issuer,
    aud: clientId,
    sub: randomUUID(),
    email: pending.email,
    email_verified: true,
    name: pending.email.split("@")[0],
  });
  send(res, 200, {
    access_token: randomBytes(24).toString("hex"),
    token_type: "Bearer",
    expires_in: 600,
    id_token: idToken,
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, team);
  try {
    if (url.pathname === "/cdn-cgi/access/certs") {
      return send(res, 200, { keys: [teamKey.jwk], public_certs: [] });
    }
    if (url.pathname === `${oidcPath}/jwks`) {
      return send(res, 200, { keys: [oidcKey.jwk] });
    }
    if (url.pathname === `${oidcPath}/.well-known/openid-configuration`) {
      return send(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorization`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === `${oidcPath}/authorization`) {
      return await authorization(req, res, url);
    }
    if (url.pathname === `${oidcPath}/token` && req.method === "POST") {
      return await token(req, res);
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    send(res, 500, { error: "mock_access_error" });
  }
}).listen(port, "127.0.0.1");

// ---- The outer ring: a reverse proxy that adds the assertion -------------

// What the runbook lets through without a login: machine endpoints only.
const GATEWAY_BYPASS = [
  /^\/mcp(\/|$)/,
  /^\/oauth\/(token|register)$/,
  /^\/\.well-known\//,
  /^\/api\/deploy\//,
];
const APP_BYPASS = [/^\/mcp(\/|$)/];
const COOKIE = "mock_access_email";
const SESSION_SECONDS = 24 * 60 * 60;

function cookieEmail(req) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

/** An application token for `email`, for the gateway's or the apps' AUD. */
async function assertionFor(email, aud, lifetime = 600) {
  const now = Math.floor(Date.now() / 1000);
  return sign(teamKey, {
    iss: team,
    aud: [aud],
    sub: createHash("sha256").update(email).digest("hex").slice(0, 32),
    email,
    type: "app",
    identity_nonce: randomBytes(8).toString("hex"),
    country: "XX",
    exp: now + lifetime,
  });
}

if (proxyPort) {
  const proxyHost = `localhost:${proxyPort}`;
  /** The gateway's host is the proxy's own; anything else is an app's. */
  const isGatewayHost = (req) => (req.headers.host ?? proxyHost) === proxyHost;
  const audFor = (req) =>
    isGatewayHost(req) ? args.aud : (args["apps-aud"] ?? args.aud);
  const forward = async (req, res, email) => {
    // The Host the browser asked for: the gateway's, or an app's
    // (todo.localhost:<proxy port>).
    const headers = { ...req.headers, host: req.headers.host ?? proxyHost };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("cf-access-")) delete headers[name];
    }
    if (email) {
      headers["cf-access-jwt-assertion"] = await assertionFor(
        email,
        audFor(req),
      );
      headers["cf-access-authenticated-user-email"] = email;
    }
    const upstream = httpRequest(
      {
        host: gateway.hostname,
        port: gateway.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => send(res, 502, { error: "gateway_down" }));
    req.pipe(upstream);
  };

  const proxy = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${proxyHost}`);
    if (url.pathname === "/cdn-cgi/access/login") {
      const email = url.searchParams.get("email");
      const next = url.searchParams.get("next") ?? "/";
      if (!email) {
        return send(
          res,
          200,
          page(
            "Cloudflare Access (mock)",
            `<form><input type="hidden" name="next" value="${escape(next)}"><label>Email<input name="email" type="email" required value="${escape(args.email)}" autofocus></label><button>Log in</button></form>`,
          ),
        );
      }
      // As Access does: CF_Authorization, the application token for this
      // host, which the browser also sends on the paths it bypasses.
      const token = await assertionFor(email, audFor(req), SESSION_SECONDS);
      res.writeHead(302, {
        "set-cookie": [
          `${COOKIE}=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax`,
          `CF_Authorization=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
        ],
        location: next.startsWith("/") ? next : "/",
      });
      return res.end();
    }
    if (url.pathname === "/cdn-cgi/access/logout") {
      return send(
        res,
        200,
        page(
          "Logged out of mock Access",
          '<p><a href="/">Log in again</a></p>',
        ),
        {
          "set-cookie": [
            `${COOKIE}=; Path=/; Max-Age=0`,
            "CF_Authorization=; Path=/; Max-Age=0",
          ],
        },
      );
    }
    const email = cookieEmail(req);
    const bypass = isGatewayHost(req) ? GATEWAY_BYPASS : APP_BYPASS;
    if (bypass.some((pattern) => pattern.test(url.pathname))) {
      return forward(req, res, null);
    }
    if (!email) {
      res.writeHead(302, {
        location: `/cdn-cgi/access/login?next=${encodeURIComponent(url.pathname + url.search)}`,
      });
      return res.end();
    }
    return forward(req, res, email);
  });

  // Vite's hot-reload WebSocket.
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = connect(Number(gateway.port), gateway.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries({
        ...req.headers,
        host: req.headers.host ?? proxyHost,
      })) {
        lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  proxy.listen(proxyPort, "127.0.0.1");
}

console.log(`Mock Cloudflare Access on ${team}`);
if (proxyPort) {
  console.log(
    `Outer ring: http://${`localhost:${proxyPort}`} -> ${gateway.origin}`,
  );
}
console.log("\nPut these in apps/every-app-gateway/.dev.vars:\n");
if (proxyPort) console.log(`GATEWAY_URL=http://localhost:${proxyPort}`);
console.log(`CLOUDFLARE_ACCESS_OIDC_ISSUER=${issuer}`);
console.log(`CLOUDFLARE_ACCESS_OIDC_CLIENT_ID=${clientId}`);
console.log(`CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET=${clientSecret}`);
console.log(`CLOUDFLARE_ACCESS_OIDC_LABEL=${args.label}`);
console.log(`CLOUDFLARE_ACCESS_TEAM_DOMAIN=${team}`);
console.log(`CLOUDFLARE_ACCESS_AUD=${args.aud}`);
if (args["apps-aud"]) {
  console.log(`CLOUDFLARE_ACCESS_APPS_AUD=${args["apps-aud"]}`);
}
