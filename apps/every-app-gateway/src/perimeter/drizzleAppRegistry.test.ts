import { describe, expect, it } from "vitest";
import { UnroutableAppError } from "@every-app/perimeter";
import { DrizzleAppRegistry } from "./drizzleAppRegistry";

function dbReturning(row: unknown) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
  } as never;
}

describe("DrizzleAppRegistry", () => {
  it("checks for an active app without loading registry rows", async () => {
    await expect(
      new DrizzleAppRegistry(
        dbReturning({ id: "app-row-1" }),
      ).hasAnyActiveApp(),
    ).resolves.toBe(true);
    await expect(
      new DrizzleAppRegistry(dbReturning(null)).hasAnyActiveApp(),
    ).resolves.toBe(false);
  });

  it("maps Drizzle app rows through the shared registry mapper", async () => {
    const row = {
      appSlug: "todo",
      hostname: "todo.example.com",
      workerName: "every-todo",
      tier: "dispatch",
      scope: "shared",
      organizationId: "org-1",
      status: "active",
      manifest: JSON.stringify({ id: "todo" }),
      emailSenders: '["*@mail.example.com"]',
    };
    const registry = new DrizzleAppRegistry(dbReturning(row));

    await expect(
      registry.findByHostname("TODO.EXAMPLE.COM"),
    ).resolves.toMatchObject({
      appId: "todo",
      hostname: "todo.example.com",
      workerName: "every-todo",
      tier: "dispatch",
      scope: "shared",
      organizationId: "org-1",
      status: "active",
      emailSenders: ["*@mail.example.com"],
    });
    // A null column is an installation with no senders, not an absent one.
    await expect(
      new DrizzleAppRegistry(
        dbReturning({ ...row, emailSenders: null }),
      ).findByHostname("todo.example.com"),
    ).resolves.toMatchObject({ emailSenders: [] });
  });

  it("fails closed for unknown persisted statuses", async () => {
    const registry = new DrizzleAppRegistry(
      dbReturning({
        appSlug: "todo",
        hostname: "todo.example.com",
        workerName: "every-todo",
        tier: "service_binding",
        scope: "org",
        organizationId: "org-1",
        status: "paused",
        manifest: JSON.stringify({ id: "todo" }),
      }),
    );

    await expect(registry.findByAppId("todo")).resolves.toMatchObject({
      status: "disabled",
    });
  });

  it("supports org-scoped caller lookup", async () => {
    const registry = new DrizzleAppRegistry(
      dbReturning({
        appSlug: "todo",
        hostname: "todo.example.com",
        workerName: "every-todo",
        tier: "service_binding",
        scope: "org",
        organizationId: "org-1",
        status: "active",
        manifest: JSON.stringify({ id: "todo", providers: ["openai"] }),
      }),
    );

    await expect(registry.findByOrgApp("org-1", "todo")).resolves.toMatchObject(
      {
        organizationId: "org-1",
        appId: "todo",
        manifest: { providers: ["openai"] },
      },
    );
  });

  it("refuses a row with a tier or scope it doesn't know, never coercing it", async () => {
    const row = {
      appSlug: "todo",
      hostname: "todo.example.com",
      workerName: "every-todo",
      tier: "service_binding",
      scope: "org",
      organizationId: "org-1",
      status: "active",
      manifest: JSON.stringify({ id: "todo" }),
    };
    for (const odd of [
      { tier: "worker_loader" },
      { tier: "" },
      { scope: "global" },
    ]) {
      const registry = new DrizzleAppRegistry(dbReturning({ ...row, ...odd }));
      await expect(
        registry.findByHostname("todo.example.com"),
      ).rejects.toBeInstanceOf(UnroutableAppError);
    }
  });
});
