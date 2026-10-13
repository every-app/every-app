import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLimit, mockWhere, mockFrom, mockSelect } = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({
    limit,
  }));
  const from = vi.fn(() => ({
    where,
  }));
  const select = vi.fn(() => ({
    from,
  }));

  return {
    mockLimit: limit,
    mockWhere: where,
    mockFrom: from,
    mockSelect: select,
  };
});

const workerEnv = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock("cloudflare:workers", () => ({
  env: workerEnv,
}));

const verifyDeployToken = vi.hoisted(() => vi.fn());
vi.mock("@/server/services/AppTokenService", () => ({
  AppTokenService: { verifyDeployToken },
}));

vi.mock("@/server/services/AppRegistrationService", () => ({
  AppRegistrationError: class AppRegistrationError extends Error {
    status: number;
    code?: string;

    constructor({
      message,
      status,
      code,
    }: {
      message: string;
      status: number;
      code?: string;
    }) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  AppRegistrationService: {
    register: vi.fn(),
    markDeployed: vi.fn(),
    activate: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/db", () => ({
  db: {
    select: mockSelect,
  },
}));

vi.mock("@/db/schema", () => ({
  organizations: {
    id: "id",
    name: "name",
  },
}));

import { createHash } from "node:crypto";
import {
  AppRegistrationError,
  AppRegistrationService,
} from "@/server/services/AppRegistrationService";
import { probeAppBinding } from "@/server/deploy-api";
import { Route as RegisterRoute } from "@/routes/api/deploy/register";
import { Route as WhoamiRoute } from "@/routes/api/deploy/whoami";
import { Route as StatusRoute } from "@/routes/api/deploy/status";
import { Route as DeployedRoute } from "@/routes/api/deploy/apps/$appId/deployed";
import { Route as ActivateRoute } from "@/routes/api/deploy/apps/$appId/activate";
import { Route as DeleteRoute } from "@/routes/api/deploy/apps/$appId/delete";

type Handler = (context: {
  request: Request;
  params: { appId: string };
  context: typeof deployContext;
}) => Promise<Response>;

function handler(route: unknown, method: "GET" | "POST"): Handler {
  return (route as any).options.server.handlers[method] as Handler;
}

function post(path: string, body?: unknown): Request {
  return new Request(`https://gateway.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const mockAppRegistrationService = vi.mocked(AppRegistrationService);

const deployContext = {
  organizationId: "org-123",
  createdBy: "user-1",
  scopes: ["apps:register", "apps:deploy"],
};

describe("deploy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(workerEnv)) delete workerEnv[key];
  });

  it("ignores unknown fields when registering", async () => {
    mockAppRegistrationService.register.mockResolvedValue({
      appId: "app-row-1",
      appRowId: "app-row-1",
      appSlug: "todo-app",
      status: "active",
      workerName: "every-todo",
      hostname: "todo-app-acme.gateway.example.com",
      legacyNames: true,
      resources: { d1: {}, kv: {} },
      previousManifest: { id: "todo-app" },
      versionId: null,
      existingApp: true,
      defaultAccess: true,
      grantedUserCount: 0,
    });

    const handler = (RegisterRoute as any).options.server.handlers
      .POST as (context: {
      request: Request;
      context: typeof deployContext;
    }) => Promise<Response>;
    const response = await handler({
      request: new Request("https://gateway.example.com/api/deploy/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "todo-app",
          name: "Todo",
          description: "A todo app",
          workerName: "every-todo",
          manifest: { id: "todo-app" },
          unexpectedField: "ignored",
        }),
      }),
      context: deployContext,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      hostname: "todo-app-acme.gateway.example.com",
    });
    expect(mockAppRegistrationService.register).toHaveBeenCalledWith({
      organizationId: "org-123",
      appSlug: "todo-app",
      name: "Todo",
      description: "A todo app",
      workerName: "every-todo",
      manifest: { id: "todo-app" },
      deployerUserId: "user-1",
    });
  });

  it("returns the deploy-token organization and scopes", async () => {
    mockLimit.mockResolvedValue([{ name: "Acme" }]);

    const handler = (WhoamiRoute as any).options.server.handlers
      .GET as (context: { context: typeof deployContext }) => Promise<Response>;
    const response = await handler({ context: deployContext });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organizationId: "org-123",
      organizationName: "Acme",
      scopes: ["apps:register", "apps:deploy"],
      capabilities: { appGateway: true, deployProtocol: 2 },
      minCli: "0.3.0",
    });
    expect(mockSelect).toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalled();
  });

  it("tells the CLI the gateway's account, host and release", async () => {
    mockLimit.mockResolvedValue([{ name: "Acme" }]);
    Object.assign(workerEnv, {
      CLOUDFLARE_ACCOUNT_ID: "account-1",
      GATEWAY_URL: "https://gateway.example.com",
      EVERYAPP_RELEASE: { version: "0.3.0", sha256: "abc" },
    });

    const response = await handler(
      WhoamiRoute,
      "GET",
    )({
      request: new Request("https://gateway.example.com/api/deploy/whoami"),
      params: { appId: "" },
      context: deployContext,
    });
    await expect(response.json()).resolves.toMatchObject({
      accountId: "account-1",
      gateway: {
        release: { version: "0.3.0", sha256: "abc" },
        gatewayHost: "gateway.example.com",
      },
    });
  });

  it("records an uploaded version with the manifest it was built from", async () => {
    mockAppRegistrationService.markDeployed.mockResolvedValue({
      status: "binding",
      workerName: "every-acme-todo",
      hostname: "todo-acme.gateway.example.com",
    });

    const response = await handler(
      DeployedRoute,
      "POST",
    )({
      request: post("/api/deploy/apps/todo/deployed", {
        versionId: "version-1",
        manifest: { id: "todo" },
      }),
      params: { appId: "todo" },
      context: deployContext,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "binding",
    });
    expect(mockAppRegistrationService.markDeployed).toHaveBeenCalledWith({
      organizationId: "org-123",
      appSlug: "todo",
      versionId: "version-1",
      manifest: { id: "todo" },
    });

    const missingVersion = await handler(
      DeployedRoute,
      "POST",
    )({
      request: post("/api/deploy/apps/todo/deployed", { manifest: {} }),
      params: { appId: "todo" },
      context: deployContext,
    });
    expect(missingVersion.status).toBe(400);
  });

  it("answers BINDING_NOT_READY until the gateway reaches the app", async () => {
    mockAppRegistrationService.activate.mockRejectedValue(
      new AppRegistrationError({
        status: 409,
        code: "BINDING_NOT_READY",
        message: "not yet",
      }),
    );

    const response = await handler(
      ActivateRoute,
      "POST",
    )({
      request: post("/api/deploy/apps/todo/activate"),
      params: { appId: "todo" },
      context: deployContext,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "BINDING_NOT_READY",
    });
    expect(mockAppRegistrationService.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-123",
        appSlug: "todo",
        probe: expect.any(Function),
      }),
    );
  });

  it("probes an app through the gateway's service binding to it", async () => {
    const app = {
      workerName: "every-acme-todo",
      hostname: "todo-acme.gateway.example.com",
    };
    const fetch = vi.fn(
      async () => new Response("unauthenticated", { status: 401 }),
    );
    await expect(
      probeAppBinding({ "APP__every-acme-todo": { fetch } }, app),
    ).resolves.toBe(true);
    expect((fetch.mock.calls[0] as unknown as [Request])[0].url).toBe(
      "https://todo-acme.gateway.example.com/__everyapp/health",
    );

    await expect(probeAppBinding({}, app)).resolves.toBe(false);
    await expect(
      probeAppBinding(
        {
          "APP__every-acme-todo": {
            fetch: async () => {
              throw new Error("no such worker");
            },
          },
        },
        app,
      ),
    ).resolves.toBe(false);
  });

  it("deletes an app and answers with what to unbind and purge", async () => {
    mockAppRegistrationService.delete.mockResolvedValue({
      status: "deleted",
      workerName: "every-acme-todo",
      hostname: "todo-acme.gateway.example.com",
      legacyNames: false,
      resources: { d1: { DB: "every-acme-todo" }, kv: {} },
    });

    const response = await handler(
      DeleteRoute,
      "POST",
    )({
      request: post("/api/deploy/apps/todo/delete"),
      params: { appId: "todo" },
      context: deployContext,
    });

    await expect(response.json()).resolves.toMatchObject({
      status: "deleted",
      workerName: "every-acme-todo",
    });
    expect(mockAppRegistrationService.delete).toHaveBeenCalledWith({
      organizationId: "org-123",
      appSlug: "todo",
    });
  });

  describe("status", () => {
    const statusRequest = (headers: Record<string, string> = {}) =>
      handler(
        StatusRoute,
        "GET",
      )({
        request: new Request("https://gateway.example.com/api/deploy/status", {
          headers,
        }),
        params: { appId: "" },
        context: deployContext,
      });

    beforeEach(() => {
      Object.assign(workerEnv, {
        GATEWAY_URL: "https://gateway.example.com",
        GATEWAY_DEPLOYMENT_MODE: "self_hosted",
        EVERYAPP_RELEASE: { version: "0.3.0", sha256: "abc" },
        CF_VERSION_METADATA: { id: "version-9", tag: "", timestamp: "" },
        BETTER_AUTH_SECRET: "never-shown",
        "APP__every-acme-todo": { fetch: vi.fn() },
        "APP__every-acme-chef": { fetch: vi.fn() },
      });
    });

    it("reports the live release, version and a digest of the bound apps, publicly", async () => {
      const response = await statusRequest();
      const body = await response.json();

      expect(body).toEqual({
        release: { version: "0.3.0", sha256: "abc" },
        versionId: "version-9",
        appBindingsDigest: createHash("sha256")
          .update("APP__every-acme-chef\nAPP__every-acme-todo")
          .digest("hex"),
      });
      expect(JSON.stringify(body)).not.toContain("never-shown");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(verifyDeployToken).not.toHaveBeenCalled();
    });

    it("lists the bound apps for a deploy token, and refuses a bad one", async () => {
      verifyDeployToken.mockResolvedValueOnce(deployContext);
      const listed = await statusRequest({ authorization: "Bearer eak_good" });
      await expect(listed.json()).resolves.toMatchObject({
        gatewayHost: "gateway.example.com",
        appBindings: ["every-acme-chef", "every-acme-todo"],
      });

      verifyDeployToken.mockResolvedValueOnce(null);
      const refused = await statusRequest({ authorization: "Bearer eak_bad" });
      expect(refused.status).toBe(401);
    });
  });
});
