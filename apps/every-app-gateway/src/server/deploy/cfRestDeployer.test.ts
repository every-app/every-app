/**
 * Binding a self-hosted app to the Gateway (publishBoundApp): a settings
 * patch deploys a new Gateway version, and Cloudflare's reads return the
 * version before for a moment. The install waits for the binding and the
 * new version instead of failing on the first read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ recorded: [] as unknown[][] }));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("./gateway-app-installs", () => ({
  withInstallLease: async (
    _id: string,
    _purpose: string,
    work: (renew: () => Promise<void>) => Promise<unknown>,
  ) => work(async () => undefined),
  recordInstallerGatewayDeployment: async (...args: unknown[]) =>
    void hoisted.recorded.push(args),
}));

import type { CloudflareRest } from "@/server/deploy/cf-rest";
import type { AppRow } from "@every-app/perimeter/registry";
import { CfRestDeployer } from "./cfRestDeployer";

const GATEWAY = "every-app-gateway";
const APP_WORKER = "every-link-tracker";
const app = {
  hostname: "link-tracker.gateway.example.com",
  workerName: APP_WORKER,
  deployedByActor: "user:1",
} as AppRow;

/** A Gateway Worker whose patched settings show up after `staleReads` reads. */
function fakeAccount(staleReads: number) {
  let bindings: Array<Record<string, string>> = [{ type: "d1", name: "DB" }];
  let version = "v1";
  let pending: (() => void) | null = null;
  let reads = 0;
  const read = () => {
    if (pending && reads++ >= staleReads) {
      pending();
      pending = null;
    }
  };
  const cf = {
    scripts: {
      domains: async (hostname: string) =>
        hostname === "gateway.example.com"
          ? [{ service: GATEWAY, zone_id: "zone" }]
          : [],
      dnsRecords: async () => [],
      settings: async () => {
        read();
        return { bindings };
      },
      patchSettings: async (
        _script: string,
        settings: { bindings: Array<Record<string, string>> },
      ) => {
        const added = settings.bindings.filter((b) => b.type !== "inherit");
        pending = () => {
          bindings = [...bindings, ...added];
          version = "v2";
        };
        return {};
      },
      attachDomain: async () => ({}),
      deployments: async () => ({
        deployments: [
          {
            created_on: "2026-11-16T00:00:00Z",
            versions: [{ version_id: version, percentage: 100 }],
          },
        ],
      }),
    },
  } as unknown as CloudflareRest;
  return cf;
}

describe("publishBoundApp", () => {
  beforeEach(() => {
    hoisted.recorded = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("waits for Cloudflare to serve the patched binding and records the new version", async () => {
    const deployer = new CfRestDeployer(fakeAccount(2), null);
    const done = deployer.publishBoundApp(
      app,
      "https://gateway.example.com",
      async () => undefined,
    );
    await vi.runAllTimersAsync();
    await done;
    expect(hoisted.recorded).toEqual([
      ["v2", APP_WORKER, app.hostname, "user:1"],
    ]);
  });

  it("fails when the binding never shows up", async () => {
    const deployer = new CfRestDeployer(fakeAccount(Infinity), null);
    const done = deployer
      .publishBoundApp(
        app,
        "https://gateway.example.com",
        async () => undefined,
      )
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await done).toMatchObject({ code: "BINDINGS_MISMATCH" });
    expect(hoisted.recorded).toEqual([]);
  });
});
