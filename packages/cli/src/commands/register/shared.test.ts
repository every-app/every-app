/**
 * Shared apps end to end in a fake Cloudflare account (FakeCf, real SQLite
 * D1, the app's Worker built by the SDK's real everyAppWorker()): `deploy
 * --shared`, and `register` of a Worker deployed by other means, on a
 * hosted gateway the CLI installed, whose platform organization ("Every
 * App") the setup claim made. Both refuse a self-hosted gateway, and a
 * Cloudflare login that isn't one of the platform organization's owners or
 * admins.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeApp } from "@/commands/delete";
import { deployApp } from "@/commands/deploy/deployApp";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { DeploymentMode } from "@/lib/gateway/secretsFile";
import { mintSetupLink } from "@/lib/gateway/setup-link";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { registerApp } from "./registerApp";

const GATEWAY_URL = "https://example.com";
/** The platform organization's key is "everyapp": its Workers are every-everyapp-<app>. */
const OPENSEO_WORKER = "every-everyapp-openseo";

const TODO: EveryAppCliManifest = { id: "todo", name: "Todos", resources: { d1: ["DB"] } };

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const rebind = {
  ...seams,
  openRelease: () => openRelease(tarball),
  source: () => releaseSource(tarball),
};
const live = () => ({ fetch: worker.fetch, sleep: async () => undefined });

const gatewayDb = () => account.database("every-app-gateway");
const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );
const appRow = (appId: string) =>
  gatewayDb().all(
    "SELECT organization_id, worker_name, hostname, scope, status, version_id, is_default FROM apps WHERE app_slug = ?",
    appId,
  )[0];
const grants = (appId: string) =>
  gatewayDb().all(
    "SELECT user_id FROM user_app_access WHERE app_row_id = (SELECT id FROM apps WHERE app_slug = ?)",
    appId,
  );

/**
 * A gateway this CLI installed at the zone's apex in `mode`, claimed by
 * `owner` (the platform organization, on the hosted gateway); the
 * Cloudflare login (dev@example.com) is a verified member with `loginRole`.
 */
async function installGateway(
  mode: DeploymentMode,
  { loginRole = "owner" }: { loginRole?: string } = {},
): Promise<{ organizationId: string }> {
  const resources = await ensureGatewayResources(account.cf);
  await applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: "example.com",
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    deploymentMode: mode,
    ...seams,
  });
  const link = await mintSetupLink({ db: registry(), gatewayUrl: GATEWAY_URL });
  const { organizationId } = worker.claim(link.url, {
    email: loginRole === "owner" ? "dev@example.com" : "owner@example.com",
    name: "Every App",
  });
  if (loginRole !== "owner") {
    gatewayDb().sqlite.exec(`
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('dev', 'Dev', 'dev@example.com', 1, 0, 0);
      INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('member-dev', '${organizationId}', 'dev', '${loginRole}', 0);
    `);
  }
  gatewayDb().sqlite.exec("UPDATE users SET email_verified = 1");
  events = [];
  return { organizationId };
}

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);

  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.writeFileSync(
    path.join(appDir, "everyapp.config.ts"),
    'export default { id: "openseo", name: "OpenSEO", providers: ["openai"] };\n',
  );
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

function deploy(
  manifest: EveryAppCliManifest = TODO,
  options: Partial<Parameters<typeof deployApp>[0]> = {},
) {
  account.apps.set(appDir, manifest);
  return deployApp({
    cwd: appDir,
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: rebind,
    live: live(),
    ...options,
  });
}

function register(options: Partial<Parameters<typeof registerApp>[0]> = {}) {
  return registerApp({
    appId: "openseo",
    workerName: OPENSEO_WORKER,
    manifestPath: path.join(appDir, "everyapp.config.ts"),
    shared: true,
    out: out(),
    interactive: false,
    createCf: () => account.cf,
    reconcile: rebind,
    live: live(),
    ...options,
  });
}

/** The OpenSEO Worker, as its own pipeline (an Alchemy stage) left it. */
function deployedElsewhere(workerName = OPENSEO_WORKER) {
  account.workers.set(workerName, {
    versions: ["alchemy-version-1"],
    config: { env: {} },
    secrets: {},
  });
}

