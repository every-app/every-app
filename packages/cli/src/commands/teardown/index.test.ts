/**
 * `everyapp teardown` end to end, in a fake Cloudflare account with a
 * deployed gateway, an app, Access on and mail routed (as
 * access/index.test.ts): the guards that keep it off any other account,
 * the dry run that writes nothing, the confirmation an agent can't give
 * itself, a full run that leaves only what isn't Every App's, and the
 * second run that finds nothing left.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import type { RecordedCfCall } from "@/lib/cf/fakeCf";
import { applyGateway } from "@/lib/gateway/apply";
import { readApp } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { gatewayNames } from "@every-app/perimeter/manifest";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { POLICY_NAME, turnAccessOn } from "../access/index";
import { deployApp } from "../deploy/deployApp";
import { teardownAccount } from "./index";

const GATEWAY = "every-app-gateway";
const HOST = "example.com";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";

/** An app with a database, a namespace and a Workflow. */
const TODO: EveryAppCliManifest = {
  id: "todo",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    workflows: [{ name: "RANK_CHECK", className: "RankCheck" }],
  },
};
const TODO_WORKER = "every-acme-todo";

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;
const dirs: string[] = [];

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const db = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0],
  );
const done = () => events.find((event) => event["type"] === "done");
const warnings = (code: string) => events.filter((event) => event["type"] === "warning" && event["code"] === code);
const dbNames = () => [...account.databases.values()].map((entry) => entry.name).sort();
const kvTitles = () => [...account.namespaces.values()].map((ns) => ns.title).sort();
/** cf calls that change anything. */
const writes = (): RecordedCfCall[] =>
  account.cf.calls.filter(
    (call) =>
      call.args.some((arg) => ["delete", "disable", "create", "enable"].includes(arg)) ||
      (call.args.includes("update") && call.args[0] !== "d1") ||
      // A D1 statement that isn't a SELECT.
      (call.args[0] === "d1" && call.args[1] === "query" && /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(Object.values(call.files).join(" "))),
  );

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  vi.stubEnv("EVERYAPP_TEST_ACCOUNTS", "");
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
    gatewayHost: HOST,
    zone: { id: "zone-1", name: HOST },
    appBaseDomain: HOST,
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    ...seams,
  });
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An app's directory: its real everyapp.config.ts, and what the fake build needs. */
function appDir(manifest: EveryAppCliManifest): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-teardown-app-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "everyapp.config.ts"),
    `export default ${JSON.stringify(manifest, null, 2)} as const;\n`,
  );
  fs.writeFileSync(
    path.join(dir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(dir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "drizzle", "0000_init.sql"), "CREATE TABLE todos (id text PRIMARY KEY, title text);");
  fs.writeFileSync(
    path.join(dir, "drizzle", "meta", "_journal.json"),
    JSON.stringify({ entries: [{ tag: "0000_init", when: 1000 }] }),
  );
  account.apps.set(dir, manifest);
  return dir;
}

async function deploy(manifest: EveryAppCliManifest): Promise<string> {
  await deployApp({
    cwd: appDir(manifest),
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: {
      ...seams,
      openRelease: () => openRelease(tarball),
      source: () => releaseSource(tarball),
    },
    live: { fetch: worker.fetch, sleep: async () => undefined },
  });
  return (await readApp(db(), manifest.id)).workerName;
}

/**
 * Everything the loop's run leaves behind, and what isn't Every App's:
 * the app, Access on, mail routed to the app (and a rule of someone
 * else's), the zone's Universal certificate, R2 buckets (one not empty), a
 * Hyperdrive config, a Vectorize index, an AI Gateway, a Secrets Store
 * secret, DNS left at our names, and a Worker, database, namespace,
 * bucket, config, index, gateway, store secret and record that are
 * someone else's (a gateway named `everyapp` among them: not every-*).
 */
async function populate({ foreignMailRule = true }: { foreignMailRule?: boolean } = {}): Promise<void> {
  await deploy(TODO);
  await turnAccessOn({ flags: { json: true }, out: out(), createCf: () => account.cf, team: "acme", emails: ["ben@acme.com"] });
  const routing = account.emailRoutingOf("zone-1");
  routing.enabled = true;
  account.dnsRecords.push({ zoneId: "zone-1", name: HOST, type: "MX", content: "route1.mx.cloudflare.net" });
  routing.rules.set("rule-ours", {
    id: "rule-ours",
    name: `everyapp:${TODO_WORKER}`,
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: `support@${HOST}` }],
    actions: [{ type: "worker", value: [TODO_WORKER] }],
  });
  if (foreignMailRule) {
    routing.rules.set("rule-theirs", {
      id: "rule-theirs",
      name: "forward to ben",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: `ben@${HOST}` }],
      actions: [{ type: "forward", value: ["ben@gmail.com"] }],
    });
  }
  routing.catchAll = { ...routing.catchAll, name: `everyapp:${TODO_WORKER}`, enabled: true, actions: [{ type: "worker", value: [TODO_WORKER] }] };
  account.certificatePacks.push({ id: "pack-universal", zoneId: "zone-1", hosts: [HOST, `*.${HOST}`], type: "universal" });
  account.buckets.set(`${TODO_WORKER}--media`, { objects: 0 });
  account.buckets.set(`${TODO_WORKER}--uploads`, { objects: 2 });
  account.buckets.set("customer-backups", { objects: 0 });
  account.hyperdrive.set("hd-ours", {
    name: `${TODO_WORKER}--pg`,
    origin: { scheme: "postgres", host: "db.example.net", port: 5432, database: "todo", user: "todo" },
    password: "secret",
  });
  account.hyperdrive.set("hd-theirs", {
    name: "warehouse",
    origin: { scheme: "postgres", host: "db.example.net", port: 5432, database: "wh", user: "wh" },
    password: "secret",
  });
  account.vectorizeIndexes.set(`${TODO_WORKER}--vectors`, {
    config: { dimensions: 768, metric: "cosine" },
    created_on: "2026-10-24T00:00:00.000Z",
  });
  account.vectorizeIndexes.set("product-search", {
    config: { dimensions: 384, metric: "cosine" },
    created_on: "2026-10-24T00:00:00.000Z",
  });
  for (const id of [`${TODO_WORKER}-ai-gateway`, "support-bot", "everyapp"]) {
    account.aiGateways.set(id, { id, collect_logs: true, cache_ttl: 0 });
  }
  const store = account.addSecretsStore();
  account.secretsStores.get(store)!.secrets.set("ss-ours", {
    name: `${TODO_WORKER}--stripe-key`,
    value: "sk_test_ours",
    scopes: ["workers"],
  });
  account.secretsStores.get(store)!.secrets.set("ss-theirs", {
    name: "payroll-api-key",
    value: "theirs",
    scopes: ["workers"],
  });
  // At the app's host: a record a Custom Domain's kind (ours to clear once
  // the domain is gone) and a TXT that isn't; a wildcard and www that are
  // someone else's.
  account.dnsRecords.push(
    { zoneId: "zone-1", name: `todo.${HOST}`, type: "A", content: "192.0.2.1" },
    { zoneId: "zone-1", name: `todo.${HOST}`, type: "TXT", content: "left by a check" },
    { zoneId: "zone-1", name: `*.${HOST}`, type: "CNAME", content: "old.example.net" },
    { zoneId: "zone-1", name: `www.${HOST}`, type: "CNAME", content: "site.example.net" },
  );
  account.workers.set("other-worker", { versions: ["v1"], config: { name: "other-worker" }, secrets: {} });
  account.createDatabase("customer-data");
  account.createNamespace("customer-cache");
  events = [];
  sleeps = [];
  account.cf.calls.length = 0;
}

