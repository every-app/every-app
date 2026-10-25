/**
 * The capability proxy against a provider registry: what the registry adds
 * to the rules the catalog's providers already pass (integration-proxy.test.ts),
 * each on a registered row the catalog doesn't have. The register's
 * `registry.write-needs-write-grant`, `registry.query-key-never-echoed`,
 * the hosted rule for account-wide data, a host setting, and the cost tap
 * running only where a spec names its field.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerRegistry, type EveryAppUser } from "@every-app/sdk/internal";
import { handleIntegrationProxyRequest } from "./integration-proxy";

const ORIGIN = "http://every-app-gateway.internal";

const registry = providerRegistry([
  {
    id: "linear",
    spec: {
      id: "linear",
      name: "Linear",
      docs: "https://linear.app/settings/api",
      hosts: ["api.linear.app"],
      auth: { kind: "bearer", secret: "LINEAR_API_KEY" },
      access: ["read", "write"],
      readMethods: ["GET"],
      writeMethods: ["POST"],
    },
  },
  {
    id: "openweather",
    spec: {
      id: "openweather",
      name: "OpenWeather",
      docs: "https://home.openweathermap.org/api_keys",
      hosts: ["api.openweathermap.org"],
      auth: { kind: "query", secret: "OPENWEATHER_API_KEY", param: "appid" },
    },
  },
  {
    id: "stripe",
    spec: {
      id: "stripe",
      name: "Stripe",
      docs: "https://dashboard.stripe.com/apikeys",
      hosts: ["api.stripe.com"],
      auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
      data: "account",
    },
  },
  {
    id: "shopify",
    spec: {
      id: "shopify",
      name: "Shopify",
      docs: "https://shopify.dev/",
      hostSetting: "SHOPIFY_HOST",
      auth: {
        kind: "header",
        secret: "SHOPIFY_API_KEY",
        header: "X-Shopify-Access-Token",
      },
    },
  },
  {
    id: "exa",
    spec: {
      id: "exa",
      name: "Exa",
      docs: "https://dashboard.exa.ai/api-keys",
      hosts: ["api.exa.ai"],
      auth: { kind: "header", secret: "EXA_API_KEY", header: "x-api-key" },
      readMethods: ["POST"],
    },
  },
]);

const ENV = {
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  LINEAR_API_KEY: "lin_key",
  OPENWEATHER_API_KEY: "ow_key",
  STRIPE_API_KEY: "sk_key",
  SHOPIFY_API_KEY: "shpat_key",
  SHOPIFY_HOST: "https://acme.myshopify.com",
  EXA_API_KEY: "exa_key",
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
      path: "/api/integrations/linear/api.linear.app/graphql?x=1",
    });
    expect(response.status).toBe(200);
    expect(upstream?.url).toBe("https://api.linear.app/graphql?x=1");
    expect(upstream?.headers.get("authorization")).toBe("Bearer lin_key");
    expect(upstream?.redirect).toBe("manual");
    const exa = await call({
      path: "/api/integrations/exa/api.exa.ai/search",
      method: "POST",
    });
    expect(exa.upstream?.headers.get("x-api-key")).toBe("exa_key");
    expect(exa.upstream?.headers.get("authorization")).toBeNull();
  });

  it("answers its status for an app that lists it, and configured only while its key is set", async () => {
    const listed = await call({ path: "/api/integrations/linear" });
    await expect(listed.response.json()).resolves.toEqual({
      capability: "linear",
      requested: true,
      configured: true,
      ready: true,
    });
    const unset = await call({
      path: "/api/integrations/linear",
      env: { ...ENV, LINEAR_API_KEY: " " },
    });
    await expect(unset.response.json()).resolves.toMatchObject({
      configured: false,
      ready: false,
    });
  });

  it("forwards a write method only under a write grant, and never for a read-only agent", async () => {
    const path = "/api/integrations/linear/api.linear.app/graphql";
    const read = await call({
      path,
      method: "POST",
      entry: { access: "read" },
    });
    expect(read.response.status).toBe(405);
    await expect(read.response.json()).resolves.toMatchObject({
      code: "integration_method_not_allowed",
      message:
        'Linear calls may use GET with access: "read"; POST needs access: "write" in the app\'s capabilities entry.',
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
      message: "Linear calls may use GET or POST.",
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
      "/api/integrations/openweather/api.openweathermap.org/data/2.5/weather?q=Berlin&appid=app-copy";
    const ok = await call({
      path,
      upstream: async () =>
        new Response("{}", {
          headers: {
            location: "https://api.openweathermap.org/x?appid=ow_key",
            "content-location": "/y",
            refresh: "0",
            "x-rate": "1",
          },
        }),
    });
    expect(ok.upstream?.url).toBe(
      "https://api.openweathermap.org/data/2.5/weather?q=Berlin&appid=ow_key",
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
            location:
              "https://api.openweathermap.org/data/2.5/weather/?appid=ow_key",
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
          "fetch failed: https://api.openweathermap.org/data/2.5/weather?appid=ow_key",
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
    expect(JSON.stringify(line)).not.toContain("ow_key");
  });

  it("serves an account-wide provider on a self-hosted gateway and refuses it on a hosted one", async () => {
    const path = "/api/integrations/stripe/api.stripe.com/v1/customers";
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
      path: "/api/integrations/shopify/acme.myshopify.com/admin/api/2024-10/orders.json",
    });
    expect(shop.response.status).toBe(200);
    expect(shop.upstream?.url).toBe(
      "https://acme.myshopify.com/admin/api/2024-10/orders.json",
    );
    expect(shop.upstream?.headers.get("x-shopify-access-token")).toBe(
      "shpat_key",
    );
    const other = await call({
      path: "/api/integrations/shopify/other.myshopify.com/admin/api/2024-10/orders.json",
    });
    expect(other.response.status).toBe(400);
    await expect(other.response.json()).resolves.toMatchObject({
      code: "invalid_integration_route",
    });
    // Without the setting the provider has no host at all.
    const unset = await call({
      path: "/api/integrations/shopify/acme.myshopify.com/admin/api/2024-10/orders.json",
      env: { ...ENV, SHOPIFY_HOST: "" },
    });
    expect(unset.response.status).toBe(400);
  });

  it("reads a cost off the answer only where the provider's entry names the field", async () => {
    const onCost = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { response } = await call({
      path: "/api/integrations/linear/api.linear.app/graphql",
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
      "/api/integrations/square/connect.squareup.com/v2/payments",
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
