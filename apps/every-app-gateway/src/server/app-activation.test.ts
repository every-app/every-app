import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  findBinding: vi.fn(),
  emit: vi.fn(),
  scheduleCatalogResync: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: () => undefined }));
vi.mock("@/server/repositories/AppRepository", () => ({
  AppRepository: { activate: mocks.activate, findBinding: mocks.findBinding },
}));
vi.mock("@/server/events/bus", () => ({ emit: mocks.emit }));
vi.mock("@/server/toolbus/catalog-sync", () => ({
  scheduleCatalogResync: mocks.scheduleCatalogResync,
}));

import type { RegisteredApp } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import {
  activateApp,
  activateBindingApps,
  activateDeployingApps,
  probeApp,
} from "./app-activation";

const TODO: RegisteredApp = {
  appId: "todo",
  hostname: "todo-acme.gateway.example.com",
  workerName: "every-acme-todo",
  tier: "service_binding",
  scope: "org",
  organizationId: "org-1",
  status: "binding",
  manifest: validateManifest({ id: "todo" }),
  rowId: "row-1",
  versionId: "version-1",
};

/** A gateway env whose service binding to the app answers. */
function boundEnv(mode: string | undefined) {
  const fetch = vi.fn(async () => new Response("ok"));
  return {
    fetch,
    env: {
      GATEWAY_DEPLOYMENT_MODE: mode,
      "APP__every-acme-todo": { fetch },
    },
  };
}

describe("probeApp", () => {
  it("probes an app through the gateway's service binding to it", async () => {
    const fetch = vi.fn(
      async () => new Response("unauthenticated", { status: 401 }),
    );
    await expect(
      probeApp({ "APP__every-acme-todo": { fetch } }, TODO),
    ).resolves.toBe(true);
    expect((fetch.mock.calls[0] as unknown as [Request])[0].url).toBe(
      "https://todo-acme.gateway.example.com/__everyapp/health",
    );

    await expect(probeApp({}, TODO)).resolves.toBe(false);
    await expect(
      probeApp(
        {
          "APP__every-acme-todo": {
            fetch: async () => {
              throw new Error("no such worker");
            },
          },
        },
        TODO,
      ),
    ).resolves.toBe(false);
  });

  it("probes a dispatch app through the namespace, and only there", async () => {
    const DISPATCHED: RegisteredApp = { ...TODO, tier: "dispatch" };
    const fetch = vi.fn(async () => new Response("ok"));
    const get = vi.fn((name: string) => {
      if (name !== "every-acme-todo") throw new Error("Worker not found.");
      return { fetch };
    });

    await expect(probeApp({ DISPATCHER: { get } }, DISPATCHED)).resolves.toBe(
      true,
    );
    expect(get.mock.calls[0]?.[0]).toBe("every-acme-todo");
    // Not uploaded to the namespace yet, or no namespace at all.
    await expect(
      probeApp(
        { DISPATCHER: { get } },
        { ...DISPATCHED, appId: "notes", workerName: "every-acme-notes" },
      ),
    ).resolves.toBe(false);
    await expect(
      probeApp({ "APP__every-acme-todo": { fetch } }, DISPATCHED),
    ).resolves.toBe(false);
  });
});