/** The waits the teardown asked for (its second look at a refused certificate pack). */
let sleeps: number[] = [];

type RunOptions = Partial<Parameters<typeof teardownAccount>[0]> & {
  accountId?: string;
  confirm?: string;
  dryRun?: boolean;
  token?: string | null;
  allowlist?: string;
  gateway?: string;
  all?: boolean;
};

/** Run the teardown as the loop would: a token and the allowlist in the environment, --json. */
function run({
  accountId = ACCOUNT_ID,
  confirm,
  dryRun,
  token = "loop-token",
  allowlist = ACCOUNT_ID,
  interactive = false,
  gateway,
  all,
  ...options
}: RunOptions = {}) {
  events = [];
  account.cf.calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", token ?? "");
  vi.stubEnv("EVERYAPP_TEST_ACCOUNTS", allowlist);
  return teardownAccount({
    flags: { "account-id": accountId, confirm, "dry-run": dryRun, json: !interactive, gateway, all },
    out: out(),
    createCf: () => account.cf,
    interactive,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
}

describe("teardown refuses", () => {
  it("the forbidden account, even when the allowlist names it, with no cf call made", async () => {
    const forbidden = "badc0ffee0ddf00dbadc0ffee0ddf00d";
    vi.stubEnv("EVERYAPP_FORBIDDEN_ACCOUNTS", forbidden);
    await expect(run({ accountId: forbidden, allowlist: `${ACCOUNT_ID},${forbidden}`, confirm: forbidden })).rejects.toMatchObject({
      code: "TEARDOWN_ACCOUNT_FORBIDDEN",
      message: expect.stringContaining("can never be torn down"),
    });
    expect(account.cf.calls).toEqual([]);
  });

  it("an account off the allowlist, and takes the allowlist from the file too", async () => {
    await expect(run({ allowlist: OTHER_ACCOUNT })).rejects.toMatchObject({
      code: "TEARDOWN_NOT_ALLOWLISTED",
      fix: expect.stringContaining("dedicated test account"),
    });
    expect(account.cf.calls).toEqual([]);

    // The file form: one id per line, comments allowed; past it, the next guard speaks.
    const file = path.join(home, ".config", "everyapp", "test-accounts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# loop accounts\n${ACCOUNT_ID}\n`);
    await expect(run({ allowlist: "", token: null })).rejects.toMatchObject({ code: "TEARDOWN_NEEDS_TOKEN" });
    expect(account.cf.calls).toEqual([]);
  });

  it("a run without CLOUDFLARE_API_TOKEN, before any cf call", async () => {
    await expect(run({ token: null })).rejects.toMatchObject({ code: "TEARDOWN_NEEDS_TOKEN" });
    expect(account.cf.calls).toEqual([]);
  });

  it("a token that sees another account, and one that doesn't see the target, after whoami alone", async () => {
    account.cf.override(["auth", "whoami"], {
      stdout: JSON.stringify({
        authenticated: true,
        email: null,
        accounts: [{ id: ACCOUNT_ID, name: "Loop 1" }, { id: OTHER_ACCOUNT, name: "Someone's" }],
      }),
    });
    await expect(run()).rejects.toMatchObject({
      code: "TEARDOWN_TOKEN_TOO_BROAD",
      message: expect.stringContaining(`Someone's (${OTHER_ACCOUNT})`),
    });
    expect(account.cf.calls.map((call) => call.args.slice(0, 2))).toEqual([["auth", "whoami"]]);

    account.cf.override(["auth", "whoami"], {
      stdout: JSON.stringify({ authenticated: true, email: null, accounts: [{ id: OTHER_ACCOUNT, name: "Loop 2" }] }),
    });
    await expect(run({ allowlist: `${ACCOUNT_ID} ${OTHER_ACCOUNT}` })).rejects.toMatchObject({
      code: "TEARDOWN_ACCOUNT_NOT_VISIBLE",
    });
    expect(account.cf.calls.map((call) => call.args.slice(0, 2))).toEqual([["auth", "whoami"]]);
  });

  it("a token Cloudflare rejects, and a person's login under the variable, after whoami alone", async () => {
    // cf 1.0.0-beta.14 with a bad CLOUDFLARE_API_TOKEN: still "authenticated", tokenValid false, no accounts.
    account.cf.override(["auth", "whoami"], {
      stdout: JSON.stringify({
        authenticated: true,
        authSource: "CLOUDFLARE_API_TOKEN environment variable",
        tokenValid: false,
        accounts: [],
      }),
    });
    await expect(run()).rejects.toMatchObject({ code: "CLOUDFLARE_TOKEN_REJECTED" });
    expect(account.cf.calls.map((call) => call.args.slice(0, 2))).toEqual([["auth", "whoami"]]);

    account.cf.override(["auth", "whoami"], {
      stdout: JSON.stringify({
        authenticated: true,
        authSource: "OAuth token from /Users/me/Library/Preferences/cloudflare/config/default.json",
        tokenValid: true,
        email: "me@example.com",
        accounts: [{ id: ACCOUNT_ID, name: "Loop 1" }],
      }),
    });
    await expect(run()).rejects.toMatchObject({ code: "TEARDOWN_NEEDS_TOKEN" });
    expect(account.cf.calls.map((call) => call.args.slice(0, 2))).toEqual([["auth", "whoami"]]);
  });

  it("--confirm with another id, before anything is read", async () => {
    await expect(run({ confirm: OTHER_ACCOUNT })).rejects.toMatchObject({
      code: "TEARDOWN_CONFIRM_MISMATCH",
      fix: `pass --confirm ${ACCOUNT_ID}`,
    });
    expect(account.cf.calls).toEqual([]);
  });

  it("to go ahead under --json without --confirm: the rerun carries it, to authorize", async () => {
    await populate();
    await expect(run()).rejects.toMatchObject({
      code: "TEARDOWN_CONFIRMATION_REQUIRED",
      authorize: true,
      rerun: expect.stringMatching(new RegExp(` --confirm ${ACCOUNT_ID}$`)),
      data: { accountId: ACCOUNT_ID, plan: expect.objectContaining({ total: expect.any(Number) }) },
    });
    expect(writes()).toEqual([]);
    expect(account.workers.has(GATEWAY)).toBe(true);
  });

  it("to go ahead at a terminal unless the account id is typed", async () => {
    await populate();
    const askConfirmation = vi.fn(async () => "nope");
    await expect(run({ interactive: true, askConfirmation })).rejects.toMatchObject({
      code: "CANCELLED",
      message: `"nope" doesn't match ${ACCOUNT_ID}. Nothing deleted.`,
    });
    // The person saw the inventory above the question.
    expect(askConfirmation).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.arrayContaining([expect.stringContaining("Workers (")]),
    );
    expect(writes()).toEqual([]);
    expect(account.workers.has(GATEWAY)).toBe(true);
  });

  it("nothing once the account id is typed, however it is cased or spaced", async () => {
    await populate();
    const askConfirmation = vi.fn(async () => ` ${ACCOUNT_ID.toUpperCase()} `);
    await run({ interactive: true, askConfirmation });
    expect(askConfirmation).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect([...account.workers.keys()]).toEqual(["other-worker"]);
  });

  it("nothing at a terminal with --confirm, where the plan is shown before it goes", async () => {
    await populate();
    const askConfirmation = vi.fn(async () => "never asked");
    await run({ interactive: true, confirm: ACCOUNT_ID, askConfirmation });
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "step",
        step: "teardown.plan",
        status: "ok",
        data: expect.objectContaining({ lines: expect.arrayContaining([expect.stringContaining("Workers (")]) }),
      }),
    );
    expect([...account.workers.keys()]).toEqual(["other-worker"]);
  });
});

