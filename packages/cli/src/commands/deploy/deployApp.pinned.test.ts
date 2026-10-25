/**
 * The deploy's behaviour for the six resource kinds the CLI provisioned
 * before the provisioner registries (docs/design/2026-10-provisioners.md
 * section 8), pinned byte for byte: each manifest deployed through the
 * fake Cloudflare account, redeployed, then removed with `--purge`, and
 * everything observable written to one snapshot per manifest under
 * `__snapshots__/pinned/`: the NDJSON events, every uploaded
 * worker.config.json with its secret names, every cf call in order, and
 * the ledger after each deploy and after the purge.
 *
 * The snapshots were generated on main before any provisioner code existed
 * (the provider registry's `provider-migration.test.ts` pattern: literals
 * captured before, never derived after), so the refactor that moves the six
 * kinds onto the registries must leave every one unchanged. Only what is
 * random is normalized: UUIDs minted by the registry (numbered by first
 * appearance), the temp directories (the app's, the test home, the gateway
 * reconcile's private release directory), the gateway's identity public
 * key (minted on its first upload), and the clock (fixed at the epoch, so
 * every `ts` and duration is the same).
 *
 * To check it: `pnpm -C packages/cli test -- deployApp.pinned`. To regenerate
 * on purpose (a deliberate change to what a deploy does), `-u` and review
 * the diff.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeApp } from "@/commands/delete";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import type { MigrationCliRunner } from "@/lib/migrations/localCli";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare, type FakeAppConfig } from "@/test/fakeCloudflare";
import { agenticInbox, agenticInboxConfig } from "@/test/fixtures/manifests/agentic-inbox";
import { POSTIZ_MIGRATIONS_DIR, postiz, postizConfig } from "@/test/fixtures/manifests/postiz";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

const TODO: EveryAppCliManifest = {
  id: "todo",
  name: "Todos",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
  },
};

const WITH_WORKFLOW: EveryAppCliManifest = {
  ...TODO,
  resources: {
    ...TODO.resources,
    workflows: [{ name: "RANK_CHECK", className: "RankCheckWorkflow" }],
  },
};

const DATABASE_URL = "postgres://openseo:s3cret-pa55@db.example.net:6432/openseo";

const SEO: EveryAppCliManifest = {
  id: "seo",
  resources: { kv: ["KV"], hyperdrive: [{ name: "HYPERDRIVE" }] },
  workers: [{ name: "audit", binding: "AUDIT_ENGINE", limits: { cpuMs: 300_000 } }],
  database: { provider: "postgres", region: "aws:us-east-1" },
  limits: { cpuMs: 30_000 },
  migrations: {
    engine: "drizzle",
    dialect: "postgresql",
    dir: "drizzle/pg",
    config: "drizzle/pg.config.ts",
  },
};

/** The clock every event and duration is stamped with. */
const EPOCH = new Date(0);

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let lines: string[];

const out = () => createNdjsonSink((line) => lines.push(line.trimEnd()), () => EPOCH);
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const rebind = {
  ...seams,
  openRelease: () => openRelease(tarball),
  source: () => releaseSource(tarball),
};
const drizzleKit: MigrationCliRunner = async () => ({
  exitCode: 0,
  stdout: "[✓] migrations applied successfully!",
  stderr: "",
});

beforeEach(async () => {
  lines = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
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
    ...seams,
  });
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-pinned-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  // The gateway's own install is not under test: only the app's run is kept.
  lines = [];
  account.cf.calls.length = 0;
  account.deploys.length = 0;
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

function writeDrizzleSqlite(): void {
  fs.mkdirSync(path.join(appDir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "drizzle", "0000_init.sql"),
    "CREATE TABLE todos (id text PRIMARY KEY, title text);",
  );
  fs.writeFileSync(
    path.join(appDir, "drizzle", "meta", "_journal.json"),
    JSON.stringify({ entries: [{ tag: "0000_init", when: 1000 }] }),
  );
}

function deploy(manifest: EveryAppCliManifest, config?: FakeAppConfig) {
  const { build: _build, ...withCfBuild } = manifest;
  account.apps.set(appDir, withCfBuild);
  if (config) account.appConfigs.set(appDir, config);
  return deployApp({
    cwd: appDir,
    manifest: withCfBuild,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    drizzleKit,
    reconcile: rebind,
    live: { fetch: worker.fetch, sleep: async () => undefined },
  });
}

function remove(appId: string) {
  return removeApp({
    appId,
    out: out(),
    interactive: false,
    purge: true,
    createCf: () => account.cf,
    reconcile: rebind,
  });
}

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );

