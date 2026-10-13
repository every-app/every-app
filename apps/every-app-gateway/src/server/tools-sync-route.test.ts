import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByAppSlug: vi.fn(),
  syncAppTools: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/repositories/AppRepository", () => ({
  AppRepository: { findByAppSlug: mocks.findByAppSlug },
  DELETED_APP_STATUS: "deleted",
}));
vi.mock("@/server/toolbus/catalog-sync", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/toolbus/catalog-sync")>();
  return {
    BindingNotReadyError: actual.BindingNotReadyError,
    logToolSync: vi.fn(),
    syncAppTools: mocks.syncAppTools,
  };
});

import { Route } from "@/routes/api/deploy/apps/$appId/tools/sync";
import { BindingNotReadyError } from "@/server/toolbus/catalog-sync";

const ROW = {
  id: "row-1",
  organizationId: "org-123",
  appSlug: "todo",
  hostname: "todo-acme.gateway.example.com",
  workerName: "every-todo",
  tier: "service_binding",
  status: "active",
};

function post(appId: string): Promise<Response> {
  const handler = (Route as any).options.server.handlers.POST as (input: {
    params: { appId: string };
    context: { organizationId: string };
  }) => Promise<Response>;
  return handler({ params: { appId }, context: { organizationId: "org-123" } });
}

describe("POST /api/deploy/apps/$appId/tools/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs a registered app of the deploy token's organization", async () => {
    mocks.findByAppSlug.mockResolvedValue(ROW);
    mocks.syncAppTools.mockResolvedValue({
      status: "ok",
      toolCount: 3,
      catalogHash: "sha256:x",
      sdkVersion: "0.3.0",
      warnings: ["big_tool: skipped"],
    });

    const response = await post("todo");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      appId: "todo",
      status: "ok",
      toolCount: 3,
      catalogHash: "sha256:x",
      sdkVersion: "0.3.0",
      warnings: ["big_tool: skipped"],
    });
    expect(mocks.findByAppSlug).toHaveBeenCalledWith("todo", "org-123");
    expect(mocks.syncAppTools).toHaveBeenCalledWith({
      rowId: "row-1",
      organizationId: "org-123",
      appSlug: "todo",
      hostname: "todo-acme.gateway.example.com",
      workerName: "every-todo",
      tier: "service_binding",
    });
  });

  it("404s apps that aren't registered (or were deleted)", async () => {
    for (const row of [undefined, { ...ROW, status: "deleted" }]) {
      mocks.findByAppSlug.mockResolvedValue(row);
      const response = await post("todo");
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "APP_NOT_FOUND" });
    }
    expect(mocks.syncAppTools).not.toHaveBeenCalled();
  });

  it("refuses an app that has no uploaded Worker yet, as activate does", async () => {
    mocks.findByAppSlug.mockResolvedValue({ ...ROW, status: "pending" });
    const response = await post("todo");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NOT_DEPLOYED" });
    expect(mocks.syncAppTools).not.toHaveBeenCalled();
  });

  it("answers 503 while the app's binding is rolling out", async () => {
    mocks.findByAppSlug.mockResolvedValue(ROW);
    mocks.syncAppTools.mockRejectedValue(
      new BindingNotReadyError("no binding"),
    );
    const response = await post("todo");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "BINDING_NOT_READY" });
  });
});