describe("teardown --dry-run", () => {
  it("lists every kind and writes nothing", async () => {
    await populate();
    const before = {
      workers: [...account.workers.keys()].sort(),
      databases: dbNames(),
      namespaces: kvTitles(),
      buckets: [...account.buckets.keys()].sort(),
      hyperdrive: [...account.hyperdrive.keys()].sort(),
      vectorize: [...account.vectorizeIndexes.keys()].sort(),
      aiGateways: [...account.aiGateways.keys()].sort(),
      workflows: [...account.workflows.keys()].sort(),
      packs: account.certificatePacks.map((pack) => pack.id),
      dns: account.dnsRecords.map((record) => `${record.type} ${record.name}`),
      rules: [...account.emailRoutingOf("zone-1").rules.keys()],
      applications: [...account.zeroTrust.applications.keys()],
      policies: [...account.zeroTrust.policies.keys()],
    };

    await run({ dryRun: true });

    expect(writes()).toEqual([]);
    expect({
      workers: [...account.workers.keys()].sort(),
      databases: dbNames(),
      namespaces: kvTitles(),
      buckets: [...account.buckets.keys()].sort(),
      hyperdrive: [...account.hyperdrive.keys()].sort(),
      vectorize: [...account.vectorizeIndexes.keys()].sort(),
      aiGateways: [...account.aiGateways.keys()].sort(),
      workflows: [...account.workflows.keys()].sort(),
      packs: account.certificatePacks.map((pack) => pack.id),
      dns: account.dnsRecords.map((record) => `${record.type} ${record.name}`),
      rules: [...account.emailRoutingOf("zone-1").rules.keys()],
      applications: [...account.zeroTrust.applications.keys()],
      policies: [...account.zeroTrust.policies.keys()],
    }).toEqual(before);
    const plan = done()!["data"]["plan"];
    expect(done()).toMatchObject({
      message: expect.stringMatching(/^Dry run: \d+ resources: .* Nothing was changed\.$/),
      data: { accountId: ACCOUNT_ID, dryRun: true, removed: [], kept: [] },
    });
    expect(plan).toMatchObject({
      gateway: { gatewayHost: HOST },
      // Apps are Custom Domains on the Gateway's Worker; the Gateway's goes last.
      workers: [{ name: TODO_WORKER, domains: [] }, { name: GATEWAY, domains: [HOST, `todo.${HOST}`] }],
      workflows: [`${TODO_WORKER}--rank-check`],
      d1: [{ name: TODO_WORKER }, { name: GATEWAY }],
      kv: [{ title: TODO_WORKER }, { title: `${GATEWAY}-OAUTH_KV` }],
      r2: [`${TODO_WORKER}--media`, `${TODO_WORKER}--uploads`],
      hyperdrive: [{ name: `${TODO_WORKER}--pg`, id: "hd-ours" }],
      vectorize: [`${TODO_WORKER}--vectors`],
      aiGateway: [`${TODO_WORKER}-ai-gateway`],
      access: {
        applications: expect.arrayContaining([
          expect.objectContaining({ name: "Every App gateway" }),
          expect.objectContaining({ name: "Every App apps" }),
        ]),
        policy: { name: POLICY_NAME },
      },
      email: [
        {
          zoneName: HOST,
          rules: [{ id: "rule-ours", address: `support@${HOST}`, worker: TODO_WORKER }],
          catchAllWorker: TODO_WORKER,
          // Someone else's rule stays: routing stays on.
          disable: false,
        },
      ],
      kept: expect.arrayContaining([
        expect.stringContaining("Zero Trust team acme.cloudflareaccess.com"),
        `the zone ${HOST}`,
        "the Workers Paid subscription",
        "the workers.dev subdomain",
      ]),
    });
    expect(plan.access.applications).toHaveLength(2);
    // The hostnames' packs, never the Universal one.
    expect(plan.certificates.map((pack: { packId: string }) => pack.packId).sort()).toEqual(
      account.certificatePacks.filter((pack) => pack.type !== "universal").map((pack) => pack.id).sort(),
    );
    // The Custom Domain records at our names alone (the Custom Domains' own
    // placeholders, and the A record left at the app's): not the TXT there,
    // not the wildcard, not www's, and not Email Routing's MX at the apex.
    expect(plan.dns.flatMap((name: { name: string; records: Array<{ type: string }> }) => name.records.map((record) => `${record.type} ${name.name}`))).toEqual(
      [`AAAA ${HOST}`, `AAAA todo.${HOST}`, `A todo.${HOST}`],
    );
    expect(plan.kept).toContain(`the TXT record at todo.${HOST}, which EveryApp never created`);
    expect(plan.counts).toMatchObject({ workers: 2, workflows: 1, d1: 2, kv: 2, r2: 2, hyperdrive: 1, vectorize: 1, aiGateway: 1, secretsStore: 1, access: 3, email: 2, dns: 3 });
    expect(plan.secretsStore).toEqual([{ storeId: expect.any(String), name: `${TODO_WORKER}--stripe-key`, id: "ss-ours" }]);
    // Nothing of what isn't ours.
    expect(JSON.stringify(plan)).not.toMatch(/other-worker|customer-data|customer-cache|customer-backups|warehouse|product-search|support-bot|"everyapp"|payroll-api-key|www\.|\*\./);
  });
});

