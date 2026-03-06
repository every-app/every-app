import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/repositories/AppRepository", () => ({
  AppRepository: {
    findByAppId: vi.fn(),
  },
}));

import { Route } from "./context";
import { AppRepository } from "@/server/repositories/AppRepository";

function getHandler() {
  return (Route as any).options.server.handlers.GET as (context: {
    request: Request;
  }) => Promise<Response>;
}

describe("/api/internal/apps/context", () => {
  it("returns 400 when required query params are missing", async () => {
    const response = await getHandler()({
      request: new Request(
        "https://gateway.example.com/api/internal/apps/context",
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "organizationId and appId are required",
    });
  });

  it("returns existing app context when app is present", async () => {
    vi.mocked(AppRepository.findByAppId).mockResolvedValue({
      id: "app-row-1",
      appId: "todo-app",
      isDefault: true,
    } as Awaited<ReturnType<typeof AppRepository.findByAppId>>);

    const response = await getHandler()({
      request: new Request(
        "https://gateway.example.com/api/internal/apps/context?organizationId=org-123&appId=todo-app",
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      existingApp: true,
      app: {
        id: "app-row-1",
        appId: "todo-app",
        isDefault: true,
      },
    });
  });
});
