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
  appId: "crm",
  workerName: "every-acme-crm",
};
/** The gateway's clients: what upstream must see, and no log ever. */
const CLIENTS = {
  GOOGLE_WORKSPACE_CLIENT_ID: "gw-google-id",
  GOOGLE_WORKSPACE_CLIENT_SECRET: "gw-google-secret",
  MICROSOFT_365_CLIENT_ID: "gw-microsoft-id",
  MICROSOFT_365_CLIENT_SECRET: "gw-microsoft-secret",
};
const GOOGLE = "/api/integrations/google-workspace/oauth2.googleapis.com/token";
const MICROSOFT =
  "/api/integrations/microsoft-365/login.microsoftonline.com/common/oauth2/v2.0/token";
const FORM = "application/x-www-form-urlencoded";
const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
/** A token response within `gmail.read`: it reaches the app, never a log. */
const TOKENS = {
  access_token: "user-access-token-123",
  refresh_token: "user-refresh-token-456",
  expires_in: 3600,
  scope: GMAIL,
};
const CALENDAR = "https://www.googleapis.com/auth/calendar.readonly";
const WEBMASTERS = "https://www.googleapis.com/auth/webmasters.readonly";
/** Google's answer to an app with `gmail.read`: its `scope` is what the gateway checks. */
const GOOGLE_TOKEN = {
  access_token: "google-access-token-789",
  refresh_token: "google-refresh-token-012",
  expires_in: 3599,
  scope: GMAIL,
  token_type: "Bearer",
};
/** Entra's answer to `identity` and `mail.read`: URL-encoded with the Graph prefix, no `offline_access`. */
const MS_TOKEN = {
  token_type: "Bearer",
  scope:
    "https%3A%2F%2Fgraph.microsoft.com%2Fuser.read https%3A%2F%2Fgraph.microsoft.com%2Fmail.read",
  expires_in: 3599,
  access_token: "microsoft-access-token-345",
  refresh_token: "microsoft-refresh-token-678",
};
/** An app's entry for the Google client, with whatever it puts under `scopes`. */
const GOOGLE_APP = (scopes?: unknown) => ({
  capabilities: {
    "google-workspace": {
      access: "write",
      ...(scopes === undefined ? {} : { scopes }),
    },
  },
});
const MICROSOFT_APP = (scopes: unknown) => ({
  capabilities: { "microsoft-365": { access: "write", scopes } },
});
const EXCHANGE =
  "grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fintegrations%2Fgoogle%2Fcallback&code_verifier=v";

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let upstream: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;
/** Each request upstream saw, read once: URL, method, headers, body. */
let seen: {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  redirect: string;
}[];

async function record(request: Request): Promise<void> {
  seen.push({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: await request.text(),
    redirect: request.redirect,
  });
}

/** The provider's next answer, in place of the default token response. */
function answer(body: BodyInit | null, init: ResponseInit = {}): void {
  upstream.mockImplementationOnce(async (request: Request) => {
    await record(request);
    return new Response(body, init);
  });
}