async function ledger(workerName: string): Promise<string[]> {
  const rows = await readOwnedResources(registry(), workerName);
  return rows.map(
    (row) => `${row.kind} ${JSON.stringify(row.binding)} ${row.name} ${row.resourceId ?? "null"} ${row.versionId ?? "null"}`,
  );
}

/**
 * Random UUIDs (the registry's rows, organizations, access grants), each
 * numbered by first appearance; the fake account's own ids start with
 * zeros and stay. The app's temp directory and the test home become
 * stable names.
 */
function normalizer(): (text: string) => string {
  const uuids = new Map<string, string>();
  return (text) =>
    text
      .replaceAll(appDir, "<app>")
      .replaceAll(home, "<home>")
      // The private directory each gateway reconcile unpacks its release in
      // (`<pid>-<random>`).
      .replace(/gateway-deploy-\d+-[A-Za-z0-9]+/g, "gateway-deploy-<tmp>")
      // The gateway's identity keypair, minted on its first upload.
      .replace(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----(\\n)?/g, "<public-key>")
      .replace(
        /\b(?!0000000)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
        (uuid) => {
          if (!uuids.has(uuid)) uuids.set(uuid, `<uuid-${uuids.size + 1}>`);
          return uuids.get(uuid)!;
        },
      );
}

/** One snapshot: everything the run did, as text. */
function render(sections: Array<[string, string[]]>): string {
  const normalize = normalizer();
  return sections
    .map(([title, body]) => `## ${title}\n\n${body.map(normalize).join("\n")}\n`)
    .join("\n");
}

const cfCalls = () =>
  account.cf.calls.map(
    (call) =>
      `${call.plane} ${call.mode}${call.local ? " local" : ""} cf ${call.args.join(" ")}${
        Object.keys(call.files).length ? ` files=${Object.keys(call.files).sort().join(",")}` : ""
      }${call.cwd ? ` cwd=${call.cwd}` : ""}`,
  );

const uploads = () =>
  account.deploys.flatMap((upload) => [
    `### ${upload.workerName} (${upload.mode}; secrets ${Object.keys(upload.secrets ?? {}).sort().join(",") || "none"})`,
    JSON.stringify(upload.config, null, 2),
  ]);

interface Scenario {
  name: string;
  manifest: EveryAppCliManifest;
  config?: FakeAppConfig;
  workerName: string;
  before?: () => void;
}

const SCENARIOS: Scenario[] = [
  {
    name: "todo-d1-kv-durable-object",
    manifest: TODO,
    workerName: "every-acme-todo",
    before: writeDrizzleSqlite,
  },
  {
    name: "todo-with-workflow",
    manifest: WITH_WORKFLOW,
    workerName: "every-acme-todo",
    before: writeDrizzleSqlite,
  },
  {
    name: "postiz-helper-r2-workflow",
    manifest: postiz,
    config: postizConfig,
    workerName: "every-acme-postiz",
    before: () =>
      fs.cpSync(POSTIZ_MIGRATIONS_DIR, path.join(appDir, "migrations"), { recursive: true }),
  },
  {
    name: "agentic-inbox-durable-objects",
    manifest: agenticInbox,
    config: agenticInboxConfig,
    workerName: "every-acme-agentic-inbox",
  },
  {
    name: "seo-hyperdrive-helper",
    manifest: SEO,
    workerName: "every-acme-seo",
    before: () => {
      fs.mkdirSync(path.join(appDir, "drizzle", "pg"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "drizzle", "pg", "0000_init.sql"),
        "CREATE TABLE projects (id text PRIMARY KEY, organization_id text NOT NULL);",
      );
      fs.mkdirSync(path.join(appDir, ".everyapp"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, ".everyapp", "secrets.env"),
        `POSTGRES_DATABASE_URL=${DATABASE_URL}\n`,
      );
    },
  },
];

describe("the deploy of the six resource kinds, pinned before the provisioner registries", () => {
  it.each(SCENARIOS)("$name", async ({ name, manifest, config, workerName, before }) => {
    before?.();
    await deploy(manifest, config);
    const afterFirst = await ledger(workerName);
    await deploy(manifest, config);
    const afterSecond = await ledger(workerName);
    await remove(manifest.id);
    const afterPurge = await ledger(workerName);

    await expect(
      render([
        ["events", lines],
        ["uploads", uploads()],
        ["cf calls", cfCalls()],
        ["ledger after the first deploy", afterFirst],
        ["ledger after the redeploy", afterSecond],
        ["ledger after the purge", afterPurge],
      ]),
    ).toMatchFileSnapshot(`__snapshots__/pinned/${name}.md`);
  });
});