describe("teardown", () => {
  it("removes everything of EveryApp's and leaves everything else, then finds nothing left", async () => {
    await populate();
    const gatewayDbId = [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0];

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    // Workers, Workflows, D1, KV, Hyperdrive: only what isn't ours.
    expect([...account.workers.keys()]).toEqual(["other-worker"]);
    expect(account.customDomains.size).toBe(0);
    expect([...account.workflows.keys()]).toEqual([]);
    expect(dbNames()).toEqual(["customer-data"]);
    expect(kvTitles()).toEqual(["customer-cache"]);
    expect([...account.hyperdrive.keys()]).toEqual(["hd-theirs"]);
    expect([...account.vectorizeIndexes.keys()]).toEqual(["product-search"]);
    expect([...account.aiGateways.keys()].sort()).toEqual(["everyapp", "support-bot"]);
    // Secrets Store: our secret went, theirs and the store stay.
    expect([...account.secretsStores.values()].map((store) => [...store.secrets.keys()])).toEqual([["ss-theirs"]]);
    // R2: the empty bucket went; the one with objects is kept, and said.
    expect([...account.buckets.keys()].sort()).toEqual(["customer-backups", `${TODO_WORKER}--uploads`]);
    expect(warnings("TEARDOWN_DELETE_FAILED")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(`R2 bucket "${TODO_WORKER}--uploads"`),
        data: expect.objectContaining({ fix: expect.stringContaining("R2 Object Storage") }),
      }),
    ]);
    // Access: the applications and the policy, not the team or its providers (the Cloudflare account and the PIN).
    expect(account.zeroTrust.applications.size).toBe(0);
    expect(account.zeroTrust.policies.size).toBe(0);
    expect(account.zeroTrust.organization).not.toBeNull();
    expect(account.zeroTrust.identityProviders.size).toBe(2);
    // Certificates: the Universal pack alone.
    expect(account.certificatePacks.map((pack) => pack.id)).toEqual(["pack-universal"]);
    // Mail: our rule gone, the catch-all dropping, someone else's rule and routing kept.
    const routing = account.emailRoutingOf("zone-1");
    expect([...routing.rules.keys()]).toEqual(["rule-theirs"]);
    expect(routing.catchAll).toMatchObject({ enabled: false, actions: [{ type: "drop" }] });
    expect(routing.enabled).toBe(true);
    // DNS: the Custom Domain's kind of record at our name gone; the TXT there, the
    // wildcard and www's kept, and the MX stays with routing.
    expect(account.dnsRecords.map((record) => `${record.type} ${record.name}`).sort()).toEqual([
      `CNAME *.${HOST}`,
      `CNAME www.${HOST}`,
      `MX ${HOST}`,
      `TXT todo.${HOST}`,
    ]);
    // The done event: what went, what stayed and where.
    const result = done()!;
    expect(result["message"]).toMatch(
      new RegExp(`^Removed \\d+ resources from ${ACCOUNT_ID}; kept 1 \\(R2 bucket "${TODO_WORKER}--uploads": .*not empty.*\\)\\.$`),
    );
    expect(result["data"]).toMatchObject({
      accountId: ACCOUNT_ID,
      kept: [{ described: `R2 bucket "${TODO_WORKER}--uploads"`, place: expect.stringContaining("R2"), reason: expect.stringContaining("not empty") }],
    });
    const removed: string[] = result["data"]["removed"];
    expect(removed).toEqual(
      expect.arrayContaining([
        'Access application "Every App gateway"',
        'Access application "Every App apps"',
        `Access policy "${POLICY_NAME}"`,
        `Email Routing rule for support@${HOST} on ${HOST}`,
        `catch-all of ${HOST}`,
        `Workflow "${TODO_WORKER}--rank-check"`,
        `Worker "${TODO_WORKER}"`,
        `Worker "${GATEWAY}"`,
        `D1 database "${TODO_WORKER}"`,
        `D1 database "${GATEWAY}"`,
        `KV namespace "${TODO_WORKER}"`,
        `KV namespace "${GATEWAY}-OAUTH_KV"`,
        `R2 bucket "${TODO_WORKER}--media"`,
        `Hyperdrive config "${TODO_WORKER}--pg"`,
        `AI Gateway "${TODO_WORKER}-ai-gateway"`,
        `DNS A record at todo.${HOST}`,
      ]),
    );
    // The Custom Domains' own records went with the Workers, before the
    // DNS step read the names again: only the stray A record was deleted.
    expect(removed.filter((item) => item.startsWith("DNS"))).toEqual([`DNS A record at todo.${HOST}`]);
    expect(removed.filter((item) => item.startsWith("certificate pack"))).toHaveLength(2);
    expect(removed.length).toBe(result["data"]["plan"]["total"] - 1 - 2);
    // In order: Access, mail, Workflows, Workers (the Gateway's last), certificates, the apps' D1, KV, R2, Hyperdrive, DNS, and the Gateway's D1 last of all.
    const order = (item: string) => removed.indexOf(item);
    expect(order('Access application "Every App apps"')).toBeLessThan(order(`Access policy "${POLICY_NAME}"`));
    expect(order(`Access policy "${POLICY_NAME}"`)).toBeLessThan(order(`catch-all of ${HOST}`));
    expect(order(`catch-all of ${HOST}`)).toBeLessThan(order(`Workflow "${TODO_WORKER}--rank-check"`));
    expect(order(`Workflow "${TODO_WORKER}--rank-check"`)).toBeLessThan(order(`Worker "${TODO_WORKER}"`));
    expect(order(`Worker "${TODO_WORKER}"`)).toBeLessThan(order(`Worker "${GATEWAY}"`));
    expect(order(`Worker "${GATEWAY}"`)).toBeLessThan(order(`D1 database "${TODO_WORKER}"`));
    expect(order(`D1 database "${TODO_WORKER}"`)).toBeLessThan(order(`KV namespace "${TODO_WORKER}"`));
    expect(order(`Hyperdrive config "${TODO_WORKER}--pg"`)).toBeLessThan(order(`AI Gateway "${TODO_WORKER}-ai-gateway"`));
    expect(order(`AI Gateway "${TODO_WORKER}-ai-gateway"`)).toBeLessThan(order(`DNS A record at todo.${HOST}`));
    expect(order(`DNS A record at todo.${HOST}`)).toBeLessThan(order(`D1 database "${GATEWAY}"`));
    expect(removed.at(-1)).toBe(`D1 database "${GATEWAY}"`);
    // Every Worker went with its references: the Gateway and the app bind each other.
    for (const call of account.cf.calls.filter((call) => call.args[0] === "workers" && call.args[1] === "delete")) {
      expect(call.args).toContain("--delete-with-references");
    }
    // The Gateway's D1 went by id.
    expect(account.databases.has(gatewayDbId)).toBe(false);

    // A second run, once the bucket was emptied by hand: nothing left, and no confirmation asked.
    account.buckets.delete(`${TODO_WORKER}--uploads`);
    await run();
    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(done()).toMatchObject({
      message: `Nothing of EveryApp is left in ${ACCOUNT_ID}.`,
      data: { accountId: ACCOUNT_ID, removed: [], kept: [], plan: expect.objectContaining({ total: 0, gateway: null }) },
    });
    expect(writes()).toEqual([]);
    expect([...account.workers.keys()]).toEqual(["other-worker"]);
  });

  it("turns Email Routing off, and its MX records go, once only EveryApp's rules were there", async () => {
    await populate({ foreignMailRule: false });

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    const routing = account.emailRoutingOf("zone-1");
    expect(routing.enabled).toBe(false);
    expect(routing.rules.size).toBe(0);
    expect(account.dnsRecords.map((record) => `${record.type} ${record.name}`).sort()).toEqual([
      `CNAME *.${HOST}`,
      `CNAME www.${HOST}`,
      `TXT todo.${HOST}`,
    ]);
    expect(done()!["data"]["removed"]).toEqual(expect.arrayContaining([`Email Routing on ${HOST}`]));
    expect(done()!["data"]["plan"]["email"][0]).toMatchObject({ disable: true });
  });

  it("detaches our Workers' queue consumers before the Workers, deletes our queues after them, and leaves the rest", async () => {
    await populate();
    const jobs = account.createQueue(`${TODO_WORKER}--jobs`);
    account.queues.get(jobs)!.consumers.set("consumer-ours", { script: TODO_WORKER, settings: {} });
    // Someone else's queue our Worker consumes, and one only theirs consumes.
    const customerEvents = account.createQueue("customer-events");
    account.queues.get(customerEvents)!.consumers.set("consumer-on-theirs", { script: TODO_WORKER, settings: {} });
    const theirs = account.createQueue("customer-queue");
    account.queues.get(theirs)!.consumers.set("consumer-theirs", { script: "other-worker", settings: {} });
    // The Gateway's own activation queue (setup made it) is ours too.
    const activation = [...account.queues].find(([, queue]) => queue.name === "every-app-gateway-activate")![0];

    await run({ dryRun: true });
    expect(done()!["data"]["plan"]).toMatchObject({
      queues: [
        { name: `${TODO_WORKER}--jobs`, id: jobs },
        { name: "every-app-gateway-activate", id: activation },
      ],
      queueConsumers: [
        { queueId: customerEvents, queueName: "customer-events", consumerId: "consumer-on-theirs", script: TODO_WORKER },
        { queueId: jobs, queueName: `${TODO_WORKER}--jobs`, consumerId: "consumer-ours", script: TODO_WORKER },
      ],
      counts: expect.objectContaining({ queues: 2, queueConsumers: 2 }),
    });

    await run({ confirm: ACCOUNT_ID });
    expect([...account.queues.values()].map((queue) => queue.name).sort()).toEqual(["customer-events", "customer-queue"]);
    expect(account.queues.get(customerEvents)!.consumers.size).toBe(0);
    expect([...account.queues.get(theirs)!.consumers.keys()]).toEqual(["consumer-theirs"]);
    const removed: string[] = done()!["data"]["removed"];
    const order = (item: string) => removed.indexOf(item);
    expect(order(`consumer ${TODO_WORKER} of Queue "${TODO_WORKER}--jobs"`)).toBeGreaterThanOrEqual(0);
    expect(order(`consumer ${TODO_WORKER} of Queue "customer-events"`)).toBeLessThan(order(`Worker "${TODO_WORKER}"`));
    expect(order(`Worker "${GATEWAY}"`)).toBeLessThan(order(`Queue "${TODO_WORKER}--jobs"`));
    expect(order(`Hyperdrive config "${TODO_WORKER}--pg"`)).toBeLessThan(order(`Queue "${TODO_WORKER}--jobs"`));
    expect(warnings("TEARDOWN_DELETE_FAILED").map((warning) => warning["message"])).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Queue")]),
    );
  });

  it("goes on past a failure, keeps the item, and says where it is", async () => {
    await populate();
    account.cf.override(["hyperdrive", "delete"], {
      exitCode: 1,
      stderr: "┌ APIError\n│ [2010] Hyperdrive config is in use [code: 2010]\n└\n",
    });

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect([...account.workers.keys()]).toEqual(["other-worker"]);
    expect([...account.hyperdrive.keys()].sort()).toEqual(["hd-ours", "hd-theirs"]);
    expect(done()!["data"]["kept"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ described: `Hyperdrive config "${TODO_WORKER}--pg"`, place: "Storage & Databases → Hyperdrive" }),
      ]),
    );
    expect(done()!["message"]).toContain("kept 2");
  });

  it("keeps a Worker Cloudflare refused, and a second run removes it", async () => {
    await populate();
    let refusals = 0;
    account.cf.override(
      (args) => args[0] === "workers" && args[1] === "delete" && args[2] === TODO_WORKER && refusals++ === 0,
      { exitCode: 1, stderr: "┌ APIError\n│ [10000] Internal error [code: 10000]\n└\n" },
    );

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect([...account.workers.keys()].sort()).toEqual([TODO_WORKER, "other-worker"]);
    expect(done()!["data"]["kept"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ described: `Worker "${TODO_WORKER}"`, place: expect.stringContaining("Workers & Pages") })]),
    );

    // The second run: the Gateway's D1 is gone, so the Worker is found by name alone.
    account.buckets.delete(`${TODO_WORKER}--uploads`);
    await run({ confirm: ACCOUNT_ID });
    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(done()).toMatchObject({
      message: `Removed 1 resource from ${ACCOUNT_ID}.`,
      data: { removed: [`Worker "${TODO_WORKER}"`], kept: [], plan: expect.objectContaining({ gateway: null }) },
    });
    expect([...account.workers.keys()]).toEqual(["other-worker"]);

    await run();
    expect(done()!["message"]).toBe(`Nothing of EveryApp is left in ${ACCOUNT_ID}.`);
  });

  it("counts a certificate pack Cloudflare refused but had already removed with its Custom Domain as removed, and the Gateway's D1 goes", async () => {
    await populate();
    // The live wipe of 2026-10-24: deleting the hostname's pack answered 1406
    // while Cloudflare was removing it with the Custom Domain. One pack is gone
    // from the zone's list by the time it is read again, the other is listed
    // as pending deletion.
    const planned = account.certificatePacks.filter((pack) => pack.type !== "universal");
    expect(planned).toHaveLength(2);
    account.cf.override(
      (args) => args[0] === "ssl" && args[1] === "certificate-packs" && args[2] === "delete",
      (call) => {
        const index = account.certificatePacks.findIndex((pack) => pack.id === call.args[3]);
        if (index >= 0) {
          if (account.certificatePacks[index]!.id === planned[0]!.id) account.certificatePacks.splice(index, 1);
          else account.certificatePacks[index]!.status = "pending_deletion";
        }
        return {
          exitCode: 1,
          stderr: `\n┌ APIError\n│ [1406] Bad response certificate service\n│ 400 Bad Request · HTTP /zones/zone-1/ssl/certificate_packs/${call.args[3]}\n└\n`,
        };
      },
    );

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    // Neither pack is kept, and neither is a warning: the only warning is the R2 bucket's.
    expect(warnings("TEARDOWN_DELETE_FAILED").map((event) => event["data"]["kind"])).toEqual(["r2"]);
    const removed: string[] = done()!["data"]["removed"];
    expect(removed.filter((item) => item.startsWith("certificate pack"))).toEqual(
      planned.map((pack) => expect.stringMatching(new RegExp(`^certificate pack ${pack.id} for .* \\(gone with its Custom Domain\\)$`))),
    );
    // The pack listing was read once by the inventory (active packs only, as
    // cf lists by default), then again once per refusal with every status:
    // the default listing would hide the pending one and read it as gone.
    const listings = account.cf.calls.filter((call) => call.args[0] === "ssl" && call.args[2] === "list");
    expect(listings.map((call) => call.args.includes("--status"))).toEqual([false, true, true]);
    expect(listings.slice(1).every((call) => call.args[call.args.indexOf("--status") + 1] === "all")).toBe(true);
    expect(sleeps).toEqual([]);
    // Nothing held the Gateway's D1 back: the next install starts fresh.
    expect(removed.at(-1)).toBe(`D1 database "${GATEWAY}"`);
    expect(dbNames()).toEqual(["customer-data"]);
    expect(done()!["data"]["kept"]).toEqual([expect.objectContaining({ kind: "r2" })]);

    account.buckets.delete(`${TODO_WORKER}--uploads`);
    await run();
    expect(done()!["message"]).toBe(`Nothing of EveryApp is left in ${ACCOUNT_ID}.`);
  });

  it("keeps a certificate pack Cloudflare truly refused, with the note, and no longer holds the Gateway's D1 for it", async () => {
    await populate();
    let refusals = 0;
    account.cf.override(
      (args) => args[0] === "ssl" && args[1] === "certificate-packs" && args[2] === "delete" && refusals++ === 0,
      { exitCode: 1, stderr: "┌ APIError\n│ [1000] Internal error [code: 1000]\n└\n" },
    );
    const packs = () => account.certificatePacks.map((pack) => pack.id).sort();
    const before = packs();

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    // Still listed and active after the refusal: kept, with its hostname, the
    // note, and where to finish it.
    const keptPack = done()!["data"]["kept"].find((item: { described: string }) => item.described.startsWith("certificate pack"));
    expect(keptPack).toMatchObject({
      kind: "certificates",
      described: expect.stringMatching(new RegExp(`^certificate pack pack-\\d+ for (todo\\.)?${HOST.replace(".", "\\.")}$`)),
      reason: expect.stringMatching(/^\[1000\] Internal error.*Cloudflare removes a hostname's pack with its Custom Domain.*dashboard$/),
      place: "the zone → SSL/TLS → Edge Certificates",
    });
    expect(packs()).toHaveLength(before.length - 1);
    // Still active at the first look right after the refusal: one wait, a
    // second look with every status, and only then kept.
    expect(sleeps).toEqual([5_000]);
    expect(
      account.cf.calls.filter((call) => call.args[0] === "ssl" && call.args[2] === "list" && call.args.includes("--status")),
    ).toHaveLength(2);
    // The Gateway's D1 isn't held for a pack: it goes, last of all.
    expect(done()!["data"]["removed"].at(-1)).toBe(`D1 database "${GATEWAY}"`);
    expect(done()!["data"]["kept"].map((item: { kind: string }) => item.kind).sort()).toEqual(["certificates", "r2"]);
    expect(dbNames()).toEqual(["customer-data"]);

    // The next run has no hostnames to find the pack by: the account reads as
    // empty, and the pack is the dashboard's (or Cloudflare's own cleanup).
    account.buckets.delete(`${TODO_WORKER}--uploads`);
    await run();
    expect(done()!["message"]).toBe(`Nothing of EveryApp is left in ${ACCOUNT_ID}.`);
    expect(packs()).toHaveLength(before.length - 1);
  });

  it("keeps a certificate pack the re-list shows in a status that isn't deleting (deletion_timed_out)", async () => {
    await populate();
    // Cloudflare refused, and the pack is still there: no longer active, so
    // the default listing hides it, but listed with every status as stuck.
    let refusals = 0;
    account.cf.override(
      (args) => args[0] === "ssl" && args[1] === "certificate-packs" && args[2] === "delete" && refusals++ === 0,
      (call) => {
        const pack = account.certificatePacks.find((candidate) => candidate.id === call.args[3]);
        if (pack) pack.status = "deletion_timed_out";
        return {
          exitCode: 1,
          stderr: `\n┌ APIError\n│ [1406] Bad response certificate service\n│ 400 Bad Request · HTTP /zones/zone-1/ssl/certificate_packs/${call.args[3]}\n└\n`,
        };
      },
    );
    const before = account.certificatePacks.length;

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    const stuck = account.certificatePacks.find((pack) => pack.status === "deletion_timed_out");
    expect(stuck).toBeDefined();
    expect(account.certificatePacks).toHaveLength(before - 1);
    expect(done()!["data"]["removed"].filter((item: string) => item.startsWith("certificate pack"))).toHaveLength(1);
    expect(done()!["data"]["kept"]).toContainEqual(
      expect.objectContaining({
        kind: "certificates",
        described: expect.stringMatching(new RegExp(`^certificate pack ${stuck!.id} for `)),
        reason: expect.stringMatching(/^\[1406\] Bad response certificate service.*Cloudflare removes a hostname's pack with its Custom Domain.*dashboard$/),
      }),
    );
    expect(warnings("TEARDOWN_DELETE_FAILED").map((event) => event["data"]["kind"])).toEqual(["certificates", "r2"]);
    // Looked twice (a wait between), and the D1 went anyway.
    expect(sleeps).toEqual([5_000]);
    expect(done()!["data"]["removed"].at(-1)).toBe(`D1 database "${GATEWAY}"`);
    expect(dbNames()).toEqual(["customer-data"]);
  });

  it("holds the Gateway's D1 for a kept DNS record, and a second run finds the record again through it", async () => {
    await populate();
    let refusals = 0;
    account.cf.override(
      (args) => args[0] === "dns" && args[1] === "records" && args[2] === "delete" && refusals++ === 0,
      { exitCode: 1, stderr: "┌ APIError\n│ [1000] Internal error [code: 1000]\n└\n" },
    );

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(done()!["data"]["kept"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "dns", described: `DNS A record at todo.${HOST}` }),
        expect.objectContaining({
          described: `D1 database "${GATEWAY}"`,
          reason: "kept on purpose: the next run reads the hostnames of the 1 kept DNS record above from it",
        }),
      ]),
    );
    expect(done()!["data"]["removed"]).not.toContain(`D1 database "${GATEWAY}"`);
    expect(dbNames()).toEqual(["customer-data", GATEWAY]);

    account.buckets.delete(`${TODO_WORKER}--uploads`);
    await run({ confirm: ACCOUNT_ID });
    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(done()!["data"]["removed"]).toEqual([`DNS A record at todo.${HOST}`, `D1 database "${GATEWAY}"`]);
    expect(dbNames()).toEqual(["customer-data"]);
    expect(account.dnsRecords.map((record) => `${record.type} ${record.name}`)).not.toContain(`A todo.${HOST}`);
  });

  it("cleans an account whose Gateway database is already gone, by name alone", async () => {
    await populate();
    const gatewayDbId = [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0];
    account.databases.delete(gatewayDbId);

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    const plan = done()!["data"]["plan"];
    expect(plan.gateway).toBeNull();
    expect(plan.workers.map((worker: { name: string }) => worker.name)).toEqual([TODO_WORKER, GATEWAY]);
    expect(plan.access.applications).toHaveLength(2);
    expect(plan.access.policy).toMatchObject({ name: POLICY_NAME });
    // The hostnames come from the Workers' Custom Domains now.
    expect(plan.certificates.map((pack: { hostname: string }) => pack.hostname).sort()).toEqual([HOST, `todo.${HOST}`]);
    expect([...account.workers.keys()]).toEqual(["other-worker"]);
    expect([...account.workflows.keys()]).toEqual([]);
    expect(dbNames()).toEqual(["customer-data"]);
    expect(kvTitles()).toEqual(["customer-cache"]);
    expect([...account.hyperdrive.keys()]).toEqual(["hd-theirs"]);
    expect(account.zeroTrust.applications.size).toBe(0);
    expect(account.zeroTrust.policies.size).toBe(0);
    expect(account.certificatePacks.map((pack) => pack.id)).toEqual(["pack-universal"]);
    expect(account.emailRoutingOf("zone-1").rules.size).toBe(1);
  });

  it("treats Access and R2 the account never enabled as empty: a skip step each, no warning, nothing kept", async () => {
    await populate();
    // A fresh account on 2026-10-24: 403 with the service's own "not enabled"
    // code on access/organizations and r2/buckets.
    account.accessNotEnabled = true;
    account.r2NotEnabled = true;

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(warnings("TEARDOWN_READ_FAILED")).toEqual([]);
    // In inventory order: R2 (kind 6), then Access (kind 8).
    expect(events.filter((event) => event["type"] === "step" && event["status"] === "skip")).toEqual([
      expect.objectContaining({
        step: "teardown.found",
        message: "R2 isn't enabled in this account: nothing of its to delete",
        data: expect.objectContaining({ what: "the R2 buckets", service: "R2", reason: expect.stringContaining("[10042] Please enable R2") }),
      }),
      expect.objectContaining({
        step: "teardown.found",
        message: "Cloudflare Access isn't enabled in this account: nothing of its to delete",
        data: expect.objectContaining({ what: "the Zero Trust team", service: "Cloudflare Access", reason: expect.stringContaining("[9999] access.api.error.not_enabled") }),
      }),
    ]);
    const plan = done()!["data"]["plan"];
    expect(plan.counts).toMatchObject({ access: 0, r2: 0 });
    expect(plan.access).toEqual({ applications: [], policy: null });
    expect(plan.kept).not.toContainEqual(expect.stringContaining("couldn't be listed"));
    expect(plan.kept).not.toContainEqual(expect.stringContaining("Zero Trust team"));
    // Everything else went, and nothing was kept: the bucket with objects was never in the plan.
    expect([...account.workers.keys()]).toEqual(["other-worker"]);
    expect(dbNames()).toEqual(["customer-data"]);
    expect(done()).toMatchObject({ message: expect.stringMatching(/^Removed \d+ resources from /), data: { kept: [] } });
    expect(done()!["message"]).not.toContain("kept");
  });

  it("goes on when one kind can't be listed, keeps that kind, and says so", async () => {
    await populate();
    account.cf.override(["hyperdrive", "list"], {
      exitCode: 1,
      stderr: "┌ APIError\n│ [10000] Authentication error [code: 10000]\n└\n",
    });

    await run({ confirm: ACCOUNT_ID });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(warnings("TEARDOWN_READ_FAILED")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Couldn't list the Hyperdrive configs") }),
    ]);
    expect([...account.hyperdrive.keys()].sort()).toEqual(["hd-ours", "hd-theirs"]);
    expect(done()!["data"]["plan"]["kept"]).toContainEqual(expect.stringContaining("the Hyperdrive configs (couldn't be listed"));
    expect([...account.workers.keys()]).toEqual(["other-worker"]);
  });
});