describe("deploy --shared", () => {
  it("registers one Worker for every organization, in the platform organization", async () => {
    const { organizationId } = await installGateway("hosted");

    const result = await deploy(TODO, { shared: true });

    expect(result).toMatchObject({
      liveUrl: "https://todo.example.com",
      workerName: "every-everyapp-todo",
      live: true,
    });
    expect(appRow("todo")).toMatchObject({
      organization_id: organizationId,
      hostname: "todo.example.com",
      scope: "shared",
      status: "active",
      is_default: 0,
    });
    // Nobody is granted it: membership of any active organization opens it.
    expect(grants("todo")).toEqual([]);
    // Its Worker serves every organization: nothing pins it to the owner's.
    const upload = account.deploys.find((d) => d.workerName === "every-everyapp-todo")!;
    expect(upload.secrets).toEqual({ GATEWAY_URL });
    expect(upload.config["env"]).not.toHaveProperty("EVERY_APP_ORG_ID");
    expect(upload.config["env"]["EVERY_APP_GATEWAY"]).toMatchObject({
      props: { organizationId, appId: "todo", workerName: "every-everyapp-todo" },
    });
    expect(account.gatewayBindings()).toEqual(["every-everyapp-todo"]);
    expect(events.find((event) => event["step"] === "app.register")).toMatchObject({
      data: { scope: "shared", organizationName: "Every App", existingApp: false },
      message: expect.stringContaining("every member of every organization"),
    });

    // A redeploy keeps it shared, with --shared or without.
    await expect(deploy(TODO, { shared: true })).resolves.toMatchObject({ live: true });
    await expect(deploy(TODO)).resolves.toMatchObject({ live: true });
    expect(appRow("todo")).toMatchObject({ scope: "shared", status: "active" });
  });

  it("keeps a shared app shared through `secret set`'s redeploy, which has no --shared", async () => {
    await installGateway("hosted");
    await deploy(TODO, { shared: true });
    account.deploys.length = 0;

    // What `secret set FOO` runs: deployApp with the secret, and no `shared`.
    await expect(deploy(TODO, { secrets: { FOO: "bar" } })).resolves.toMatchObject({
      live: true,
    });

    expect(appRow("todo")).toMatchObject({ scope: "shared", status: "active" });
    expect(grants("todo")).toEqual([]);
    const upload = account.deploys.find((d) => d.workerName === "every-everyapp-todo")!;
    expect(upload.secrets).toEqual({ GATEWAY_URL, FOO: "bar" });
    expect(upload.config["env"]).not.toHaveProperty("EVERY_APP_ORG_ID");
  });

  it("refuses a member login's redeploy of a shared app, even without --shared", async () => {
    await installGateway("hosted");
    await deploy(TODO, { shared: true });
    gatewayDb().sqlite.exec("UPDATE members SET role = 'member'");

    await expect(deploy(TODO, { secrets: { FOO: "bar" } })).rejects.toMatchObject({
      code: "SHARED_APP_FORBIDDEN",
    });
  });

  it("keeps an organization's own app its own: --shared can't take its id", async () => {
    await installGateway("hosted");
    await deploy(TODO);
    expect(appRow("todo")).toMatchObject({ scope: "org" });

    await expect(deploy(TODO, { shared: true })).rejects.toMatchObject({
      code: "APP_SCOPE_MISMATCH",
    });
    expect(appRow("todo")).toMatchObject({ scope: "org" });
  });

  it("is refused on a self-hosted gateway, registering nothing", async () => {
    await installGateway("self_hosted");

    await expect(deploy(TODO, { shared: true })).rejects.toMatchObject({
      code: "SHARED_APPS_UNAVAILABLE",
    });
    expect(appRow("todo")).toBeUndefined();
    // Its own apps deploy as ever.
    await expect(deploy(TODO)).resolves.toMatchObject({ live: true });
    expect(appRow("todo")).toMatchObject({ scope: "org" });
  });

  it("is refused to a login that isn't a platform owner or admin", async () => {
    await installGateway("hosted", { loginRole: "member" });

    await expect(deploy(TODO, { shared: true })).rejects.toMatchObject({
      code: "SHARED_APP_FORBIDDEN",
    });
    expect(appRow("todo")).toBeUndefined();
  });

  it("takes an admin's login, and an API token's account authority", async () => {
    await installGateway("hosted", { loginRole: "admin" });
    await expect(deploy(TODO, { shared: true })).resolves.toMatchObject({ live: true });

    vi.stubEnv("CLOUDFLARE_API_TOKEN", "a-token");
    await expect(
      deploy({ id: "chef", name: "Chef" }, { shared: true }),
    ).resolves.toMatchObject({ live: true });
    expect(appRow("chef")).toMatchObject({ scope: "shared" });
  });
});

