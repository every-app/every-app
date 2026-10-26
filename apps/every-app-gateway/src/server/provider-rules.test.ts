/**
 * The capability proxy against a provider registry: what the registry adds
 * to the rules the catalog's providers already pass (integration-proxy.test.ts),
 * each on a registered row the catalog doesn't have. The register's
 * `registry.write-needs-write-grant`, `registry.query-key-never-echoed`,
 * the hosted rule for account-wide data, a host setting, and the cost tap
 * running only where a spec names its field.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseProviderSpec,
  providerBindingKey,
  providerRegistry,
  type EveryAppUser,
} from "@every-app/sdk/internal";
import { handleIntegrationProxyRequest } from "./integration-proxy";

const ORIGIN = "http://every-app-gateway.internal";

/** A row as `everyapp secret set` leaves it: its key bound to the hosts it has. */
function bound(spec: Record<string, unknown>) {
  const parsed = parseProviderSpec(spec);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return {
    id: parsed.id,
    spec,
    boundTo: providerBindingKey(parsed.capability),
  };
}

// Fictional providers: none is in the built-in catalog.
const registry = providerRegistry([
  bound({
    id: "northwind",
    name: "Northwind",
    docs: "https://developer.northwind.io/keys",
    hosts: ["api.northwind.io"],
    auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
    access: ["read", "write"],
    readMethods: ["GET"],
    writeMethods: ["POST"],
  }),
  bound({
    id: "fabrikam",
    name: "Fabrikam",
    docs: "https://fabrikam.net/api",
    hosts: ["api.fabrikam.net"],
    auth: { kind: "query", secret: "FABRIKAM_API_KEY", param: "key" },
  }),
  bound({
    id: "adatum",
    name: "Adatum",
    docs: "https://developer.adatum.com/keys",
    hosts: ["api.adatum.com"],
    auth: { kind: "bearer", secret: "ADATUM_API_KEY" },
    data: "account",
  }),
  bound({
    id: "tailspin",
    name: "Tailspin",
    docs: "https://tailspin.example.com/docs",
    hostSetting: "TAILSPIN_HOST",
    auth: {
      kind: "header",
      secret: "TAILSPIN_API_TOKEN",
      header: "X-Tailspin-Token",
    },
  }),
  // A per-call search API: its POST is a read call.
  bound({
    id: "woodgrove",
    name: "Woodgrove",
    docs: "https://woodgrove.io/docs/api-keys",
    hosts: ["api.woodgrove.io"],
    auth: { kind: "bearer", secret: "WOODGROVE_API_KEY" },
    readMethods: ["POST"],
  }),
  // A sender: write-only, no read calls at all.
  bound({
    id: "wingtip",
    name: "Wingtip",
    docs: "https://wingtip.io/developer/api",
    hosts: ["api.wingtip.io"],
    auth: {
      kind: "header",
      secret: "WINGTIP_API_TOKEN",
      header: "X-Wingtip-Server-Token",
    },
    access: ["write"],
    readMethods: [],
    writeMethods: ["POST"],
  }),
]);

const ENV = {
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  NORTHWIND_API_KEY: "nw_key",
  FABRIKAM_API_KEY: "fb_key",
  ADATUM_API_KEY: "ad_key",
  TAILSPIN_API_TOKEN: "ts_key",
  TAILSPIN_HOST: "https://acme.tailspin.example.com",
  WOODGROVE_API_KEY: "wg_key",
  WINGTIP_API_TOKEN: "wt_key",
};

function agent(scopes: string[]): EveryAppUser {
  return {
    id: "user-1",
    email: "user@example.com",
    orgId: "org-1",
    orgRole: "member",
    channel: "mcp",
    actor: { kind: "agent", sub: "pat:1" } as never,
    scopes,
    jti: "j",
  };
}

