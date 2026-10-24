/**
 * The `oauth_client` capability end to end through the AppGateway
 * entrypoint: the token endpoint calls it completes, the client it puts on
 * them, and everything it refuses.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mintIdentityJwt } from "@every-app/sdk/internal";
import { InMemoryAppRegistry, type RegisteredApp } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
  type AppCallerProps,
} from "@/server/app-gateway-entrypoint";

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = keys.privateKey;
  publicKeyPem = keys.publicKey;
});

const PROPS: AppCallerProps = {
  organizationId: "org-1",
  appId: "postiz",
  workerName: "every-acme-postiz",
};
const POSTIZ = {
  capabilities: {
    linkedin: { access: "write", why: "Connects LinkedIn channels." },
    reddit: { access: "write" },
    facebook: { access: "write" },
    instagram: { access: "write" },
    tiktok: { access: "write" },
    "tiktok-business": { access: "write" },
    mastodon: { access: "write" },
  },
};
/** The gateway's clients: what upstream must see, and no log ever. */
const CLIENTS = {
  LINKEDIN_CLIENT_ID: "gw-linkedin-id",
  LINKEDIN_CLIENT_SECRET: "gw-linkedin-secret",
  REDDIT_CLIENT_ID: "gw-reddit-id",
  REDDIT_CLIENT_SECRET: "gw-reddit-secret",
  FACEBOOK_APP_ID: "gw-facebook-id",
  FACEBOOK_APP_SECRET: "gw-facebook-secret",
  INSTAGRAM_APP_ID: "gw-instagram-id",
  INSTAGRAM_APP_SECRET: "gw-instagram-secret",
  TIKTOK_CLIENT_ID: "gw-tiktok-key",
  TIKTOK_CLIENT_SECRET: "gw-tiktok-secret",
  TIKTOK_BUSINESS_CLIENT_ID: "gw-tiktok-business-id",
  TIKTOK_BUSINESS_CLIENT_SECRET: "gw-tiktok-business-secret",
  MASTODON_CLIENT_ID: "gw-mastodon-id",
  MASTODON_CLIENT_SECRET: "gw-mastodon-secret",
};
const LINKEDIN =
  "/api/integrations/linkedin/www.linkedin.com/oauth/v2/accessToken";
const FORM = "application/x-www-form-urlencoded";
/** A token response: it reaches the app, never a log. */
const TOKENS = {
  access_token: "user-access-token-123",
  refresh_token: "user-refresh-token-456",
  expires_in: 3600,
};

let log: ReturnType<typeof vi.spyOn>;
let upstream: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;
/** Each request upstream saw, read once: URL, method, headers, body. */
let seen: {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  redirect: string;
}[];

beforeEach(() => {
  clearAppCallerCacheForTests();
  seen = [];
  upstream = vi.fn(async (request: Request) => {
    seen.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      redirect: request.redirect,
    });
    return Response.json(TOKENS, {
      headers: {
        "set-cookie": "provider_session=1; Secure",
        "x-provider": "1",
      },
    });
  });
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function app(manifest: Record<string, unknown> = POSTIZ): RegisteredApp {
  return {
    appId: "postiz",
    hostname: "postiz.example.com",
    workerName: "every-acme-postiz",
    tier: "service_binding",
    scope: "org",
    organizationId: "org-1",
    status: "active",
    // Tolerant, as the registry reads a deployed row.
    manifest: validateManifest({ id: "postiz", ...manifest }),
  };
}