describe("delete of a shared app", () => {
  const remove = () =>
    removeApp({
      appId: "todo",
      out: out(),
      interactive: false,
      purge: false,
      createCf: () => account.cf,
      reconcile: rebind,
    });

  it("is refused to a login that isn't a platform owner or admin, deleting nothing", async () => {
    await installGateway("hosted", { loginRole: "admin" });
    await deploy(TODO, { shared: true });
    gatewayDb().sqlite.exec("UPDATE members SET role = 'member' WHERE user_id = 'dev'");

    await expect(remove()).rejects.toMatchObject({ code: "SHARED_APP_FORBIDDEN" });
    expect(appRow("todo")).toMatchObject({ scope: "shared", status: "active" });
    expect(account.gatewayBindings()).toEqual(["every-everyapp-todo"]);
  });

  it("is a platform owner's to do", async () => {
    await installGateway("hosted");
    await deploy(TODO, { shared: true });

    await expect(remove()).resolves.toMatchObject({ status: "deleted" });
    expect(appRow("todo")).toMatchObject({ scope: "shared", status: "deleted" });
    expect(account.gatewayBindings()).toEqual([]);
  });
});

describe("register", () => {
  it("puts a Worker deployed by other means behind the gateway as a shared app", async () => {
    const { organizationId } = await installGateway("hosted");
    deployedElsewhere();

    const result = await register();

    expect(result).toMatchObject({
      liveUrl: "https://openseo.example.com",
      workerName: OPENSEO_WORKER,
      versionId: "alchemy-version-1",
      live: true,
    });
    expect(appRow("openseo")).toMatchObject({
      organization_id: organizationId,
      worker_name: OPENSEO_WORKER,
      hostname: "openseo.example.com",
      scope: "shared",
      status: "active",
      version_id: "alchemy-version-1",
    });
    expect(grants("openseo")).toEqual([]);
    // The gateway binds it (APP__every-everyapp-openseo) and serves its host.
    expect(account.gatewayBindings()).toEqual([OPENSEO_WORKER]);
    expect(account.customDomains.get("openseo.example.com")).toBe("every-app-gateway");
    // Nothing about the Worker changed, and it isn't everyapp's own.
    expect(account.deploys.filter((d) => d.workerName === OPENSEO_WORKER)).toEqual([]);
    expect(await readOwnedResources(registry(), OPENSEO_WORKER)).toEqual([]);

    // What its own pipeline must give it.
    const install = gatewayDb().all("SELECT jwt_public_key FROM _everyapp_install")[0]!;
    expect(events.find((event) => event["step"] === "app.register")).toMatchObject({
      data: {
        scope: "shared",
        versionId: "alchemy-version-1",
        worker: {
          identityIssuer: GATEWAY_URL,
          identityPublicKeys: [install["jwt_public_key"]],
          vars: { EVERYAPP_SHARED: "1" },
          gatewayBinding: {
            service: "every-app-gateway",
            entrypoint: "AppGateway",
            props: { organizationId, appId: "openseo", workerName: OPENSEO_WORKER },
          },
        },
      },
    });
    const steps = events
      .filter((event) => event["type"] === "step" && event["status"] !== "start")
      .map((event) => event["step"]);
    expect(steps).toEqual(["app.register", "gateway.deploy", "app.bind", "app.live"]);

    // Again, after its pipeline shipped a new version: recorded, no rebind.
    account.workers.get(OPENSEO_WORKER)!.versions.push("alchemy-version-2");
    const gatewayVersions = account.workers.get("every-app-gateway")!.versions.length;
    await expect(register()).resolves.toMatchObject({ versionId: "alchemy-version-2" });
    expect(appRow("openseo")).toMatchObject({ version_id: "alchemy-version-2", status: "active" });
    expect(account.workers.get("every-app-gateway")!.versions).toHaveLength(gatewayVersions);
  });

  it("refuses a Worker the account doesn't have, or under another name than the gateway's", async () => {
    await installGateway("hosted");

    await expect(register()).rejects.toMatchObject({ code: "WORKER_NOT_FOUND" });
    deployedElsewhere("openseo-production");
    await expect(register({ workerName: "openseo-production" })).rejects.toMatchObject({
      code: "WORKER_NAME_MISMATCH",
      message: expect.stringContaining(`--worker ${OPENSEO_WORKER}`),
    });
    expect(appRow("openseo")).toBeUndefined();
    expect(account.gatewayBindings()).toEqual([]);
  });

  it("refuses a manifest for another app, and runs only with --shared", async () => {
    await installGateway("hosted");
    deployedElsewhere();

    await expect(register({ appId: "chef" })).rejects.toMatchObject({
      code: "MANIFEST_MISMATCH",
    });
    await expect(register({ shared: false })).rejects.toMatchObject({
      code: "SHARED_FLAG_REQUIRED",
    });
    await expect(
      register({ manifestPath: path.join(appDir, "missing.config.ts") }),
    ).rejects.toThrow(/No manifest at/);
    expect(appRow("openseo")).toBeUndefined();
  });

  it("is refused on a self-hosted gateway", async () => {
    await installGateway("self_hosted");
    deployedElsewhere();

    await expect(register()).rejects.toMatchObject({ code: "SHARED_APPS_UNAVAILABLE" });
    expect(appRow("openseo")).toBeUndefined();
  });
});