function answerJson(json: unknown, init: ResponseInit = {}): void {
  answer(JSON.stringify(json), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

beforeEach(() => {
  clearAppCallerCacheForTests();
  seen = [];
  upstream = vi.fn(async (request: Request) => {
    await record(request);
    return Response.json(TOKENS, {
      headers: {
        "set-cookie": "provider_session=1; Secure",
        "x-provider": "1",
      },
    });
  });
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function app(
  manifest: Record<string, unknown> = GOOGLE_APP(["gmail.read"]),
  overrides: Partial<RegisteredApp> = {},
): RegisteredApp {
  return {
    appId: "crm",
    hostname: "crm.example.com",
    workerName: "every-acme-crm",
    tier: "service_binding",
    scope: "org",
    organizationId: "org-1",
    status: "active",
    // Tolerant, as the registry reads a deployed row.
    manifest: validateManifest({ id: "crm", ...manifest }),
    ...overrides,
  };
}

function call(
  path: string,
  options: {
    method?: string;
    body?: BodyInit | null;
    headers?: Record<string, string>;
    manifest?: Record<string, unknown>;
    app?: Partial<RegisteredApp>;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const method = options.method ?? "POST";
  // Each call reads its registry: the manifest a test passes is the
  // deployed one, not the one the entrypoint cached for the worker.
  clearAppCallerCacheForTests();
  return handleAppGatewayRequest({
    request: new Request(`http://every-app-gateway.internal${path}`, {
      method,
      headers: options.headers,
      body: method === "GET" ? undefined : (options.body ?? null),
      ...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
    props: PROPS,
    registry: new InMemoryAppRegistry([app(options.manifest, options.app)]),
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
    audience: "every-acme-crm",
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

/** The `integration.proxy.scope_refused` lines, which go to `warn`. */
function scopeRefusedLogs(): Record<string, unknown>[] {
  return warn.mock.calls
    .map(([line]: unknown[]) => String(line))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["evt"] === "integration.proxy.scope_refused");
}

/** Everything any level logged, for the never-in-logs checks. */
function allLogLines(): string {
  const spies = [
    log,
    warn,
    console.error as unknown as ReturnType<typeof vi.fn>,
  ];
  return spies
    .flatMap((spy) =>
      spy.mock.calls.map((args: unknown[]) => JSON.stringify(args)),
    )
    .join("\n");
}

/** What the app smuggles along: none of it may reach the provider. */
const APP_CLIENT = /app-(id|secret)|Basic YXBw/;

describe("token endpoint calls", () => {
  it("form: Google gets the gateway's client in the body, never the app's", async () => {
    const response = await call(GOOGLE, {
      headers: {
        "content-type": FORM,
        authorization: "Basic YXBwOmFwcA==",
        cookie: "a=b",
        "x-everyapp-identity": await identity("web"),
      },
      body: "grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fintegrations%2Fgoogle%2Fcallback&client_id=app-id&client_secret=app-secret",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(TOKENS);
    const [sent] = seen;
    expect(sent?.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(new URLSearchParams(sent?.body))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://crm.example.com/integrations/google/callback",
      client_id: "gw-google-id",
      client_secret: "gw-google-secret",
    });
    expect(sent?.headers.get("authorization")).toBeNull();
    expect(sent?.headers.get("cookie")).toBeNull();
    expect(sent?.headers.get("x-everyapp-identity")).toBeNull();
    expect(JSON.stringify(sent)).not.toMatch(APP_CLIENT);
    // Never following a redirect with the client on it.
    expect(sent?.redirect).toBe("manual");
  });

  it("drops the provider's cookies and passes the rest of its answer through", async () => {
    const response = await call(GOOGLE, {
      headers: { "content-type": FORM },
      body: EXCHANGE,
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-provider")).toBe("1");
  });

  it("logs the call and its grant type, never the client, the code or the tokens", async () => {
    await call(GOOGLE, {
      headers: {
        "content-type": FORM,
        "x-everyapp-identity": await identity("web"),
      },
      body: "grant_type=refresh_token&refresh_token=user-refresh-token-456",
    });
    await call(GOOGLE, {
      headers: { "content-type": FORM },
      body: EXCHANGE,
    });

    expect(proxyLogs()).toEqual([
      expect.objectContaining({
        evt: "integration.proxy.call",
        capability: "google-workspace",
        organizationId: "org-1",
        appId: "crm",
        worker: "every-acme-crm",
        orgSource: "props",
        host: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        grantType: "refresh_token",
        attribution: "user",
        userId: "user-1",
        status: 200,
      }),
      expect.objectContaining({
        capability: "google-workspace",
        path: "/token",
        method: "POST",
        grantType: "authorization_code",
        attribution: "app",
      }),
    ]);
    const everything = allLogLines();
    for (const secret of [
      ...Object.values(CLIENTS),
      "the-code",
      TOKENS.access_token,
      TOKENS.refresh_token,
      GOOGLE_TOKEN.access_token,
      GOOGLE_TOKEN.refresh_token,
      MS_TOKEN.access_token,
      MS_TOKEN.refresh_token,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("answers 502 when the provider can't be reached, logging no URL", async () => {
    upstream.mockRejectedValueOnce(
      new TypeError(
        "fetch failed: https://oauth2.googleapis.com/token?client_secret=gw-google-secret",
      ),
    );
    await expectRefusal(
      call(GOOGLE, { headers: { "content-type": FORM }, body: EXCHANGE }),
      502,
      "integration_upstream_failed",
    );
    const errors = (console.error as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(JSON.stringify(errors)).toContain(
      "integration.proxy.upstream_failed",
    );
    expect(JSON.stringify(errors)).not.toContain("gw-google-secret");
  });
});

describe("refusals", () => {
  it.each([
    [
      "another path on the token host",
      "/api/integrations/google-workspace/oauth2.googleapis.com/revoke",
    ],
    [
      "a host none of its endpoints is on",
      "/api/integrations/google-workspace/evil.example/token",
    ],
    [
      "another client's endpoint",
      "/api/integrations/google-workspace/login.microsoftonline.com/common/oauth2/v2.0/token",
    ],
    [
      "a path that could leave the host",
      "/api/integrations/google-workspace/oauth2.googleapis.com//evil.example/token",
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
      call(GOOGLE, { method: "GET" }),
      403,
      "integration_path_not_allowed",
    );
    await expectRefusal(
      call(GOOGLE, { method: "PUT", body: "code=c" }),
      403,
      "integration_path_not_allowed",
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses an app that doesn't list the client", async () => {
    const body = await expectRefusal(
      call(GOOGLE, {
        manifest: { capabilities: { dataforseo: { access: "read" } } },
        body: EXCHANGE,
        headers: { "content-type": FORM },
      }),
      403,
      "capability_not_requested",
    );
    expect(body["message"]).toContain('"google-workspace"');
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses the client-credentials grant, which would mint a token for the gateway's own client", async () => {
    const body = await expectRefusal(
      call(GOOGLE, {
        body: "grant_type=client_credentials",
        headers: { "content-type": FORM },
      }),
      403,
      "integration_grant_not_allowed",
    );
    expect(body["message"]).toMatch(/user's grants only/);
    // Any grant the gateway doesn't know.
    await expectRefusal(
      call(GOOGLE, {
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
        call(GOOGLE, {
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
      { GOOGLE_WORKSPACE_CLIENT_ID: undefined },
      { GOOGLE_WORKSPACE_CLIENT_SECRET: " " },
    ]) {
      const body = await expectRefusal(
        call(GOOGLE, { env, body: "code=c" }),
        503,
        "integration_not_configured",
      );
      expect(body).toMatchObject({
        settings: [
          "GOOGLE_WORKSPACE_CLIENT_ID",
          "GOOGLE_WORKSPACE_CLIENT_SECRET",
        ],
        command: "pnpm everyapp configure crm",
      });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a body over 64 KiB, declared or streamed", async () => {
    const big = `code=${"x".repeat(64 * 1024)}`;
    await expectRefusal(
      call(GOOGLE, { headers: { "content-type": FORM }, body: big }),
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
      call(GOOGLE, { headers: { "content-type": FORM }, body: stream }),
      413,
      "integration_body_too_large",
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a body it can't put the client in", async () => {
    const body = await expectRefusal(
      call(GOOGLE, {
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

describe("scope sets: Google and Microsoft", () => {
  /** A Google call for an app with `sets`, as a person or in the background. */
  async function google(
    sets: unknown,
    options: Parameters<typeof call>[1] & { person?: boolean } = {},
  ) {
    const { person = true, ...rest } = options;
    return call(GOOGLE, {
      body: EXCHANGE,
      ...rest,
      manifest: rest.manifest ?? GOOGLE_APP(sets),
      headers: {
        "content-type": FORM,
        ...(person ? { "x-everyapp-identity": await identity("web") } : {}),
        ...rest.headers,
      },
    });
  }

  async function microsoft(sets: unknown, body: string) {
    return call(MICROSOFT, {
      body,
      manifest: MICROSOFT_APP(sets),
      headers: {
        "content-type": FORM,
        "x-everyapp-identity": await identity("web"),
      },
    });
  }

  it("forwards a Google exchange within the app's sets, with the provider's headers and without the app's scope", async () => {
    answerJson(GOOGLE_TOKEN, {
      headers: {
        "set-cookie": "provider_session=1; Secure",
        "x-provider": "1",
        "content-length": "999",
      },
    });
    const response = await google(["gmail.read"], {
      body: `${EXCHANGE}&scope=${encodeURIComponent(GMAIL)}`,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-provider")).toBe("1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("999");
    await expect(response.json()).resolves.toEqual(GOOGLE_TOKEN);
    const [sent] = seen;
    expect(sent?.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(new URLSearchParams(sent?.body))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://crm.example.com/integrations/google/callback",
      code_verifier: "v",
      client_id: "gw-google-id",
      client_secret: "gw-google-secret",
    });
    expect(proxyLogs()).toEqual([
      {
        evt: "integration.proxy.call",
        capability: "google-workspace",
        organizationId: "org-1",
        appId: "crm",
        worker: "every-acme-crm",
        orgSource: "props",
        host: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        grantType: "authorization_code",
        attribution: "user",
        userId: "user-1",
        scopeSets: ["gmail.read"],
        status: 200,
      },
    ]);
    expect(scopeRefusedLogs()).toEqual([]);
  });

  it("forwards a Google refresh within the grant", async () => {
    answerJson({ ...GOOGLE_TOKEN, refresh_token: undefined });
    const response = await google(["gmail.read"], {
      body: `grant_type=refresh_token&refresh_token=${GOOGLE_TOKEN.refresh_token}`,
    });
    expect(response.status).toBe(200);
    expect(proxyLogs()[0]).toMatchObject({ grantType: "refresh_token" });
  });

  it("tolerates identity echoed as the userinfo URLs", async () => {
    answerJson({
      ...GOOGLE_TOKEN,
      scope:
        "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
    });
    expect((await google(["identity"])).status).toBe(200);
  });

  it("sets Microsoft's request scope to the app's list and accepts Entra's spelling of the answer", async () => {
    for (const body of [
      `${EXCHANGE}&scope=openid+profile+email+User.Read+Mail.Read+offline_access`,
      `grant_type=refresh_token&refresh_token=${MS_TOKEN.refresh_token}&scope=Mail.Read`,
    ]) {
      answerJson(MS_TOKEN);
      const response = await microsoft(["identity", "mail.read"], body);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(MS_TOKEN);
    }
    for (const sent of seen) {
      expect(new URLSearchParams(sent.body).getAll("scope")).toEqual([
        "User.Read Mail.Read offline_access",
      ]);
    }
  });

  it("completes a background call within the grant for the app's organization, and a shared app's for x-everyapp-org", async () => {
    answerJson(GOOGLE_TOKEN);
    expect((await google(["gmail.read"], { person: false })).status).toBe(200);
    answerJson(GOOGLE_TOKEN);
    expect(
      (
        await google(["gmail.read"], {
          person: false,
          app: { scope: "shared" },
          env: { GATEWAY_DEPLOYMENT_MODE: "hosted" },
          headers: { "x-everyapp-org": "org-1" },
        })
      ).status,
    ).toBe(200);
    expect(proxyLogs()).toEqual([
      expect.objectContaining({ attribution: "app", orgSource: "props" }),
      expect.objectContaining({ attribution: "app", orgSource: "header" }),
    ]);
  });

  it("logs no client, code or token across a Google exchange, a Microsoft exchange and a refused answer", async () => {
    answerJson(GOOGLE_TOKEN);
    expect((await google(["gmail.read"])).status).toBe(200);
    answerJson(MS_TOKEN);
    expect(
      (
        await microsoft(
          ["identity", "mail.read"],
          `${EXCHANGE}&scope=User.Read+Mail.Read+offline_access`,
        )
      ).status,
    ).toBe(200);
    answerJson({ id_token: "google-id-token-999", expires_in: 3599 });
    await expectRefusal(
      google(["gmail.read"]),
      502,
      "integration_scope_unverified",
    );

    // Three calls and one refusal were logged: the loop below isn't empty.
    expect(proxyLogs()).toHaveLength(3);
    expect(scopeRefusedLogs()).toHaveLength(1);
    const everything = allLogLines();
    for (const secret of [
      ...Object.values(CLIENTS),
      "the-code",
      "google-id-token-999",
      GOOGLE_TOKEN.access_token,
      GOOGLE_TOKEN.refresh_token,
      MS_TOKEN.access_token,
      MS_TOKEN.refresh_token,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("refuses a token outside the app's sets, dropping it: never forwarded, logged only by its scope names", async () => {
    answerJson(GOOGLE_TOKEN);
    const body = await expectRefusal(
      google(["search-console.read"]),
      403,
      "integration_scope_exceeded",
    );
    expect(body["message"]).toContain(
      `granted scopes this app doesn't declare: ${GMAIL}. It declares search-console.read (${WEBMASTERS}).`,
    );
    expect(body["message"]).toContain("without include_granted_scopes");
    expect(JSON.stringify(body)).not.toContain(GOOGLE_TOKEN.access_token);
    expect(scopeRefusedLogs()).toEqual([
      {
        evt: "integration.proxy.scope_refused",
        capability: "google-workspace",
        organizationId: "org-1",
        appId: "crm",
        worker: "every-acme-crm",
        orgSource: "props",
        host: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        grantType: "authorization_code",
        attribution: "user",
        userId: "user-1",
        scopeSets: ["search-console.read"],
        reason: "integration_scope_exceeded",
        excess: [GMAIL],
      },
    ]);
    const everything = allLogLines();
    for (const secret of [
      GOOGLE_TOKEN.access_token,
      GOOGLE_TOKEN.refresh_token,
      "the-code",
      CLIENTS.GOOGLE_WORKSPACE_CLIENT_SECRET,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("refuses the union include_granted_scopes yields on a narrower grant", async () => {
    answerJson({
      ...GOOGLE_TOKEN,
      scope: `${GMAIL} https://www.googleapis.com/auth/youtube.readonly`,
    });
    const body = await expectRefusal(
      google(["gmail.read"]),
      403,
      "integration_scope_exceeded",
    );
    expect(body["message"]).toContain(
      "https://www.googleapis.com/auth/youtube.readonly",
    );
    expect(scopeRefusedLogs()[0]).toMatchObject({
      excess: ["https://www.googleapis.com/auth/youtube.readonly"],
    });
  });

  it("refuses a refresh echoing a scope set the manifest dropped, in the background too", async () => {
    const refresh = `grant_type=refresh_token&refresh_token=${GOOGLE_TOKEN.refresh_token}`;
    answerJson({ ...GOOGLE_TOKEN, scope: `${GMAIL} ${CALENDAR}` });
    await expectRefusal(
      google(["gmail.read"], { body: refresh }),
      403,
      "integration_scope_exceeded",
    );
    answerJson({ ...GOOGLE_TOKEN, scope: `${GMAIL} ${CALENDAR}` });
    await expectRefusal(
      google(["gmail.read"], {
        body: refresh,
        person: false,
        app: { scope: "shared" },
        env: { GATEWAY_DEPLOYMENT_MODE: "hosted" },
        headers: { "x-everyapp-org": "org-1" },
      }),
      403,
      "integration_scope_exceeded",
    );
    expect(scopeRefusedLogs().map((entry) => entry["excess"])).toEqual([
      [CALENDAR],
      [CALENDAR],
    ]);
  });

  it.each([
    ["without scopes", undefined],
    ["with an empty list", []],
    ["with scopes that aren't a list", "gmail.read"],
    ["with a set listed twice", ["gmail.read", "gmail.read"]],
  ])(
    "refuses an app listing Google %s, before admitting anyone",
    async (_case, scopes) => {
      // An agent's identity: refused at step 3 if the grant were checked after.
      const body = await expectRefusal(
        google(scopes, {
          headers: { "x-everyapp-identity": await identity("mcp") },
        }),
        403,
        "integration_scopes_undeclared",
      );
      expect(body["message"]).toContain(
        'Add scopes: [...] (one or more of: identity, gmail.read, calendar.read, search-console.read, analytics.read) to its "google-workspace" entry in everyapp.config.ts and deploy again.',
      );
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("refuses an app naming a set this gateway doesn't offer, naming the gateway update as a fix", async () => {
    const body = await expectRefusal(
      google(["gmail.read", "gmail.write", "gmail.write"]),
      403,
      "integration_scopes_undeclared",
    );
    expect(body["message"]).toBe(
      "This app's Google (Gmail, Calendar, Search Console and Analytics) entry names scope sets this gateway doesn't offer: gmail.write. It offers: identity, gmail.read, calendar.read, search-console.read, analytics.read. Fix everyapp.config.ts and deploy again, or update the gateway (everyapp update) if it is newer than this one.",
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a token exchange",
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=t",
      '"urn:ietf:params:oauth:grant-type:token-exchange"',
    ],
    [
      "a request without grant_type",
      "code=the-code",
      "a request without grant_type",
    ],
  ])("refuses %s on a client with a policy", async (_case, body, named) => {
    const refused = await expectRefusal(
      google(["gmail.read"], { body }),
      403,
      "integration_grant_not_allowed",
    );
    expect(refused["message"]).toBe(
      `Through the gateway, Google (Gmail, Calendar, Search Console and Analytics) completes authorization_code and refresh_token grants only; ${named} isn't one of them. An app never gets app-level tokens with the operator's client.`,
    );
    expect(upstream).not.toHaveBeenCalled();
    expect(scopeRefusedLogs()).toEqual([
      expect.objectContaining({
        reason: "integration_grant_not_allowed",
        scopeSets: ["gmail.read"],
      }),
    ]);
  });

  it("refuses client_credentials as for every client, before the policy's own check", async () => {
    const refused = await expectRefusal(
      google(["gmail.read"], { body: "grant_type=client_credentials&scope=x" }),
      403,
      "integration_grant_not_allowed",
    );
    expect(refused["message"]).toMatch(/user's grants only/);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    "grant_type=client_credentials",
    `scope=${encodeURIComponent(GMAIL)}`,
    "user_scope=x",
  ])(
    "refuses %s in the query string: the body alone decides",
    async (query) => {
      const body = await expectRefusal(
        call(`${GOOGLE}?${query}`, {
          body: EXCHANGE,
          manifest: GOOGLE_APP(["gmail.read"]),
          headers: { "content-type": FORM },
        }),
        400,
        "integration_body_invalid",
      );
      expect(body["message"]).toContain("not its query string");
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("refuses grant_type named twice in the body: the first copy would decide, and the provider would see both", async () => {
    const body = await expectRefusal(
      google(["gmail.read"], {
        body: "grant_type=authorization_code&grant_type=client_credentials&code=the-code",
      }),
      400,
      "integration_body_invalid",
    );
    expect(body["message"]).toContain("grant_type appears more than once");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a Microsoft request asking for a scope outside the sets", async () => {
    const body = await expectRefusal(
      microsoft(
        ["identity", "mail.read"],
        `${EXCHANGE}&scope=User.Read+Mail.Read+Mail.Send+offline_access`,
      ),
      403,
      "integration_scope_not_allowed",
    );
    expect(body["message"]).toBe(
      "This app may ask Microsoft 365 (Outlook mail and calendar) for identity, mail.read (User.Read, Mail.Read, offline_access); the request also asks mail.send. Build the authorize URL and the token request from integrationStatus().scopes.",
    );
    expect(upstream).not.toHaveBeenCalled();
    expect(scopeRefusedLogs()[0]).toMatchObject({
      reason: "integration_scope_not_allowed",
      excess: ["mail.send"],
    });
  });

  it("names the first ten scopes in excess only, each cut short, in the message and the log", async () => {
    const long = "L".repeat(200);
    const extra = Array.from({ length: 12 }, (_, i) => `Files.Read.${i}`);
    const body = await expectRefusal(
      microsoft(
        ["mail.read"],
        `${EXCHANGE}&scope=${["Mail.Read", long, ...extra].join("+")}`,
      ),
      403,
      "integration_scope_not_allowed",
    );
    const shown = [
      "l".repeat(128),
      ...extra.slice(0, 9).map((s) => s.toLowerCase()),
    ];
    expect(body["message"]).toContain(
      `the request also asks ${shown.join(", ")} and 3 more.`,
    );
    expect(body["message"]).not.toContain("files.read.9");
    expect(scopeRefusedLogs()[0]).toMatchObject({ excess: shown });
    expect(allLogLines()).not.toContain("files.read.9");
  });

  it("refuses a token whose answer names no scopes, access or id token alike", async () => {
    for (const json of [
      { access_token: GOOGLE_TOKEN.access_token, expires_in: 3599 },
      { id_token: "google-id-token-999", expires_in: 3599 },
    ]) {
      answerJson(json);
      const body = await expectRefusal(
        google(["gmail.read"]),
        502,
        "integration_scope_unverified",
      );
      expect(body["message"]).toContain("Ask the person to connect again.");
      expect(JSON.stringify(body)).not.toMatch(/google-(access|id)-token/);
    }
    expect(allLogLines()).not.toMatch(/google-(access|id)-token/);
  });

  it("forwards a 2xx that carries no token, Slack's ok: false", async () => {
    answerJson({ ok: false, error: "invalid_code" });
    const response = await google(["gmail.read"]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_code",
    });
  });

  it.each([
    ["isn't JSON", "<html>oops</html>"],
    ["is a JSON array", "[1]"],
    [
      "passes 64 KiB",
      JSON.stringify({ ...GOOGLE_TOKEN, padding: "x".repeat(70 * 1024) }),
    ],
  ])("refuses a 2xx answer that %s", async (_case, text) => {
    answer(text, { status: 200 });
    const body = await expectRefusal(
      google(["gmail.read"]),
      502,
      "integration_response_invalid",
    );
    expect(body["message"]).toContain("nothing was passed on");
  });

  it("answers 502 when the provider's answer breaks off while it is read, forwarding and logging none of it", async () => {
    const partial = `{"access_token":"${GOOGLE_TOKEN.access_token}","scope":"${GMAIL}"`;
    answer(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(partial));
          controller.error(new TypeError(`terminated after ${partial}`));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const body = await expectRefusal(
      google(["gmail.read"]),
      502,
      "integration_upstream_failed",
    );
    expect(body["message"]).toContain("nothing was passed on");
    const errors = JSON.stringify(
      (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls,
    );
    expect(errors).toContain("integration.proxy.upstream_failed");
    expect(errors).toContain('\\"phase\\":\\"answer\\"');
    expect(errors).toContain('\\"error\\":\\"TypeError\\"');
    expect(errors).not.toContain("terminated");
    expect(allLogLines()).not.toContain(GOOGLE_TOKEN.access_token);
  });

  it("streams a provider's own error through, unlabelled", async () => {
    answerJson(
      { error: "invalid_grant", error_description: "Bad Request" },
      { status: 400, headers: { "x-provider": "1" } },
    );
    const response = await google(["gmail.read"]);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-everyapp-error")).toBeNull();
    expect(response.headers.get("x-provider")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_grant",
      error_description: "Bad Request",
    });
  });

  it("refuses a Microsoft token carrying a set the app doesn't declare, and tolerates identity scopes", async () => {
    answerJson({
      ...MS_TOKEN,
      scope: `${MS_TOKEN.scope} https%3A%2F%2Fgraph.microsoft.com%2FCalendars.Read`,
    });
    const body = await expectRefusal(
      microsoft(["identity", "mail.read"], EXCHANGE),
      403,
      "integration_scope_exceeded",
    );
    expect(body["message"]).toContain("calendars.read");
    expect(body["message"]).toContain("https://myapplications.microsoft.com");

    answerJson({
      ...MS_TOKEN,
      scope: `openid profile email ${MS_TOKEN.scope}`,
    });
    expect((await microsoft(["identity", "mail.read"], EXCHANGE)).status).toBe(
      200,
    );
  });

  it("still refuses an agent", async () => {
    await expectRefusal(
      google(["gmail.read"], {
        headers: { "x-everyapp-identity": await identity("mcp") },
      }),
      403,
      "integration_agent_not_allowed",
    );
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
    await expect(status("google-workspace")).resolves.toMatchObject({
      capability: "google-workspace",
      requested: true,
      configured: true,
      ready: true,
      clientId: "gw-google-id",
      settings: [],
      setup: null,
      command: null,
    });
    const unset = await status("google-workspace", {
      env: { GOOGLE_WORKSPACE_CLIENT_SECRET: undefined },
    });
    expect(unset).toMatchObject({
      capability: "google-workspace",
      requested: true,
      configured: false,
      ready: false,
      settings: [
        "GOOGLE_WORKSPACE_CLIENT_ID",
        "GOOGLE_WORKSPACE_CLIENT_SECRET",
      ],
      setup: expect.stringContaining(
        "it needs GOOGLE_WORKSPACE_CLIENT_ID and GOOGLE_WORKSPACE_CLIENT_SECRET. An admin runs: pnpm everyapp configure crm",
      ),
      command: "pnpm everyapp configure crm",
    });
    expect(unset).not.toHaveProperty("clientId");
  });

  it("tells an app that doesn't list the client nothing, its id included", async () => {
    const unlisted = await status("google-workspace", {
      manifest: { capabilities: { dataforseo: { access: "read" } } },
    });
    expect(unlisted).toMatchObject({
      capability: "google-workspace",
      requested: false,
      configured: false,
      ready: false,
      settings: [],
      setup: null,
      command: null,
    });
    expect(unlisted).not.toHaveProperty("clientId");
    expect(unlisted).not.toHaveProperty("scopes");
  });

  it("gives a client with a policy's sets and the exact scopes to ask for, in registry order", async () => {
    await expect(
      status("google-workspace", {
        manifest: GOOGLE_APP(["gmail.read", "identity"]),
      }),
    ).resolves.toEqual({
      capability: "google-workspace",
      flow: "both",
      connectPath: "/connect/google-workspace",
      requested: true,
      configured: true,
      ready: true,
      clientId: "gw-google-id",
      scopeSets: ["gmail.read", "identity"],
      scopes: ["openid", "email", "profile", GMAIL],
      settings: [],
      setup: null,
      command: null,
    });
    await expect(
      status("microsoft-365", { manifest: MICROSOFT_APP(["mail.read"]) }),
    ).resolves.toEqual({
      capability: "microsoft-365",
      flow: "both",
      connectPath: "/connect/microsoft-365",
      requested: true,
      configured: true,
      ready: true,
      clientId: "gw-microsoft-id",
      scopeSets: ["mail.read"],
      scopes: ["Mail.Read", "offline_access"],
      settings: [],
      setup: null,
      command: null,
    });
  });

  it("answers a valid grant's sets and scopes while it holds no client, with no id", async () => {
    await expect(
      status("google-workspace", {
        manifest: GOOGLE_APP(["gmail.read"]),
        env: { GOOGLE_WORKSPACE_CLIENT_SECRET: undefined },
      }),
    ).resolves.toEqual({
      capability: "google-workspace",
      flow: "both",
      connectPath: "/connect/google-workspace",
      requested: true,
      configured: false,
      ready: false,
      scopeSets: ["gmail.read"],
      scopes: [GMAIL],
      settings: [
        "GOOGLE_WORKSPACE_CLIENT_ID",
        "GOOGLE_WORKSPACE_CLIENT_SECRET",
      ],
      setup: expect.stringContaining(
        "An admin runs: pnpm everyapp configure crm (or an owner or admin adds a client under Manage workspace → Providers)",
      ),
      command: "pnpm everyapp configure crm",
    });
  });

  it("answers not ready, with no id and no scopes, for a void grant", async () => {
    for (const scopes of [undefined, [], ["gmail.read", "gmail.write"]]) {
      await expect(
        status("google-workspace", { manifest: GOOGLE_APP(scopes) }),
      ).resolves.toEqual({
        capability: "google-workspace",
        flow: "both",
        connectPath: "/connect/google-workspace",
        requested: true,
        configured: true,
        ready: false,
        scopeSets: [],
        settings: [],
        setup: null,
        command: null,
      });
    }
    await expect(
      status("google-workspace", {
        manifest: GOOGLE_APP([]),
        env: { GOOGLE_WORKSPACE_CLIENT_SECRET: undefined },
      }),
    ).resolves.toMatchObject({ configured: false, ready: false });
    await expect(
      status("google-workspace", {
        manifest: { capabilities: { dataforseo: { access: "read" } } },
      }),
    ).resolves.toEqual({
      capability: "google-workspace",
      flow: "both",
      connectPath: "/connect/google-workspace",
      requested: false,
      configured: false,
      ready: false,
      settings: [],
      setup: null,
      command: null,
    });
  });
});
