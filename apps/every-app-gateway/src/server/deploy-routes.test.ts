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

vi.mock("cloudflare:workers", () => ({
  env: {},
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

import { AppRegistrationService } from "@/server/services/AppRegistrationService";
import { Route as RegisterRoute } from "@/routes/api/deploy/register";
import { Route as WhoamiRoute } from "@/routes/api/deploy/whoami";

const mockAppRegistrationService = vi.mocked(AppRegistrationService);

const deployContext = {
  organizationId: "org-123",
  scopes: ["apps:register", "apps:deploy"],
};

describe("deploy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores unknown fields when registering", async () => {
    mockAppRegistrationService.register.mockResolvedValue({
      appId: "app-row-1",
      appSlug: "todo-app",
      hostname: "todo-app-acme.gateway.example.com",
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
      capabilities: { appGateway: true },
    });
    expect(mockSelect).toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalled();
  });
});