function call(
  path: string,
  options: {
    method?: string;
    body?: BodyInit | null;
    headers?: Record<string, string>;
    manifest?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const method = options.method ?? "POST";
  return handleAppGatewayRequest({
    request: new Request(`http://every-app-gateway.internal${path}`, {
      method,
      headers: options.headers,
      body: method === "GET" ? undefined : (options.body ?? null),
      ...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
    props: PROPS,
    registry: new InMemoryAppRegistry([app(options.manifest)]),
    env: {
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      JWT_PUBLIC_KEY: publicKeyPem,
      GATEWAY_URL: "https://home.example.com",
      ...CLIENTS,
      ...options.env,
    },
    organizations: { isAttributable: async () => true },
    fetchUpstream: upstream,
  });
}

async function expectRefusal(
  response: Promise<Response>,
  status: number,
  code: string,
): Promise<Record<string, unknown>> {
  const refused = await response;
  expect(refused.status).toBe(status);
  expect(refused.headers.get("x-everyapp-error")).toBe(code);
  const body = (await refused.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ code });
  return body;
}

function identity(channel: "web" | "mcp", scopes?: string[]): Promise<string> {
  return mintIdentityJwt(privateKeyPem, {
    subject: {
      sub: "user-1",
      email: "user@example.com",
      orgId: "org-1",
      orgRole: "member",
    },
    audience: "every-acme-postiz",
    issuer: "https://home.example.com",
    channel,
    ...(scopes ? { scopes } : {}),
  });
}

function logLines(): string[] {
  return log.mock.calls.map(([line]: unknown[]) => String(line));
}

function proxyLogs(): Record<string, unknown>[] {
  return logLines()
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["evt"] === "integration.proxy.call");
}

/** What the app smuggles along: none of it may reach the provider. */
const APP_CLIENT = /app-(id|secret)|Basic YXBw/;

describe("token endpoint calls", () => {
  it("form: LinkedIn gets the gateway's client in the body, never the app's", async () => {
    const response = await call(LINKEDIN, {
      headers: {
        "content-type": FORM,
        authorization: "Basic YXBwOmFwcA==",
        cookie: "a=b",
        "x-everyapp-identity": await identity("web"),
      },
      body: "grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fpostiz.example.com%2Fintegrations%2Fsocial%2Flinkedin&client_id=app-id&client_secret=app-secret",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(TOKENS);
    const [sent] = seen;
    expect(sent?.url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(Object.fromEntries(new URLSearchParams(sent?.body))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://postiz.example.com/integrations/social/linkedin",
      client_id: "gw-linkedin-id",
      client_secret: "gw-linkedin-secret",
    });
    expect(sent?.headers.get("authorization")).toBeNull();
    expect(sent?.headers.get("cookie")).toBeNull();
    expect(sent?.headers.get("x-everyapp-identity")).toBeNull();
    expect(JSON.stringify(sent)).not.toMatch(APP_CLIENT);
    // Never following a redirect with the client on it.
    expect(sent?.redirect).toBe("manual");
  });

  it("form: TikTok gets its client id as client_key", async () => {
    await call("/api/integrations/tiktok/open.tiktokapis.com/v2/oauth/token/", {
      headers: { "content-type": FORM },
      body: "client_key=app-id&client_secret=app-secret&grant_type=refresh_token&refresh_token=r",
    });
    const params = new URLSearchParams(seen[0]?.body);
    expect(params.getAll("client_key")).toEqual(["gw-tiktok-key"]);
    expect(params.getAll("client_secret")).toEqual(["gw-tiktok-secret"]);
    expect(params.has("client_id")).toBe(false);
    expect(seen[0]?.body).not.toMatch(APP_CLIENT);
  });

  it("basic: Reddit gets HTTP Basic with the gateway's client, and no client in the body", async () => {
    await call("/api/integrations/reddit/www.reddit.com/api/v1/access_token", {
      headers: { "content-type": FORM, authorization: "Basic YXBwOmFwcA==" },
      body: "grant_type=refresh_token&refresh_token=r&client_secret=app-secret",
    });
    const [sent] = seen;
    expect(sent?.headers.get("authorization")).toBe(
      `Basic ${btoa("gw-reddit-id:gw-reddit-secret")}`,
    );
    expect(sent?.body).toBe("grant_type=refresh_token&refresh_token=r");
    expect(JSON.stringify([...sent!.headers, sent!.body])).not.toMatch(
      APP_CLIENT,
    );
  });

  it("query: Meta gets the client in the query string, on any Graph API version", async () => {
    const response = await call(
      "/api/integrations/facebook/graph.facebook.com/v25.0/oauth/access_token?client_id=app-id&client_secret=app-secret&redirect_uri=https%3A%2F%2Fpostiz.example.com%2Fcb&code=c",
      { method: "GET" },
    );
    expect(response.status).toBe(200);
    const sent = new URL(seen[0]!.url);
    expect(sent.origin + sent.pathname).toBe(
      "https://graph.facebook.com/v25.0/oauth/access_token",
    );
    expect(sent.searchParams.getAll("client_id")).toEqual(["gw-facebook-id"]);
    expect(sent.searchParams.getAll("client_secret")).toEqual([
      "gw-facebook-secret",
    ]);
    expect(sent.searchParams.get("code")).toBe("c");
    expect(seen[0]?.url).not.toMatch(APP_CLIENT);

    // The long-lived exchange, on another version.
    await call(
      "/api/integrations/facebook/graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&fb_exchange_token=t",
      { method: "GET" },
    );
    expect(seen[1]?.url).toContain("client_secret=gw-facebook-secret");
  });

  it("json: TikTok Business gets the client in the JSON body", async () => {
    await call(
      "/api/integrations/tiktok-business/business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: "app-id",
          client_secret: "app-secret",
          grant_type: "authorization_code",
          auth_code: "c",
        }),
      },
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({
      grant_type: "authorization_code",
      auth_code: "c",
      client_id: "gw-tiktok-business-id",
      client_secret: "gw-tiktok-business-secret",
    });
  });

  it("form then query: Instagram's two endpoints each get their own rule", async () => {
    await call(
      "/api/integrations/instagram/api.instagram.com/oauth/access_token",
      { headers: { "content-type": FORM }, body: "code=c" },
    );
    await call(
      "/api/integrations/instagram/graph.instagram.com/access_token?grant_type=ig_exchange_token&access_token=short",
      { method: "GET" },
    );
    expect(seen[0]?.body).toBe(
      "code=c&client_id=gw-instagram-id&client_secret=gw-instagram-secret",
    );
    expect(seen[1]?.url).toBe(
      "https://graph.instagram.com/access_token?grant_type=ig_exchange_token&access_token=short&client_id=gw-instagram-id&client_secret=gw-instagram-secret",
    );
  });

  it("drops the provider's cookies and passes the rest of its answer through", async () => {
    const response = await call(LINKEDIN, {
      headers: { "content-type": FORM },
      body: "code=c",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-provider")).toBe("1");
  });

  it("logs the call and its grant type, never the client, the code or the tokens", async () => {
    await call(LINKEDIN, {
      headers: {
        "content-type": FORM,
        "x-everyapp-identity": await identity("web"),
      },
      body: "grant_type=refresh_token&refresh_token=user-refresh-token-456",
    });
    await call(
      "/api/integrations/facebook/graph.facebook.com/v25.0/oauth/access_token?code=the-code",
      { method: "GET" },
    );

    expect(proxyLogs()).toEqual([
      {
        evt: "integration.proxy.call",
        capability: "linkedin",
        organizationId: "org-1",
        appId: "postiz",
        worker: "every-acme-postiz",
        orgSource: "props",
        host: "www.linkedin.com",
        path: "/oauth/v2/accessToken",
        method: "POST",
        grantType: "refresh_token",
        attribution: "user",
        userId: "user-1",
        status: 200,
      },
      expect.objectContaining({
        capability: "facebook",
        path: "/v25.0/oauth/access_token",
        method: "GET",
        grantType: null,
        attribution: "app",
      }),
    ]);
    const everything = logLines().join("\n");
    for (const secret of [
      ...Object.values(CLIENTS),
      "the-code",
      TOKENS.access_token,
      TOKENS.refresh_token,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("answers 502 when the provider can't be reached, logging no URL", async () => {
    upstream.mockRejectedValueOnce(
      new TypeError(
        "fetch failed: https://graph.facebook.com/v25.0/oauth/access_token?client_secret=gw-facebook-secret",
      ),
    );
    await expectRefusal(
      call(
        "/api/integrations/facebook/graph.facebook.com/v25.0/oauth/access_token?code=c",
        { method: "GET" },
      ),
      502,
      "integration_upstream_failed",
    );
    const errors = (console.error as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(JSON.stringify(errors)).toContain(
      "integration.proxy.upstream_failed",
    );
    expect(JSON.stringify(errors)).not.toContain("gw-facebook-secret");
  });
});

describe("Mastodon's instance", () => {
  const TOKEN = (host: string) =>
    `/api/integrations/mastodon/${host}/oauth/token`;

  it("is mastodon.social when MASTODON_URL is unset", async () => {
    const response = await call(TOKEN("mastodon.social"), {
      headers: { "content-type": FORM },
      body: "grant_type=authorization_code&code=c",
    });
    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe("https://mastodon.social/oauth/token");
    expect(seen[0]?.body).toContain("client_secret=gw-mastodon-secret");
  });

  it("is the instance MASTODON_URL names, and only that one", async () => {
    const env = { MASTODON_URL: "https://fosstodon.org" };
    expect(
      (
        await call(TOKEN("fosstodon.org"), {
          env,
          headers: { "content-type": FORM },
          body: "code=c",
        })
      ).status,
    ).toBe(200);
    expect(seen[0]?.url).toBe("https://fosstodon.org/oauth/token");
    await expectRefusal(
      call(TOKEN("mastodon.social"), { env, body: "code=c" }),
      403,
      "integration_path_not_allowed",
    );
    expect(seen).toHaveLength(1);
  });

  it("isn't set up while MASTODON_URL isn't an https origin", async () => {
    const body = await expectRefusal(
      call(TOKEN("fosstodon.org"), {
        env: { MASTODON_URL: "http://fosstodon.org" },
        body: "code=c",
      }),
      503,
      "integration_not_configured",
    );
    expect(body["message"]).toContain(
      "pnpm everyapp secret set MASTODON_CLIENT_ID MASTODON_CLIENT_SECRET MASTODON_URL",
    );
  });
});

describe("refusals", () => {
  it.each([
    [
      "the provider's API on its own host",
      "/api/integrations/linkedin/api.linkedin.com/v2/me",
    ],
    [
      "another path on the token host",
      "/api/integrations/linkedin/www.linkedin.com/oauth/v2/authorization",
    ],
    [
      "Meta's API on the token host",
      "/api/integrations/facebook/graph.facebook.com/v25.0/me/accounts",
    ],
    [
      "an unversioned Meta path",
      "/api/integrations/facebook/graph.facebook.com/oauth/access_token",
    ],
    [
      "a host none of its endpoints is on",
      "/api/integrations/linkedin/evil.example/oauth/v2/accessToken",
    ],
    [
      "another client's endpoint",
      "/api/integrations/linkedin/www.reddit.com/api/v1/access_token",
    ],
    [
      "a path that could leave the host",
      "/api/integrations/linkedin/www.linkedin.com//evil.example/oauth/v2/accessToken",
    ],
  ])("refuses %s", async (_case, path) => {
    const body = await expectRefusal(
      call(path, { body: "code=c" }),
      403,
      "integration_path_not_allowed",
    );
    expect(body["message"]).toMatch(/token endpoints only/);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a method the endpoint doesn't take", async () => {
    await expectRefusal(
      call(LINKEDIN, { method: "GET" }),
      403,
      "integration_path_not_allowed",
    );
    await expectRefusal(
      call(LINKEDIN, { method: "PUT", body: "code=c" }),
      403,
      "integration_path_not_allowed",
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses an app that doesn't list the client, or lists it for reading", async () => {
    const body = await expectRefusal(
      call(LINKEDIN, {
        manifest: { capabilities: { reddit: { access: "write" } } },
        body: "code=c",
      }),
      403,
      "capability_not_requested",
    );
    expect(body["message"]).toContain(
      'capabilities: { "linkedin": { access: "write" } }',
    );
    // The registry's tolerant read keeps a `read` entry; it grants nothing.
    await expectRefusal(
      call(LINKEDIN, {
        manifest: { capabilities: { linkedin: { access: "read" } } },
        body: "code=c",
      }),
      403,
      "capability_not_requested",
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses the client-credentials grant, which would mint a token for the gateway's own client", async () => {
    const body = await expectRefusal(
      call(LINKEDIN, {
        body: "grant_type=client_credentials",
        headers: { "content-type": FORM },
      }),
      403,
      "integration_grant_not_allowed",
    );
    expect(body["message"]).toMatch(/user's grants only/);
    // In the query string, as Meta's endpoints take it; and any grant the
    // gateway doesn't know.
    await expectRefusal(
      call(
        "/api/integrations/facebook/graph.facebook.com/v25.0/oauth/access_token?grant_type=client_credentials",
        { method: "GET" },
      ),
      403,
      "integration_grant_not_allowed",
    );
    await expectRefusal(
      call(LINKEDIN, {
        body: "grant_type=password&username=u&password=p",
        headers: { "content-type": FORM },
      }),
      403,
      "integration_grant_not_allowed",
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses an agent: agents can't connect accounts or mint tokens", async () => {
    for (const scopes of [undefined, ["mcp:write"]]) {
      await expectRefusal(
        call(LINKEDIN, {
          headers: {
            "content-type": FORM,
            "x-everyapp-identity": await identity("mcp", scopes),
          },
          body: "code=c",
        }),
        403,
        "integration_agent_not_allowed",
      );
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 503 naming the command when the gateway has no client", async () => {
    for (const env of [
      { LINKEDIN_CLIENT_ID: undefined },
      { LINKEDIN_CLIENT_SECRET: " " },
    ]) {
      const body = await expectRefusal(
        call(LINKEDIN, { env, body: "code=c" }),
        503,
        "integration_not_configured",
      );
      expect(body["message"]).toContain(
        "pnpm everyapp secret set LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET",
      );
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a body over 64 KiB, declared or streamed", async () => {
    const big = `code=${"x".repeat(64 * 1024)}`;
    await expectRefusal(
      call(LINKEDIN, { headers: { "content-type": FORM }, body: big }),
      413,
      "integration_body_too_large",
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 70; i++) {
          controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        }
        controller.close();
      },
    });
    await expectRefusal(
      call(LINKEDIN, { headers: { "content-type": FORM }, body: stream }),
      413,
      "integration_body_too_large",
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a body it can't put the client in", async () => {
    const body = await expectRefusal(
      call(LINKEDIN, {
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: '--x\r\nContent-Disposition: form-data; name="client_secret"\r\n\r\napp-secret\r\n--x--',
      }),
      400,
      "integration_body_invalid",
    );
    expect(body["message"]).toMatch(/form-encoded/);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("GET /api/integrations/<client>", () => {
  async function status(
    id: string,
    options: {
      manifest?: Record<string, unknown>;
      env?: Record<string, string | undefined>;
    } = {},
  ) {
    const response = await call(`/api/integrations/${id}`, {
      method: "GET",
      ...options,
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  it("gives the public client id to an app that lists the client, once the gateway holds it", async () => {
    await expect(status("linkedin")).resolves.toEqual({
      capability: "linkedin",
      requested: true,
      configured: true,
      ready: true,
      clientId: "gw-linkedin-id",
    });
    await expect(
      status("linkedin", { env: { LINKEDIN_CLIENT_SECRET: undefined } }),
    ).resolves.toEqual({
      capability: "linkedin",
      requested: true,
      configured: false,
      ready: false,
    });
  });

  it("tells an app that doesn't list the client nothing, its id included", async () => {
    await expect(
      status("linkedin", {
        manifest: { capabilities: { reddit: { access: "write" } } },
      }),
    ).resolves.toEqual({
      capability: "linkedin",
      requested: false,
      configured: false,
      ready: false,
    });
  });

  it("gives Mastodon's instance with its id", async () => {
    await expect(
      status("mastodon", { env: { MASTODON_URL: "fosstodon.org" } }),
    ).resolves.toEqual({
      capability: "mastodon",
      requested: true,
      configured: true,
      ready: true,
      clientId: "gw-mastodon-id",
      origin: "https://fosstodon.org",
    });
  });
});
