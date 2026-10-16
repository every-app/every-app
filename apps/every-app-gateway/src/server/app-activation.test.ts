import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ activate: vi.fn() }));

vi.mock("@/server/repositories/AppRepository", () => ({
  AppRepository: { activate: mocks.activate },
}));

import type { RegisteredApp } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import { activateApp, probeAppBinding } from "./app-activation";

const TODO: RegisteredApp = {
  appId: "todo",
  hostname: "todo-acme.gateway.example.com",
  workerName: "every-acme-todo",
  tier: "service_binding",
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

describe("probeAppBinding", () => {
  it("probes an app through the gateway's service binding to it", async () => {
    const fetch = vi.fn(
      async () => new Response("unauthenticated", { status: 401 }),
    );
    await expect(
      probeAppBinding({ "APP__every-acme-todo": { fetch } }, TODO),
    ).resolves.toBe(true);
    expect((fetch.mock.calls[0] as unknown as [Request])[0].url).toBe(
      "https://todo-acme.gateway.example.com/__everyapp/health",
    );

    await expect(probeAppBinding({}, TODO)).resolves.toBe(false);
    await expect(
      probeAppBinding(
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
});

describe("activateApp", () => {
  beforeEach(() => {
    mocks.activate.mockReset();
    mocks.activate.mockResolvedValue(true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("marks the app active once this isolate reaches its Worker", async () => {
    const { env, fetch } = boundEnv("self_hosted");
    await expect(activateApp(env, TODO)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.activate).toHaveBeenCalledWith("row-1", "org-1");
  });

  it("leaves it deploying while this gateway version has no binding to it", async () => {
    await expect(
      activateApp({ GATEWAY_DEPLOYMENT_MODE: "self_hosted" }, TODO),
    ).resolves.toBe(false);
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("serves nothing when the row changed meanwhile (deleted or disabled)", async () => {
    mocks.activate.mockResolvedValue(false);
    await expect(activateApp(boundEnv("self_hosted").env, TODO)).resolves.toBe(
      false,
    );
  });

  it("only activates on a self-hosted gateway, failing closed on any other mode", async () => {
    for (const mode of ["hosted", "", undefined, "selfhosted"]) {
      const { env, fetch } = boundEnv(mode);
      await expect(activateApp(env, TODO)).resolves.toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    }
    await expect(
      activateApp(boundEnv(" Self_Hosted ").env, TODO),
    ).resolves.toBe(true);
    expect(mocks.activate).toHaveBeenCalledTimes(1);
  });

  it("needs the row id to activate", async () => {
    const { rowId: _rowId, ...withoutRow } = TODO;
    await expect(
      activateApp(boundEnv("self_hosted").env, withoutRow),
    ).resolves.toBe(false);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});