async function call(options: {
  path: string;
  method?: string;
  entry?: { access: "read" | "write" };
  env?: Record<string, string>;
  user?: EveryAppUser | null;
  upstream?: () => Promise<Response>;
  onCost?: (report: { cost: number }) => void;
}) {
  const [, , , id] = options.path.split("/");
  const captured: Request[] = [];
  const response = await handleIntegrationProxyRequest({
    request: new Request(`${ORIGIN}${options.path}`, {
      method: options.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(options.method && options.method !== "GET" ? { body: "{}" } : {}),
    }),
    capabilities: { [id!]: options.entry ?? { access: "read" } },
    lookup: registry,
    env: options.env ?? ENV,
    admit: async () => ({
      caller: {
        organizationId: "org-1",
        appId: "app",
        worker: "every-app",
        orgSource: "props",
      },
      user: options.user ?? null,
    }),
    fetchUpstream: async (request) => {
      captured.push(request);
      return options.upstream
        ? options.upstream()
        : Response.json({ ok: true });
    },
    listMembers: async () => {
      throw new Error("not a service");
    },
    ...(options.onCost ? { onCost: options.onCost } : {}),
  });
  return { response, upstream: captured[0] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a registered provider through the proxy", () => {
  it("is brokered like a catalog one, with its key where its auth says", async () => {
    const { response, upstream } = await call({
      path: "/api/integrations/northwind/api.northwind.io/graphql?x=1",
    });
    expect(response.status).toBe(200);
    expect(upstream?.url).toBe("https://api.northwind.io/graphql?x=1");
    expect(upstream?.headers.get("authorization")).toBe("Bearer nw_key");
    expect(upstream?.redirect).toBe("manual");
    // A POST the spec lists as a read call goes through on the read grant.
    const woodgrove = await call({
      path: "/api/integrations/woodgrove/api.woodgrove.io/search",
      method: "POST",
    });
    expect(woodgrove.response.status).toBe(200);
    expect(woodgrove.upstream?.headers.get("authorization")).toBe(
      "Bearer wg_key",
    );
    expect(woodgrove.upstream?.headers.get("x-api-key")).toBeNull();
  });

  it("answers its status for an app that lists it, and configured only while its key is set", async () => {
    const listed = await call({ path: "/api/integrations/northwind" });
    await expect(listed.response.json()).resolves.toEqual({
      capability: "northwind",
      requested: true,
      configured: true,
      ready: true,
      settings: [],
      setup: null,
      command: null,
    });
    const unset = await call({
      path: "/api/integrations/northwind",
      env: { ...ENV, NORTHWIND_API_KEY: " " },
    });
    await expect(unset.response.json()).resolves.toMatchObject({
      configured: false,
      ready: false,
    });
  });

  it("has no read calls for a write-only provider: a GET is refused on any grant, a POST needs the write grant", async () => {
    const path = "/api/integrations/wingtip/api.wingtip.io/email";
    const get = await call({ path, entry: { access: "write" } });
    expect(get.response.status).toBe(405);
    await expect(get.response.json()).resolves.toMatchObject({
      code: "integration_method_not_allowed",
      message: "Wingtip calls may use POST.",
    });
    expect(get.upstream).toBeUndefined();
    const read = await call({
      path,
      method: "POST",
      entry: { access: "read" },
    });
    expect(read.response.status).toBe(405);
    await expect(read.response.json()).resolves.toMatchObject({
      code: "integration_method_not_allowed",
      message:
        'Wingtip offers no read calls; POST needs access: "write" in the app\'s capabilities entry.',
    });
    expect(read.upstream).toBeUndefined();
    const write = await call({
      path,
      method: "POST",
      entry: { access: "write" },
    });
    expect(write.response.status).toBe(200);
    expect(write.upstream?.headers.get("x-wingtip-server-token")).toBe(
      "wt_key",
    );
  });

  it("forwards a write method only under a write grant, and never for a read-only agent", async () => {
    const path = "/api/integrations/northwind/api.northwind.io/graphql";
    const read = await call({
      path,
      method: "POST",
      entry: { access: "read" },
    });
    expect(read.response.status).toBe(405);
    await expect(read.response.json()).resolves.toMatchObject({
      code: "integration_method_not_allowed",
      message:
        'Northwind calls may use GET with access: "read"; POST needs access: "write" in the app\'s capabilities entry.',
    });
    expect(read.upstream).toBeUndefined();

    const write = await call({
      path,
      method: "POST",
      entry: { access: "write" },
    });
    expect(write.response.status).toBe(200);
    expect(write.upstream?.method).toBe("POST");

    // A method the spec doesn't list for writing stays closed.
    const del = await call({
      path,
      method: "DELETE",
      entry: { access: "write" },
    });
    expect(del.response.status).toBe(405);
    await expect(del.response.json()).resolves.toMatchObject({
      message: "Northwind calls may use GET or POST.",
    });

    const readOnlyAgent = await call({
      path,
      method: "POST",
      entry: { access: "write" },
      user: agent(["mcp:read"]),
    });
    expect(readOnlyAgent.response.status).toBe(403);
    await expect(readOnlyAgent.response.json()).resolves.toMatchObject({
      code: "integration_read_only",
    });
    expect(readOnlyAgent.upstream).toBeUndefined();
    const writingAgent = await call({
      path,
      method: "POST",
      entry: { access: "write" },
      user: agent(["mcp:write"]),
    });
    expect(writingAgent.response.status).toBe(200);
    // Reads need no write scope.
    const readingAgent = await call({ path, user: agent(["mcp:read"]) });
    expect(readingAgent.response.status).toBe(200);
  });

  it("puts a query key on the URL in place of the app's, relays no redirect and no URL-naming header, and logs no message on failure", async () => {
    const path =
      "/api/integrations/fabrikam/api.fabrikam.net/v1/weather?q=Berlin&key=app-copy";
    const ok = await call({
      path,
      upstream: async () =>
        new Response("{}", {
          headers: {
            location: "https://api.fabrikam.net/x?key=fb_key",
            "content-location": "/y",
            refresh: "0",
            "x-rate": "1",
          },
        }),
    });
    expect(ok.upstream?.url).toBe(
      "https://api.fabrikam.net/v1/weather?q=Berlin&key=fb_key",
    );
    expect(ok.response.status).toBe(200);
    expect(ok.response.headers.get("location")).toBeNull();
    expect(ok.response.headers.get("content-location")).toBeNull();
    expect(ok.response.headers.get("refresh")).toBeNull();
    expect(ok.response.headers.get("x-rate")).toBe("1");

    const redirected = await call({
      path,
      upstream: async () =>
        new Response(null, {
          status: 301,
          headers: {
            location: "https://api.fabrikam.net/v1/weather/?key=fb_key",
          },
        }),
    });
    expect(redirected.response.status).toBe(502);
    await expect(redirected.response.json()).resolves.toMatchObject({
      code: "integration_upstream_redirected",
    });
    expect(redirected.response.headers.get("location")).toBeNull();

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await call({
      path,
      upstream: async () => {
        throw new TypeError(
          "fetch failed: https://api.fabrikam.net/v1/weather?key=fb_key",
        );
      },
    });
    expect(failed.response.status).toBe(502);
    const line = JSON.parse(String(error.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(line["evt"]).toBe("integration.proxy.upstream_failed");
    expect(line["error"]).toBe("TypeError");
    expect(JSON.stringify(line)).not.toContain("fb_key");
  });

  it("scrubs the key from a text answer of a query-key provider, passes a binary answer through, and refuses a text answer past the bound", async () => {
    const path = "/api/integrations/fabrikam/api.fabrikam.net/v1/tiles.json";
    // A value the URL form encodes, so both spellings must go.
    const env = { ...ENV, FABRIKAM_API_KEY: "fb/key+1" };
    const json = await call({
      path,
      env,
      upstream: async () =>
        new Response(
          JSON.stringify({
            tiles: [
              "https://api.fabrikam.net/t/{z}/{x}/{y}.png?key=fb%2Fkey%2B1",
            ],
            raw: "https://api.fabrikam.net/t?key=fb/key+1",
            n: 1,
          }),
          {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-length": "999",
            },
          },
        ),
    });
    expect(json.upstream?.url).toBe(
      "https://api.fabrikam.net/v1/tiles.json?key=fb%2Fkey%2B1",
    );
    expect(json.response.status).toBe(200);
    const text = await json.response.text();
    expect(text).not.toContain("fb/key+1");
    expect(text).not.toContain("fb%2Fkey%2B1");
    expect(text).toContain("?key=[redacted]");
    expect(json.response.headers.get("content-length")).toBeNull();
    expect(JSON.parse(text)).toMatchObject({ n: 1 });

    const png = await call({
      path: "/api/integrations/fabrikam/api.fabrikam.net/t/1/2/3.png",
      upstream: async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        }),
    });
    expect(png.response.status).toBe(200);
    expect(new Uint8Array(await png.response.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );

    const big = await call({
      path,
      upstream: async () =>
        new Response("x".repeat(4 * 1024 * 1024 + 1), {
          headers: { "content-type": "text/plain" },
        }),
    });
    expect(big.response.status).toBe(502);
    await expect(big.response.json()).resolves.toMatchObject({
      code: "integration_upstream_failed",
    });
  });

  it("serves an account-wide provider on a self-hosted gateway and refuses it on a hosted one", async () => {
    const path = "/api/integrations/adatum/api.adatum.com/v1/customers";
    expect((await call({ path })).response.status).toBe(200);
    const hosted = await call({
      path,
      env: { ...ENV, GATEWAY_DEPLOYMENT_MODE: "hosted" },
    });
    expect(hosted.response.status).toBe(503);
    await expect(hosted.response.json()).resolves.toMatchObject({
      code: "integration_not_available_hosted",
    });
    expect(hosted.upstream).toBeUndefined();
  });

  it("reaches the host a provider's host setting names, and no other", async () => {
    const shop = await call({
      path: "/api/integrations/tailspin/acme.tailspin.example.com/admin/api/2024-10/orders.json",
    });
    expect(shop.response.status).toBe(200);
    expect(shop.upstream?.url).toBe(
      "https://acme.tailspin.example.com/admin/api/2024-10/orders.json",
    );
    expect(shop.upstream?.headers.get("x-tailspin-token")).toBe("ts_key");
    const other = await call({
      path: "/api/integrations/tailspin/other.tailspin.example.com/admin/api/2024-10/orders.json",
    });
    expect(other.response.status).toBe(400);
    await expect(other.response.json()).resolves.toMatchObject({
      code: "invalid_integration_route",
    });
    // Without the setting the provider has no host at all.
    const unset = await call({
      path: "/api/integrations/tailspin/acme.tailspin.example.com/admin/api/2024-10/orders.json",
      env: { ...ENV, TAILSPIN_HOST: "" },
    });
    expect(unset.response.status).toBe(400);
  });

  it("reads a cost off the answer only where the provider's entry names the field", async () => {
    const onCost = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { response } = await call({
      path: "/api/integrations/northwind/api.northwind.io/graphql",
      upstream: async () => Response.json({ cost: 12.5, data: {} }),
      onCost,
    });
    await response.text();
    expect(onCost).not.toHaveBeenCalled();
    const lines = log.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .filter((entry) => entry["evt"] === "integration.proxy.call");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveProperty("cost");
  });

  it("never routes an AI provider or an unknown id through the capability proxy", async () => {
    for (const path of [
      "/api/integrations/openrouter/openrouter.ai/api/v1/credits",
      "/api/integrations/nope/api.nope.example/v2/payments",
    ]) {
      const { response, upstream } = await call({ path });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_integration_route",
      });
      expect(upstream).toBeUndefined();
    }
  });
});
