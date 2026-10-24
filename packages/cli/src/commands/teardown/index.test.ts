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
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { FORBIDDEN_ACCOUNTS } from "@/lib/teardown/guards";
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
 * Hyperdrive config, DNS left at our names, and a Worker, database,
 * namespace, bucket, config and record that are someone else's.
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
  account.cf.calls.length = 0;
}

type RunOptions = Partial<Parameters<typeof teardownAccount>[0]> & {
  accountId?: string;
  confirm?: string;
  dryRun?: boolean;
  token?: string | null;
  allowlist?: string;
};

/** Run the teardown as the loop would: a token and the allowlist in the environment, --json. */
function run({
  accountId = ACCOUNT_ID,
  confirm,
  dryRun,
  token = "loop-token",
  allowlist = ACCOUNT_ID,
  interactive = false,
  ...options
}: RunOptions = {}) {
  events = [];
  account.cf.calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", token ?? "");
  vi.stubEnv("EVERYAPP_TEST_ACCOUNTS", allowlist);
  return teardownAccount({
    flags: { "account-id": accountId, confirm, "dry-run": dryRun, json: !interactive },
    out: out(),
    createCf: () => account.cf,
    interactive,
    ...options,
  });
}

describe("teardown refuses", () => {
  it("the forbidden account, even when the allowlist names it, with no cf call made", async () => {
    const forbidden = FORBIDDEN_ACCOUNTS[0]!;
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
    expect(plan.kept).toContain(`the TXT record at todo.${HOST}, which Every App never created`);
    expect(plan.counts).toMatchObject({ workers: 2, workflows: 1, d1: 2, kv: 2, r2: 2, hyperdrive: 1, access: 3, email: 2, dns: 3 });
    // Nothing of what isn't ours.
    expect(JSON.stringify(plan)).not.toMatch(/other-worker|customer-data|customer-cache|customer-backups|warehouse|www\.|\*\./);
  });
});

describe("teardown", () => {
  it("removes everything of Every App's and leaves everything else, then finds nothing left", async () => {
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
    // R2: the empty bucket went; the one with objects is kept, and said.
    expect([...account.buckets.keys()].sort()).toEqual(["customer-backups", `${TODO_WORKER}--uploads`]);
    expect(warnings("TEARDOWN_DELETE_FAILED")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(`R2 bucket "${TODO_WORKER}--uploads"`),
        data: expect.objectContaining({ fix: expect.stringContaining("R2 Object Storage") }),
      }),
    ]);
    // Access: the applications and the policy, not the team or its provider.
    expect(account.zeroTrust.applications.size).toBe(0);
    expect(account.zeroTrust.policies.size).toBe(0);
    expect(account.zeroTrust.organization).not.toBeNull();
    expect(account.zeroTrust.identityProviders.size).toBe(1);
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
    expect(order(`Hyperdrive config "${TODO_WORKER}--pg"`)).toBeLessThan(order(`DNS A record at todo.${HOST}`));
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
      message: `Nothing of Every App is left in ${ACCOUNT_ID}.`,
      data: { accountId: ACCOUNT_ID, removed: [], kept: [], plan: expect.objectContaining({ total: 0, gateway: null }) },
    });
    expect(writes()).toEqual([]);
    expect([...account.workers.keys()]).toEqual(["other-worker"]);
  });

  it("turns Email Routing off, and its MX records go, once only Every App's rules were there", async () => {
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
    expect(done()!["message"]).toBe(`Nothing of Every App is left in ${ACCOUNT_ID}.`);
  });

  it("finds a certificate pack it kept again on a second run, since the Gateway's D1 goes last", async () => {
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
    const keptPack = done()!["data"]["kept"].find((item: { described: string }) => item.described.startsWith("certificate pack"));
    expect(keptPack).toBeDefined();
    expect(packs()).toHaveLength(before.length - 1);
    // The D1 the hostnames come from stays with it, on purpose and said so:
    // the Custom Domains that also named them went with the Workers.
    expect(done()!["data"]["removed"]).not.toContain(`D1 database "${GATEWAY}"`);
    expect(done()!["data"]["kept"]).toContainEqual(
      expect.objectContaining({ described: `D1 database "${GATEWAY}"`, reason: expect.stringContaining("kept on purpose") }),
    );
    expect(dbNames()).toEqual(["customer-data", GATEWAY]);

    // The second run finds the pack again, deletes it, and then the D1.
    account.buckets.delete(`${TODO_WORKER}--uploads`);
    await run({ confirm: ACCOUNT_ID });
    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(packs()).toEqual(["pack-universal"]);
    expect(done()!["data"]["removed"]).toEqual([keptPack.described, `D1 database "${GATEWAY}"`]);
    expect(dbNames()).toEqual(["customer-data"]);
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
  it("leaves DNS records at the Gateway host and an app host that Every App never created (another provider's MX, SPF, verification)", async () => {
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