/**
 * Review (adversarial): ways the teardown deletes what isn't Every App's.
 * Each failing test here is a hole reported with it.
 */
describe("teardown review: what it must leave alone", () => {
  it("leaves DNS records at the Gateway host and an app host that EveryApp never created (another provider's MX, SPF, verification)", async () => {
    await populate();
    // The Gateway sits at the apex, as everyapp.team does; the zone's mail and
    // verification records live at the same name, next to the Custom Domain
    // (lib/domains/preflight.ts: "mail and TXT records stay, next to the Custom Domain").
    const foreign = [
      { zoneId: "zone-1", name: HOST, type: "MX", content: "aspmx.l.google.com" },
      { zoneId: "zone-1", name: HOST, type: "TXT", content: "v=spf1 include:_spf.google.com ~all" },
      { zoneId: "zone-1", name: HOST, type: "TXT", content: "google-site-verification=abc123" },
      { zoneId: "zone-1", name: HOST, type: "CAA", content: '0 issue "letsencrypt.org"' },
      { zoneId: "zone-1", name: `todo.${HOST}`, type: "MX", content: "mail.example.net" },
    ];
    account.dnsRecords.push(...foreign);

    await run({ confirm: ACCOUNT_ID });

    const left = account.dnsRecords.map((record) => `${record.type} ${record.name} ${record.content}`);
    expect(left).toEqual(
      expect.arrayContaining(foreign.map((record) => `${record.type} ${record.name} ${record.content}`)),
    );
    expect(done()!["data"]["removed"].filter((item: string) => item.startsWith("DNS"))).not.toEqual(
      expect.arrayContaining([`DNS MX record at ${HOST}`, `DNS TXT record at ${HOST}`, `DNS CAA record at ${HOST}`, `DNS MX record at todo.${HOST}`]),
    );
  });

  it("keeps Email Routing on while someone else's catch-all still forwards the zone's mail", async () => {
    await populate({ foreignMailRule: false });
    const routing = account.emailRoutingOf("zone-1");
    routing.catchAll = {
      ...routing.catchAll,
      name: "forward everything to ben",
      enabled: true,
      actions: [{ type: "forward", value: ["ben@gmail.com"] }],
    };

    await run({ confirm: ACCOUNT_ID });

    // The one rule was ours and went; the catch-all isn't ours and still needs routing on.
    expect(routing.rules.size).toBe(0);
    expect(routing.catchAll).toMatchObject({ enabled: true, actions: [{ type: "forward", value: ["ben@gmail.com"] }] });
    expect(routing.enabled).toBe(true);
    expect(account.dnsRecords.map((record) => `${record.type} ${record.name}`)).toContain(`MX ${HOST}`);
  });

  it("makes nothing but read calls before the confirmation (every cf verb of a dry run named)", async () => {
    await populate();
    await run({ dryRun: true });
    const READS = [
      /^auth whoami$/,
      /^d1 list/,
      /^d1 query/,
      /^workers list/,
      /^workflows list/,
      /^kv namespaces list/,
      /^r2 buckets list/,
      /^hyperdrive list/,
      /^secrets-store stores list/,
      /^secrets-store secrets list/,
      /^queues list/,
      /^vectorize list/,
      /^ai-gateway gateways list/,
      /^zero-trust organization get/,
      /^zero-trust access applications list/,
      /^zero-trust access policies list/,
      /^zones list/,
      /^email-routing settings get/,
      /^email-routing rules list-account/,
      /^email-routing rules catch-all get/,
      /^ssl certificate-packs list/,
      /^dns records list/,
    ];
    const verbs = [...new Set(account.cf.calls.map((call) => call.args.slice(0, 4).join(" ")))];
    const unexpected = verbs.filter((verb) => !READS.some((read) => read.test(verb)));
    expect(unexpected).toEqual([]);
    for (const call of account.cf.calls.filter((call) => call.args[0] === "d1" && call.args[1] === "query")) {
      expect(Object.values(call.files).join(" ")).toMatch(/^\s*(\{.*"sql":\s*"SELECT|.*SELECT)/s);
      expect(Object.values(call.files).join(" ")).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i);
    }
  });
});

describe("teardown of one Gateway in an account that holds two", () => {
  const DEMO = gatewayNames("demo");
  /** Each Gateway's resources, by kind, as the fake account holds them. */
  const DEFAULT_SET = {
    workers: [TODO_WORKER, GATEWAY],
    d1: [TODO_WORKER, `${TODO_WORKER}--archive`, GATEWAY],
    kv: [`${GATEWAY}-OAUTH_KV`],
    queues: [`${GATEWAY}-activate`],
    aiGateway: [`${TODO_WORKER}-ai-gateway`],
  };
  const DEMO_SET = {
    workers: ["every-demo--acme-todo", DEMO.worker],
    d1: ["every-demo--acme-todo", "every-demo--acme-todo--archive", DEMO.d1],
    kv: [DEMO.oauthKv],
    queues: [DEMO.activationQueue],
    aiGateway: [`${DEMO.aiGatewayPrefix}acme-todo-ai-gateway`],
  };
  const sorted = (names: readonly string[]) => [...names].sort();
  /** What the fake account holds of these kinds. */
  const held = () => ({
    workers: sorted([...account.workers.keys()]),
    d1: dbNames(),
    kv: kvTitles(),
    queues: sorted([...account.queues.values()].map((queue) => queue.name)),
    aiGateway: sorted([...account.aiGateways.keys()]),
  });
  const addWorker = (name: string) => account.workers.set(name, { versions: ["v1"], config: { name }, secrets: {} });

  /** The default Gateway (deployed by beforeEach) with an app, and Gateway demo with its own, in one account. */
  async function twoGateways(): Promise<void> {
    addWorker(TODO_WORKER);
    account.createDatabase(TODO_WORKER);
    account.createDatabase(`${TODO_WORKER}--archive`);
    account.aiGateways.set(`${TODO_WORKER}-ai-gateway`, { id: `${TODO_WORKER}-ai-gateway`, collect_logs: true, cache_ttl: 0 });

    await ensureGatewayResources(account.cf, DEMO);
    addWorker(DEMO.worker);
    addWorker("every-demo--acme-todo");
    account.createDatabase("every-demo--acme-todo");
    account.createDatabase("every-demo--acme-todo--archive");
    const demoAi = `${DEMO.aiGatewayPrefix}acme-todo-ai-gateway`;
    account.aiGateways.set(demoAi, { id: demoAi, collect_logs: true, cache_ttl: 0 });
    events = [];
    account.cf.calls.length = 0;
  }

  /** A plan's names, kind by kind (the Gateway's Worker and D1 last, as deleted). */
  function planNames(plan: Record<string, any>) {
    return {
      workers: plan["workers"].map((worker: { name: string }) => worker.name),
      d1: plan["d1"].map((database: { name: string }) => database.name),
      kv: plan["kv"].map((namespace: { title: string }) => namespace.title),
      queues: plan["queues"].map((queue: { name: string }) => queue.name),
      aiGateway: plan["aiGateway"],
    };
  }

  function expectPlanOf(plan: Record<string, any>, set: typeof DEFAULT_SET, gatewayWorker: string) {
    const names = planNames(plan);
    expect(names.workers.at(-1)).toBe(gatewayWorker);
    expect(names.d1.at(-1)).toBe(gatewayWorker);
    expect(sorted(names.workers)).toEqual(sorted(set.workers));
    expect(sorted(names.d1)).toEqual(sorted(set.d1));
    expect(names.kv).toEqual(set.kv);
    expect(names.queues).toEqual(set.queues);
    expect(names.aiGateway).toEqual(set.aiGateway);
    for (const kind of ["workflows", "r2", "hyperdrive", "queueConsumers", "vectorize", "secretsStore", "email", "certificates"]) {
      expect(plan[kind], kind).toEqual([]);
    }
  }

  it("--gateway demo plans Gateway demo's resources alone, and the default teardown the default's alone", async () => {
    await twoGateways();

    await run({ gateway: "demo", dryRun: true });
    expect(writes()).toEqual([]);
    const demoPlan = done()!["data"]["plan"];
    expect(done()!["data"]).toMatchObject({ gateway: "demo", dryRun: true });
    expect(demoPlan).toMatchObject({ gatewayName: "demo", gatewayWorker: DEMO.worker, gateway: { gatewayHost: null }, access: { applications: [], policy: null }, dns: [] });
    expectPlanOf(demoPlan, DEMO_SET, DEMO.worker);
    expect(JSON.stringify(demoPlan)).not.toMatch(/"every-app-gateway"|every-app-gateway-OAUTH_KV|every-app-gateway-activate|every-acme-todo/);

    // Its Worker's name works as --gateway too.
    await run({ gateway: DEMO.worker, dryRun: true });
    expectPlanOf(done()!["data"]["plan"], DEMO_SET, DEMO.worker);

    await run({ dryRun: true });
    const defaultPlan = done()!["data"]["plan"];
    expect(defaultPlan).toMatchObject({ gatewayName: null, gatewayWorker: GATEWAY });
    expect(sorted(planNames(defaultPlan).workers)).toEqual(sorted(DEFAULT_SET.workers));
    expect(sorted(planNames(defaultPlan).d1)).toEqual(sorted(DEFAULT_SET.d1));
    expect(planNames(defaultPlan)).toMatchObject({ kv: DEFAULT_SET.kv, queues: DEFAULT_SET.queues, aiGateway: DEFAULT_SET.aiGateway });
    expect(JSON.stringify(defaultPlan)).not.toMatch(/every-app-gateway-demo|every-demo--/);
  });

  it("tears down Gateway demo, confirmed by its Worker name, and leaves every resource of the default Gateway", async () => {
    await twoGateways();
    const before = held();

    // The account id doesn't confirm a named Gateway's teardown; nothing is read.
    await expect(run({ gateway: "demo", confirm: ACCOUNT_ID })).rejects.toMatchObject({
      code: "TEARDOWN_CONFIRM_MISMATCH",
      fix: `pass --confirm ${DEMO.worker}`,
    });
    expect(account.cf.calls).toEqual([]);
    // Unattended without --confirm: the rerun carries the Worker name.
    await expect(run({ gateway: "demo" })).rejects.toMatchObject({
      code: "TEARDOWN_CONFIRMATION_REQUIRED",
      message: expect.stringContaining(`--confirm ${DEMO.worker}`),
      rerun: expect.stringMatching(new RegExp(` --confirm ${DEMO.worker}$`)),
    });
    // At a terminal, the account id typed is refused; the Worker name goes ahead.
    await expect(run({ gateway: "demo", interactive: true, askConfirmation: async () => ACCOUNT_ID })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(writes()).toEqual([]);

    await run({ gateway: "demo", confirm: ` ${DEMO.worker.toUpperCase()} ` });
    expect(done()!["data"]["kept"]).toEqual([]);
    const after = held();
    for (const kind of Object.keys(DEFAULT_SET) as Array<keyof typeof DEFAULT_SET>) {
      // Every resource of the default Gateway is still there, and none of demo's.
      expect(after[kind], kind).toEqual(expect.arrayContaining(DEFAULT_SET[kind]));
      for (const name of DEMO_SET[kind]) expect(after[kind], kind).not.toContain(name);
      expect(after[kind], kind).toEqual(sorted(before[kind].filter((name) => !DEMO_SET[kind].includes(name))));
    }
    // The default Gateway's database is whole: its install row is still read.
    await run({ dryRun: true });
    expect(done()!["data"]["plan"]).toMatchObject({ gateway: { gatewayHost: HOST } });
  });

  it("lets --gateway demo run on an account off the allowlist (and on the forbidden list), never the default teardown", async () => {
    await twoGateways();
    vi.stubEnv("EVERYAPP_FORBIDDEN_ACCOUNTS", ACCOUNT_ID);
    await run({ gateway: "demo", allowlist: OTHER_ACCOUNT, dryRun: true });
    expectPlanOf(done()!["data"]["plan"], DEMO_SET, DEMO.worker);

    await expect(run({ allowlist: OTHER_ACCOUNT, dryRun: true })).rejects.toMatchObject({ code: "TEARDOWN_ACCOUNT_FORBIDDEN" });
    vi.stubEnv("EVERYAPP_FORBIDDEN_ACCOUNTS", "");
    await expect(run({ allowlist: OTHER_ACCOUNT, dryRun: true })).rejects.toMatchObject({ code: "TEARDOWN_NOT_ALLOWLISTED" });
    await expect(run({ all: true, allowlist: OTHER_ACCOUNT, dryRun: true })).rejects.toMatchObject({ code: "TEARDOWN_NOT_ALLOWLISTED" });
    expect(account.cf.calls).toEqual([]);

    // Still a token, and one that lists the account.
    await expect(run({ gateway: "demo", allowlist: "", token: null, dryRun: true })).rejects.toMatchObject({ code: "TEARDOWN_NEEDS_TOKEN" });
    expect(account.cf.calls).toEqual([]);
    account.cf.override(["auth", "whoami"], {
      stdout: JSON.stringify({ authenticated: true, email: null, accounts: [{ id: OTHER_ACCOUNT, name: "Elsewhere" }] }),
    });
    await expect(run({ gateway: "demo", allowlist: "", dryRun: true })).rejects.toMatchObject({ code: "TEARDOWN_ACCOUNT_NOT_VISIBLE" });
    expect(account.cf.calls.map((call) => call.args.slice(0, 2))).toEqual([["auth", "whoami"]]);
  });

  it("refuses an invalid --gateway, and --gateway with --all, before anything is read", async () => {
    await expect(run({ gateway: "de-mo", dryRun: true })).rejects.toMatchObject({ code: "TEARDOWN_INVALID_GATEWAY" });
    await expect(run({ gateway: "every-app-gateway-de-mo", dryRun: true })).rejects.toMatchObject({ code: "TEARDOWN_INVALID_GATEWAY" });
    await expect(run({ gateway: "demo", all: true, dryRun: true })).rejects.toMatchObject({ code: "TEARDOWN_GATEWAY_AND_ALL" });
    expect(account.cf.calls).toEqual([]);
  });

  it("--all tears down every Gateway, the named ones first and the default last", async () => {
    await twoGateways();
    await run({ all: true, dryRun: true });
    const plans = done()!["data"]["plans"];
    expect(plans.map((plan: { gatewayName: string | null }) => plan.gatewayName)).toEqual(["demo", null]);
    expectPlanOf(plans[0], DEMO_SET, DEMO.worker);
    expect(sorted(planNames(plans[1]).workers)).toEqual(sorted(DEFAULT_SET.workers));

    await run({ all: true, confirm: ACCOUNT_ID });
    expect(done()!["data"]["kept"]).toEqual([]);
    const after = held();
    for (const kind of Object.keys(DEFAULT_SET) as Array<keyof typeof DEFAULT_SET>) {
      for (const name of [...DEFAULT_SET[kind], ...DEMO_SET[kind]]) expect(after[kind], kind).not.toContain(name);
    }
    expect(after).toEqual({ workers: [], d1: [], kv: [], queues: [], aiGateway: [] });
  });
});
