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
} from "./app-gateway-entrypoint";

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

beforeEach(() => {
  clearAppCallerCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const PROPS: AppCallerProps = {
  organizationId: "org-1",
  appId: "openseo",
  workerName: "every-openseo",
};
const SERP_PATH =
  "/api/integrations/dataforseo/api.dataforseo.com/v3/serp/google/organic/live/advanced";

function app(manifest: Record<string, unknown> = {}): RegisteredApp {
  return {
    appId: "openseo",
    hostname: "openseo.example.com",
    workerName: "every-openseo",
    tier: "service_binding",
    scope: "org",
    organizationId: "org-1",
    status: "active",
    manifest: validateManifest({ id: "openseo", ...manifest }),
  };
}

const LISTS_DATAFORSEO = {
  capabilities: { dataforseo: { access: "read", why: "Keyword research" } },
};

function call(options: {
  manifest?: Record<string, unknown>;
  path?: string;
  method?: string;
  headers?: HeadersInit;
  env?: Record<string, string>;
  props?: AppCallerProps;
  fetchUpstream?: (request: Request) => Promise<Response>;
}) {
  const method = options.method ?? "POST";
  return handleAppGatewayRequest({
    request: new Request(
      `http://every-app-gateway.internal${options.path ?? SERP_PATH}`,
      {
        method,
        headers: options.headers,
        body: method === "GET" ? undefined : "[]",
      },
    ),
    props: options.props ?? PROPS,
    registry: new InMemoryAppRegistry([app(options.manifest)]),
    env: {
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      JWT_PUBLIC_KEY: publicKeyPem,
      GATEWAY_URL: "https://home.example.com",
      ...(options.env ?? { DATAFORSEO_API_KEY: "login@example.com:secret" }),
    },
    organizations: { isAttributable: async () => true },
    fetchUpstream:
      options.fetchUpstream ?? vi.fn(async () => Response.json({ ok: true })),
  });
}

async function expectRefusal(
  response: Promise<Response>,
  status: number,
  code: string,
): Promise<void> {
  const refused = await response;
  expect(refused.status).toBe(status);
  expect(refused.headers.get("x-everyapp-error")).toBe(code);
  await expect(refused.json()).resolves.toMatchObject({ code });
}

function identityFor(orgId: string) {
  return mintIdentityJwt(privateKeyPem, {
    subject: {
      sub: "user-1",
      email: "user@example.com",
      orgId,
      orgRole: "member",
    },
    audience: "every-openseo",
    issuer: "https://home.example.com",
    channel: "web",
  });
}

function loggedCalls(log: { mock: { calls: unknown[][] } }) {
  return log.mock.calls
    .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
    .filter((entry) => entry["evt"] === "integration.proxy.call");
}

describe("AppGateway capabilities", () => {
  it("forwards a call with the gateway's key and nothing the app sent to authenticate", async () => {
    const fetchUpstream = vi.fn(async () =>
      Response.json({ status_code: 20000, cost: 0.002, tasks: [] }),
    );

    const response = await call({
      manifest: LISTS_DATAFORSEO,
      path: `${SERP_PATH}?debug=1`,
      headers: {
        authorization: "Basic app-supplied",
        "x-api-key": "app-supplied",
        cookie: "session=1",
        "x-everyapp-identity": "not-a-valid-token",
        // Its own organization (another is refused): stripped all the same.
        "x-everyapp-org": "org-1",
        "x-user-email": "someone@example.com",
        "content-type": "application/json",
      },
      fetchUpstream,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ cost: 0.002 });
    const upstream = (fetchUpstream.mock.calls[0] as unknown as [Request])[0];
    expect(upstream.url).toBe(
      "https://api.dataforseo.com/v3/serp/google/organic/live/advanced?debug=1",
    );
    expect(upstream.method).toBe("POST");
    expect(upstream.redirect).toBe("manual");
    expect(upstream.headers.get("authorization")).toBe(
      `Basic ${btoa("login@example.com:secret")}`,
    );
    for (const stripped of [
      "x-api-key",
      "cookie",
      "x-everyapp-identity",
      "x-everyapp-org",
      "x-user-email",
    ]) {
      expect(upstream.headers.get(stripped)).toBeNull();
    }
    expect(upstream.headers.get("content-type")).toBe("application/json");
  });

  it("puts Context.dev's key on as a bearer token, on its own host only", async () => {
    const fetchUpstream = vi.fn(async () => Response.json({ ok: true }));
    const response = await call({
      manifest: { capabilities: { context: { access: "read" } } },
      path: "/api/integrations/context/api.context.dev/v1/scrape",
      env: { CONTEXT_API_KEY: " ctx_key " },
      fetchUpstream,
    });

    expect(response.status).toBe(200);
    const upstream = (fetchUpstream.mock.calls[0] as unknown as [Request])[0];
    expect(upstream.url).toBe("https://api.context.dev/v1/scrape");
    expect(upstream.headers.get("authorization")).toBe("Bearer ctx_key");

    await expectRefusal(
      call({
        manifest: { capabilities: { context: { access: "read" } } },
        path: "/api/integrations/context/api.dataforseo.com/v3/x",
        env: { CONTEXT_API_KEY: "ctx_key" },
      }),
      400,
      "invalid_integration_route",
    );
  });

  it.each([
    ["no capabilities", {}],
    [
      "another capability only",
      { capabilities: { context: { access: "read" } } },
    ],
    // The retired key reads as no capabilities at all.
    ["the retired integrations key", { integrations: { dataforseo: {} } }],
  ])(
    "refuses a capability the app's registry row doesn't list (%s)",
    async (_case, manifest) => {
      const fetchUpstream = vi.fn();
      await expectRefusal(
        call({ manifest, fetchUpstream }),
        403,
        "capability_not_requested",
      );
      expect(fetchUpstream).not.toHaveBeenCalled();
    },
  );

  it("serves background work and signed-in people alike, attributing each", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const background = await call({ manifest: LISTS_DATAFORSEO });
    expect(background.status).toBe(200);
    await background.text();

    clearAppCallerCacheForTests();
    const signedIn = await call({
      manifest: LISTS_DATAFORSEO,
      headers: { "x-everyapp-identity": await identityFor("org-1") },
    });
    expect(signedIn.status).toBe(200);
    await signedIn.text();

    // Another organization's person is never attributed to this app's call.
    clearAppCallerCacheForTests();
    const foreign = await call({
      manifest: LISTS_DATAFORSEO,
      headers: { "x-everyapp-identity": await identityFor("org-2") },
    });
    expect(foreign.status).toBe(200);
    await foreign.text();

    const lines = loggedCalls(log);
    expect(lines.map((line) => line["attribution"])).toEqual([
      "app",
      "user",
      "app",
    ]);
    expect(lines[1]).toMatchObject({ userId: "user-1" });
    expect(lines[2]).not.toHaveProperty("userId");
  });

  it("says who sets the key when the gateway has none", async () => {
    const fetchUpstream = vi.fn();
    const refused = await call({
      manifest: LISTS_DATAFORSEO,
      env: { DATAFORSEO_API_KEY: "  " },
      fetchUpstream,
    });

    expect(refused.status).toBe(503);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "integration_not_configured",
    );
    await expect(refused.json()).resolves.toMatchObject({
      code: "integration_not_configured",
      message: expect.stringContaining(
        "everyapp secret set DATAFORSEO_API_KEY",
      ),
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a host outside the provider's",
      "/api/integrations/dataforseo/evil.example/v3/x",
    ],
    ["an unknown provider", "/api/integrations/github/api.github.com/user"],
    [
      "a path that would leave the host",
      "/api/integrations/dataforseo/api.dataforseo.com//evil.example/x",
    ],
  ])("refuses %s before anything leaves the gateway", async (_name, path) => {
    const fetchUpstream = vi.fn();
    await expectRefusal(
      call({ manifest: LISTS_DATAFORSEO, path, fetchUpstream }),
      400,
      "invalid_integration_route",
    );
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("reports whether calls would go through, without calling the provider", async () => {
    const fetchUpstream = vi.fn();
    const status = async (
      manifest?: Record<string, unknown>,
      env?: Record<string, string>,
    ) => {
      // Each call registers a different manifest.
      clearAppCallerCacheForTests();
      return (
        await call({
          manifest,
          env,
          method: "GET",
          path: "/api/integrations/dataforseo",
          fetchUpstream,
        })
      ).json();
    };

    await expect(status(LISTS_DATAFORSEO)).resolves.toEqual({
      capability: "dataforseo",
      requested: true,
      configured: true,
      ready: true,
    });
    await expect(status(LISTS_DATAFORSEO, {})).resolves.toMatchObject({
      configured: false,
      ready: false,
    });
    // An app that doesn't list it never learns whether the operator holds a key.
    await expect(status()).resolves.toEqual({
      capability: "dataforseo",
      requested: false,
      configured: false,
      ready: false,
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each([
    "/v3/serp/google/organic/tasks_ready",
    "/v3/serp/google/organic/tasks_fixed",
    "/v3/dataforseo_labs/id_list",
    "/v3/serp/errors",
    "/v3/appendix/errors",
    "/v3/appendix/user_data",
    "/v3/appendix/webhook_resend",
    "/v3/serp/google/organic/tasks%5Fready",
    "/v3/serp/google/organic/TASKS_READY",
    "/v3/serp/google/organic/tasks_ready/advanced",
    "/v3/serp/id_list;x",
    "/v3/serp/%E0%A4%A",
    "/v3/serp/google/organic/tasks_ready%20",
    "/v3/serp/google/organic/tasks_ready%00",
    "/v3/serp/google/organic/tasks_ready,",
    "/v3/serp/google/organic/tasks_ready%2C",
    "/v3/appendix//user_data",
  ])(
    "refuses DataForSEO's account-wide %s, which would show one app another's tasks",
    async (path) => {
      const fetchUpstream = vi.fn();
      await expectRefusal(
        call({
          manifest: LISTS_DATAFORSEO,
          path: `/api/integrations/dataforseo/api.dataforseo.com${path}`,
          method: "GET",
          fetchUpstream,
        }),
        403,
        "integration_path_not_allowed",
      );
      expect(fetchUpstream).not.toHaveBeenCalled();
    },
  );

  it("still serves a task's own results by id, and posting tasks", async () => {
    const response = await call({
      manifest: LISTS_DATAFORSEO,
      path: "/api/integrations/dataforseo/api.dataforseo.com/v3/serp/google/organic/task_get/advanced/09271234-1535-0066-0000-5c2f2a1f8d10",
      method: "GET",
    });
    expect(response.status).toBe(200);
    const posted = await call({
      manifest: LISTS_DATAFORSEO,
      path: "/api/integrations/dataforseo/api.dataforseo.com/v3/serp/google/organic/task_post",
    });
    expect(posted.status).toBe(200);
  });

  it("refuses methods the provider doesn't read with", async () => {
    await expectRefusal(
      call({ manifest: LISTS_DATAFORSEO, method: "DELETE" }),
      405,
      "integration_method_not_allowed",
    );
  });

  it("answers an unreachable provider with a refusal that never echoes the key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = await call({
      manifest: LISTS_DATAFORSEO,
      fetchUpstream: async () => {
        throw new Error("connection reset");
      },
    });

    expect(refused.status).toBe(502);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "integration_upstream_failed",
    );
    expect(await refused.text()).not.toContain("secret");
  });

  it("passes the provider's own errors through without the gateway's error header", async () => {
    const response = await call({
      manifest: LISTS_DATAFORSEO,
      fetchUpstream: async () =>
        Response.json(
          { status_code: 40100, status_message: "Not authorized" },
          { status: 401, headers: { "set-cookie": "provider=1" } },
        ),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-everyapp-error")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      status_code: 40100,
    });
  });

  it("logs the call's cost from the response, never its body or key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call({
      manifest: LISTS_DATAFORSEO,
      fetchUpstream: async () =>
        Response.json({ status_code: 20000, cost: 0.0125, tasks: [{}] }),
    });
    await response.text();

    expect(loggedCalls(log)[0]).toMatchObject({
      capability: "dataforseo",
      appId: "openseo",
      organizationId: "org-1",
      path: "/v3/serp/google/organic/live/advanced",
      status: 200,
      cost: 0.0125,
      attribution: "app",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  // In-isolate only: an app Worker that drops the body across the service
  // binding is never heard (response-tap.ts); the call is still counted at
  // the entrypoint when the provider answers (usage-counting.sqlite.test.ts).
  it("logs a call a reader in this isolate stopped reading, with the cost seen so far", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // The provider's envelope arrives, then the body stays open.
    const response = await call({
      manifest: LISTS_DATAFORSEO,
      fetchUpstream: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"status_code":20000,"cost":0.0125,"tasks":[',
                ),
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("the app gave up");

    expect(loggedCalls(log)).toEqual([
      expect.objectContaining({
        capability: "dataforseo",
        status: 200,
        cost: 0.0125,
      }),
    ]);
  });
});

describe("AppGateway refusals", () => {
  it("carry their code in x-everyapp-error, for the entrypoint's own refusals too", async () => {
    await expectRefusal(
      call({
        manifest: LISTS_DATAFORSEO,
        props: { ...PROPS, appId: "someone-else" },
      }),
      403,
      "caller_not_registered",
    );
    await expectRefusal(
      call({ manifest: LISTS_DATAFORSEO, path: "/api/other" }),
      404,
      "invalid_gateway_route",
    );
  });
});
