import { describe, expect, it } from "vitest";
import {
  InMemoryAppRegistry,
  rowToRegisteredApp,
  UnroutableAppError,
  type AppRegistryRow,
  type RegisteredApp,
} from "./apps";

const BASE_ROW: AppRegistryRow = {
  appId: "todo",
  hostname: "todo.example.com",
  workerName: "every-todo",
  tier: "service_binding",
  scope: "org",
  organizationId: "org-1",
  status: "active",
  manifest: JSON.stringify({ id: "todo" }),
};

describe("rowToRegisteredApp", () => {
  it("keeps the tiers and scopes it knows", () => {
    for (const tier of ["service_binding", "dispatch"]) {
      expect(rowToRegisteredApp({ ...BASE_ROW, tier }).tier).toBe(tier);
    }
    for (const scope of ["org", "shared"]) {
      expect(rowToRegisteredApp({ ...BASE_ROW, scope }).scope).toBe(scope);
    }
  });

  it("refuses any other tier or scope instead of coercing it", () => {
    for (const odd of [
      { tier: "" },
      { tier: "Service_Binding" },
      { tier: "worker_loader" },
      { scope: "" },
      { scope: "global" },
      { scope: "SHARED" },
    ]) {
      expect(
        () => rowToRegisteredApp({ ...BASE_ROW, ...odd }),
        JSON.stringify(odd),
      ).toThrow(UnroutableAppError);
    }
  });

  it("maps unknown statuses to disabled so registry reads fail closed", () => {
    expect(rowToRegisteredApp({ ...BASE_ROW, status: "archived" }).status).toBe(
      "disabled",
    );
  });

  it("keeps the deploy states", () => {
    for (const status of ["pending", "binding"]) {
      expect(rowToRegisteredApp({ ...BASE_ROW, status }).status).toBe(status);
    }
  });

  it("fails the retired deploying status closed", () => {
    expect(
      rowToRegisteredApp({ ...BASE_ROW, status: "deploying" }).status,
    ).toBe("disabled");
  });

  it("carries the row id and the uploaded version when the row has them", () => {
    expect(
      rowToRegisteredApp({ ...BASE_ROW, rowId: "row-1", versionId: "v1" }),
    ).toMatchObject({ rowId: "row-1", versionId: "v1" });
    expect(rowToRegisteredApp(BASE_ROW)).not.toHaveProperty("rowId");
  });

  it("exposes the persisted provider policy", () => {
    const app = rowToRegisteredApp({
      ...BASE_ROW,
      manifest: JSON.stringify({ id: "todo", providers: ["openai"] }),
    });

    expect(app.manifest.providers).toEqual(["openai"]);
  });
});

describe("InMemoryAppRegistry", () => {
  it("reports whether any active app is registered", async () => {
    const active = rowToRegisteredApp(BASE_ROW) as RegisteredApp;
    const disabled = rowToRegisteredApp({
      ...BASE_ROW,
      appId: "disabled",
      hostname: "disabled.example.com",
      status: "disabled",
    }) as RegisteredApp;

    await expect(
      new InMemoryAppRegistry([disabled]).hasAnyActiveApp(),
    ).resolves.toBe(false);
    await expect(
      new InMemoryAppRegistry([disabled, active]).hasAnyActiveApp(),
    ).resolves.toBe(true);
  });

  it("scopes caller lookup by organization and app slug", async () => {
    const app = rowToRegisteredApp(BASE_ROW) as RegisteredApp;
    const registry = new InMemoryAppRegistry([app]);

    await expect(registry.findByOrgApp("org-1", "todo")).resolves.toBe(app);
    await expect(registry.findByOrgApp("org-2", "todo")).resolves.toBeNull();
  });
});
