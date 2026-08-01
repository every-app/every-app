import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRegistry, RegisteredApp } from "@every-app/perimeter";
import server, {
  clearHostnameCacheForTests,
  resolveAppByHostname,
} from "./server";
import { validateManifest } from "@every-app/perimeter/manifest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  hasAnyActiveApp: vi.fn(),
  findByHostname: vi.fn(),
  authenticate: vi.fn(),
  controlPlaneFetch: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mocks.env,
  WorkerEntrypoint: class {},
}));

// The provider library imports cloudflare:workers from node_modules, where
// the vi.mock above cannot reach — keep it out of the module graph entirely.
// The provider library imports cloudflare:workers from node_modules, where
// vi.mock cannot reach — stub the module, but keep the real control-plane
// delegation so host-dispatch tests still observe control-plane serving.
vi.mock("@/server/oauth-provider", () => ({
  getOauthProvider: vi.fn(() => ({
    fetch: async (request: Request, env: unknown) => {
      const { serveControlPlane } = await import("@/server/control-plane");
      return serveControlPlane(request, env as { ASSETS?: never });
    },
  })),
  syntheticExecutionContext: () => ({
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  }),
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: mocks.controlPlaneFetch },
  createServerEntry: (entry: unknown) => entry,
}));

vi.mock("./perimeter/drizzleAppRegistry", () => ({
  DrizzleAppRegistry: class {
    hasAnyActiveApp = mocks.hasAnyActiveApp;
    findByHostname = mocks.findByHostname;
  },
}));

vi.mock("./perimeter/betterAuthAuthenticator", () => ({
  createProdAuthenticator: () => ({
    authenticate: mocks.authenticate,
    hasAppAccess: vi.fn(async () => true),
  }),
}));

const TODO: RegisteredApp = {
  appId: "todo",
  hostname: "todo.example.com",
  workerName: "every-todo",
  tier: "service_binding",
  organizationId: "org-1",
  status: "active",
  manifest: validateManifest({ id: "todo" }),
};

function registryReturning(app: RegisteredApp | null): AppRegistry & {
  findByHostname: ReturnType<typeof vi.fn>;
} {
  return {
    hasAnyActiveApp: vi.fn(async () => app?.status === "active"),
    findByHostname: vi.fn(async () => app),
    findByAppId: vi.fn(async () => app),
    findByOrgApp: vi.fn(async () => app),
  };
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("strict-transport-security")).toBe(
    "max-age=63072000; includeSubDomains; preload",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe(
    "strict-origin-when-cross-origin",
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hostname app cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    clearHostnameCacheForTests();
  });

  it("caches hostname hits for 30 seconds", async () => {
    const registry = registryReturning(TODO);

    await expect(
      resolveAppByHostname(registry, "todo.example.com"),
    ).resolves.toBe(TODO);
    await expect(
      resolveAppByHostname(registry, "todo.example.com"),
    ).resolves.toBe(TODO);
    expect(registry.findByHostname).toHaveBeenCalledTimes(1);

    vi.setSystemTime(30_001);
    await resolveAppByHostname(registry, "todo.example.com");
    expect(registry.findByHostname).toHaveBeenCalledTimes(2);
  });

  it("caches hostname misses for 5 seconds", async () => {
    const registry = registryReturning(null);

    await expect(
      resolveAppByHostname(registry, "missing.example.com"),
    ).resolves.toBeNull();
    await expect(
      resolveAppByHostname(registry, "missing.example.com"),
    ).resolves.toBeNull();
    expect(registry.findByHostname).toHaveBeenCalledTimes(1);

    vi.setSystemTime(5_001);
    await resolveAppByHostname(registry, "missing.example.com");
    expect(registry.findByHostname).toHaveBeenCalledTimes(2);
  });
});

describe("gateway-generated errors", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearHostnameCacheForTests();
    mocks.hasAnyActiveApp.mockReset();
    mocks.findByHostname.mockReset();
    mocks.authenticate.mockReset();
    mocks.controlPlaneFetch.mockReset();
    mocks.controlPlaneFetch.mockResolvedValue(new Response("control plane"));
    for (const key of Object.keys(mocks.env)) delete mocks.env[key];
    Object.assign(mocks.env, {
      DB: {},
      GATEWAY_URL: "https://example.com",
      JWT_PRIVATE_KEY: "unused in these tests",
    });
  });

  it("serves the control plane without GATEWAY_URL when the registry is empty", async () => {
    delete mocks.env.GATEWAY_URL;
    mocks.hasAnyActiveApp.mockResolvedValue(false);

    const request = new Request("https://fresh.example.com/", {
      headers: { host: "fresh.example.com" },
    });
    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("control plane");
    expect(mocks.hasAnyActiveApp).toHaveBeenCalledOnce();
    expect(mocks.controlPlaneFetch).toHaveBeenCalledWith(request);
  });

  it("serves the control plane when the registry query throws (unmigrated build-time DB)", async () => {
    delete mocks.env.GATEWAY_URL;
    mocks.hasAnyActiveApp.mockRejectedValue(new Error("no such table: apps"));

    const request = new Request("https://fresh.example.com/", {
      headers: { host: "fresh.example.com" },
    });
    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("control plane");
  });

  it("fails closed without GATEWAY_URL when an active app is registered", async () => {
    delete mocks.env.GATEWAY_URL;
    mocks.hasAnyActiveApp.mockResolvedValue(true);

    const response = await server.fetch(
      new Request("https://todo.example.com/", {
        headers: { host: "todo.example.com" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "gateway_misconfigured",
    });
    expectSecurityHeaders(response);
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("stamps security headers on an unknown app host 404", async () => {
    mocks.findByHostname.mockResolvedValue(null);

    const response = await server.fetch(
      new Request("https://missing.example.com/", {
        headers: { host: "missing.example.com" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_app_host" });
    expectSecurityHeaders(response);
  });

  it("treats a failed app lookup as no app and never serves app content", async () => {
    mocks.findByHostname.mockRejectedValue(new Error("no such table: apps"));

    const wildcardResponse = await server.fetch(
      new Request("https://missing.example.com/", {
        headers: { host: "missing.example.com" },
      }),
    );
    expect(wildcardResponse.status).toBe(404);
    expect(await wildcardResponse.json()).toEqual({
      error: "unknown_app_host",
    });

    const unrelatedResponse = await server.fetch(
      new Request("https://prerender.local/", {
        headers: { host: "prerender.local" },
      }),
    );
    expect(unrelatedResponse.status).toBe(200);
    expect(await unrelatedResponse.text()).toBe("control plane");
  });

  it("stamps security headers on a perimeter-error 502", async () => {
    mocks.findByHostname.mockResolvedValue(TODO);
    mocks.authenticate.mockRejectedValue(new Error("authentication failed"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await server.fetch(
      new Request("https://todo.example.com/", {
        headers: { host: "todo.example.com" },
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_error" });
    expectSecurityHeaders(response);
    consoleError.mockRestore();
  });
});