describe("activateApp", () => {
  beforeEach(() => {
    mocks.activate.mockReset();
    mocks.activate.mockResolvedValue({ activated: true, name: "Todos" });
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.scheduleCatalogResync.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("marks the app active once this isolate reaches its Worker, announces it once, and snapshots its tools", async () => {
    const { env, fetch } = boundEnv("self_hosted");
    await expect(activateApp(env, TODO)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.activate).toHaveBeenCalledWith("row-1", "org-1");
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith({
      organizationId: "org-1",
      actor: { kind: "gateway" },
      type: "app.live",
      version: 1,
      data: {
        app: { id: "todo", rowId: "row-1", name: "Todos" },
        version: "version-1",
        trigger: "request",
      },
      appRowId: "row-1",
    });
    expect(mocks.scheduleCatalogResync).toHaveBeenCalledWith(
      {
        rowId: "row-1",
        organizationId: "org-1",
        appSlug: "todo",
        hostname: "todo-acme.gateway.example.com",
        workerName: "every-acme-todo",
        tier: "service_binding",
        versionId: "version-1",
      },
      "first_use",
    );
  });

  it("leaves it deploying while this gateway version has no binding to it", async () => {
    await expect(
      activateApp({ GATEWAY_DEPLOYMENT_MODE: "self_hosted" }, TODO),
    ).resolves.toBe(false);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.scheduleCatalogResync).not.toHaveBeenCalled();
  });

  it("serves nothing when the row changed meanwhile (deleted or disabled)", async () => {
    mocks.activate.mockResolvedValue(null);
    await expect(activateApp(boundEnv("self_hosted").env, TODO)).resolves.toBe(
      false,
    );
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("serves an app another isolate activated first, without announcing it again", async () => {
    mocks.activate.mockResolvedValue({ activated: false, name: "Todos" });
    await expect(activateApp(boundEnv("self_hosted").env, TODO)).resolves.toBe(
      true,
    );
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.scheduleCatalogResync).toHaveBeenCalledOnce();
  });

  it("names the app as its row does, and says what made it live", async () => {
    mocks.activate.mockResolvedValue({ activated: true, name: "My todos" });
    const unversioned: RegisteredApp = { ...TODO, versionId: undefined };
    await expect(
      activateApp(boundEnv("self_hosted").env, unversioned, "scheduled"),
    ).resolves.toBe(true);
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "app.live",
        data: {
          app: { id: "todo", rowId: "row-1", name: "My todos" },
          trigger: "scheduled",
        },
      }),
    );
  });

  it("activates on a self-hosted or hosted gateway, failing closed on any other mode", async () => {
    for (const mode of ["", undefined, "selfhosted"]) {
      const { env, fetch } = boundEnv(mode);
      await expect(activateApp(env, TODO)).resolves.toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    }
    await expect(
      activateApp(boundEnv(" Self_Hosted ").env, TODO),
    ).resolves.toBe(true);
    // The hosted gateway is the same install shape: its first-party apps
    // are service bindings too.
    await expect(activateApp(boundEnv("hosted").env, TODO)).resolves.toBe(true);
    expect(mocks.activate).toHaveBeenCalledTimes(2);
  });

  it("needs the row id to activate", async () => {
    const { rowId: _rowId, ...withoutRow } = TODO;
    await expect(
      activateApp(boundEnv("self_hosted").env, withoutRow),
    ).resolves.toBe(false);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});

describe("activateBindingApps", () => {
  beforeEach(() => {
    mocks.activate.mockReset();
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.scheduleCatalogResync.mockReset();
  });

  const NOTES: RegisteredApp = {
    ...TODO,
    appId: "notes",
    hostname: "notes-acme.gateway.example.com",
    workerName: "every-acme-notes",
    rowId: "row-2",
  };
  const row = (app: RegisteredApp, status = app.status) => ({
    id: app.rowId!,
    organizationId: app.organizationId,
    appId: app.appId,
    status,
  });
  const registry = (...known: RegisteredApp[]) => ({
    findByOrgApp: vi.fn(
      async (organizationId: string, appId: string) =>
        known.find(
          (app) => app.organizationId === organizationId && app.appId === appId,
        ) ?? null,
    ),
  });

  it("activates the binding apps of a list this gateway reaches, and only those", async () => {
    mocks.activate.mockResolvedValue({ activated: true, name: "Todos" });
    const { env, fetch } = boundEnv("self_hosted");
    const found = registry(TODO, NOTES);

    const activated = await activateBindingApps(env, () => found, [
      row(TODO),
      // Its binding isn't on this gateway version yet.
      row(NOTES),
      // Not deploying: never looked up.
      row({ ...TODO, rowId: "row-3", appId: "wiki" }, "active"),
    ]);

    expect([...activated]).toEqual(["row-1"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith("row-1", "org-1");
    expect(mocks.scheduleCatalogResync).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ rowId: "row-1", appSlug: "todo" }),
      "first_use",
    );
    expect(found.findByOrgApp).toHaveBeenCalledTimes(2);
    expect(found.findByOrgApp).not.toHaveBeenCalledWith("org-1", "wiki");
    // The event says a list made it live.
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "app.live",
        data: expect.objectContaining({ trigger: "list" }),
      }),
    );
  });

  it("leaves an app the registry no longer says is binding, and one it can't find", async () => {
    const { env } = boundEnv("self_hosted");
    const activated = await activateBindingApps(
      env,
      () => registry({ ...TODO, status: "active" }),
      [row(TODO, "binding"), row(NOTES, "binding")],
    );
    expect(activated.size).toBe(0);
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("never throws: a registry that fails leaves the list as it was", async () => {
    const { env } = boundEnv("self_hosted");
    const activated = await activateBindingApps(
      env,
      () => ({
        findByOrgApp: async () => {
          throw new Error("D1 is down");
        },
      }),
      [row(TODO)],
    );
    expect(activated.size).toBe(0);
    // Nor one that can't be opened; and a list with nothing binding opens none.
    const open = vi.fn(() => {
      throw new Error("no DB binding");
    });
    expect((await activateBindingApps(env, open, [row(TODO)])).size).toBe(0);
    expect(open).toHaveBeenCalledOnce();
    expect(
      (await activateBindingApps(env, open, [row(TODO, "active")])).size,
    ).toBe(0);
    expect(open).toHaveBeenCalledOnce();
  });

  it("probes at most five binding apps per read", async () => {
    mocks.activate.mockResolvedValue({ activated: true, name: "Todos" });
    const apps = Array.from({ length: 7 }, (_, index) => ({
      ...TODO,
      appId: `app-${index}`,
      hostname: `app-${index}.gateway.example.com`,
      rowId: `row-${index}`,
    }));
    const { env, fetch } = boundEnv("self_hosted");
    const activated = await activateBindingApps(
      env,
      () => registry(...apps),
      apps.map((app) => row(app)),
    );
    expect(activated.size).toBe(5);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe("activateDeployingApps (the cron's sweep)", () => {
  beforeEach(() => {
    mocks.activate
      .mockReset()
      .mockResolvedValue({ activated: true, name: "Todos" });
    mocks.findBinding.mockReset();
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.scheduleCatalogResync.mockReset();
  });

  const NOTES: RegisteredApp = {
    ...TODO,
    appId: "notes",
    organizationId: "org-2",
    hostname: "notes-globex.gateway.example.com",
    workerName: "every-globex-notes",
    rowId: "row-2",
  };
  const row = (app: RegisteredApp) => ({
    id: app.rowId!,
    organizationId: app.organizationId,
    appId: app.appId,
    status: app.status,
  });
  const registry = (...known: RegisteredApp[]) => ({
    findByOrgApp: vi.fn(
      async (organizationId: string, appId: string) =>
        known.find(
          (app) => app.organizationId === organizationId && app.appId === appId,
        ) ?? null,
    ),
  });

  it("makes every binding app of the install live that this gateway reaches, every organization's, and says the sweep did it", async () => {
    mocks.findBinding.mockResolvedValue([row(TODO), row(NOTES)]);
    const { env, fetch } = boundEnv("self_hosted");
    Object.assign(env, { "APP__every-globex-notes": { fetch } });

    await expect(
      activateDeployingApps(env, () => registry(TODO, NOTES)),
    ).resolves.toBe(2);

    expect(mocks.findBinding).toHaveBeenCalledExactlyOnceWith(50);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.activate).toHaveBeenCalledWith("row-1", "org-1");
    expect(mocks.activate).toHaveBeenCalledWith("row-2", "org-2");
    expect(mocks.emit).toHaveBeenCalledTimes(2);
    for (const call of mocks.emit.mock.calls) {
      expect(call[0]).toMatchObject({
        type: "app.live",
        data: expect.objectContaining({ trigger: "scheduled" }),
      });
    }
  });

  it("leaves what it can't reach for the next minute, and opens no registry with nothing binding", async () => {
    mocks.findBinding.mockResolvedValue([row(NOTES)]);
    const { env } = boundEnv("self_hosted");
    const open = vi.fn(() => registry(NOTES));
    // Its binding isn't on this gateway version.
    await expect(activateDeployingApps(env, open)).resolves.toBe(0);
    expect(mocks.activate).not.toHaveBeenCalled();

    mocks.findBinding.mockResolvedValue([]);
    open.mockClear();
    await expect(activateDeployingApps(env, open)).resolves.toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it("never throws: a read that fails is logged, and a gateway that can't activate reads nothing", async () => {
    mocks.findBinding.mockRejectedValue(new Error("D1 is down"));
    const warnings = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { env } = boundEnv("self_hosted");
    await expect(
      activateDeployingApps(env, () => registry(TODO)),
    ).resolves.toBe(0);
    expect(
      warnings.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("app.activate_failed")),
    ).toHaveLength(1);

    mocks.findBinding.mockReset();
    await expect(
      activateDeployingApps({ GATEWAY_DEPLOYMENT_MODE: undefined }, () =>
        registry(TODO),
      ),
    ).resolves.toBe(0);
    expect(mocks.findBinding).not.toHaveBeenCalled();
  });
});
