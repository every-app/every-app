/**
 * `everyapp setup` end to end against a fake Cloudflare account: real
 * gateway migrations on SQLite, Build Outputs checked with cf's schema,
 * and the person's part (approving a login, opening the setup link on the
 * deployed gateway) played by the test. setup asks nothing of the gateway
 * but one plain request: the owner wait reads the setup link's row in D1.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readInstall } from "@/lib/gateway/install";
import { markDeployed, register } from "@/lib/gateway/registry";
import { openRelease, RELEASE_TARBALL } from "@/lib/gateway/release";
import { gatewayReleaseSource } from "@/lib/gateway/source";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { mintSetupLink } from "@/lib/gateway/setup-link";
import { cfD1Database } from "@/lib/cf/d1";
import { CancelledError } from "@/lib/errors";
import { createHumanSink, createNdjsonSink, type EventSink } from "@/lib/output/events";
import { reportFailure } from "@/lib/output/report";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { fakeGithubReleases } from "@/test/fakeGithub";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { turnAccessOn } from "../access";
import { runGatewayDeploy, runSetup, setupDeps, type SetupDeps, type SetupFlags } from "./runSetup";

const GW = "apps.example.com";

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let home: string;
let events: any[];
let opened: string[];

beforeEach(async () => {
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  // An agent on someone's machine drives `setup --json`, not CI (which
  // GitHub Actions says for these tests too).
  vi.stubEnv("CI", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);
  tarball = await buildGatewayRelease();
  events = [];
  opened = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** The owner, opening the setup link the run hands out, while it waits. */
function ownerOpensTheLink(): () => Promise<void> {
  return async () => {
    const link = events.findLast(
      (event) => event.type === "action_required" && event.action === "claim_owner",
    );
    try {
      if (link) worker.claim(link.data.url);
    } catch {
      // Claimed already.
    }
  };
}

const nobodyOpensIt = { sleep: async () => undefined, timeoutMs: 0 };

function deps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    createCf: () => account.cf,
    openRelease: () => openRelease(tarball),
    source: () => releaseSource(tarball),
    interactive: false,
    prompts: {
      browserDeploymentToken: async () => null,
      accessInFront: async () => false,
      pickZone: async () => {
        throw new Error("asked a person");
      },
      gatewayAddress: async () => {
        throw new Error("asked a person");
      },
    },
    openBrowser: async (url) => {
      opened.push(url);
    },
    cliVersion: "0.3.0",
    seams: {
      sleep: async () => undefined,
      leaseWaitMs: 0,
      certificates: {
        probe: async () => ({ answered: true, status: 200, access: false }),
        sleep: async () => undefined,
      },
      fetch: worker.fetch,
      owner: { sleep: ownerOpensTheLink(), timeoutMs: 60_000 },
    },
    ...overrides,
  };
}

/** One `everyapp setup --json` run: its events, exit code and result. */
async function setup(flags: SetupFlags = {}, overrides: Partial<SetupDeps> = {}) {
  const out: EventSink = createNdjsonSink((line) => events.push(JSON.parse(line)));
  let result;
  try {
    result = await runSetup({ json: true, ...flags }, out, deps(overrides));
    out.emit({ type: "done" });
  } catch (error) {
    reportFailure(out, error);
  }
  return { result, exitCode: out.exitCode };
}

const steps = () =>
  events
    .filter((event) => event.type === "step" && event.status !== "start")
    .filter((event) => String(event.step).startsWith("setup."))
    .map((event) => `${event.step} ${event.status}`);

const gatewayD1 = () =>
  cfD1Database(account.cf, [...account.databases].find(([, d]) => d.name === "every-app-gateway")![0]);

/** A new setup link minted elsewhere (setup on another machine). */
const mintElsewhere = () => mintSetupLink({ db: gatewayD1(), gatewayUrl: `https://${GW}` });

const links = () => events.filter((event) => event.action === "claim_owner");

describe("everyapp setup", () => {
  it("takes an empty account to a live gateway on a subdomain and its owner", async () => {
    account.cf.override(["accounts", "subscriptions", "get"], {
      stdout: JSON.stringify([{ state: "Paid", rate_plan: { id: "workers_paid", public_name: "Workers Paid" } }]),
    });
    account.dnsRecords.push({ zoneId: "zone-1", name: "www.example.com", type: "CNAME", content: "site.example.net" });

    const { result, exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(0);
    expect(steps()).toEqual([
      "setup.toolchain ok",
      "setup.auth ok",
      "setup.account ok",
      "setup.plan ok",
      "setup.domain ok",
      "setup.gateway ok",
      "setup.owner ok",
    ]);
    // A fresh install says how long it takes before the owner link, and the
    // link's wait how long it lasts, so an agent gives the run the time.
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "start",
        data: expect.objectContaining({ change: "install", expectedMinutes: { min: 5, max: 10 } }),
      }),
    );
    expect(links()[0].data).toMatchObject({
      waiting: true,
      waitingFor: "the owner account (up to 15 minutes)",
    });
    expect(result).toEqual({
      gatewayUrl: `https://${GW}`,
      account: expect.any(String),
      owner: "owner@example.com",
      organizationName: "Owner",
      release: "0.2.0",
      releaseName: "0.2.0",
      gateway: "installed",
      ownerCreated: true,
      mode: "self_hosted",
      // Unattended (--json): on by itself only when the account can. This
      // one has no Zero Trust team yet, so one warning says so.
      accessOn: false,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "ACCESS_SETUP_SKIPPED",
        step: "setup.access",
        message: expect.stringContaining("Cloudflare Access wasn't turned on\nThis Cloudflare account has no Zero Trust team yet"),
        data: expect.objectContaining({ rerun: "pnpm everyapp access on --team example" }),
      }),
    );

    // The gateway, its own Custom Domain in the zone (with Cloudflare's
    // placeholder record at the name); no app yet.
    expect(account.gatewayDomains()).toEqual([GW]);
    expect(account.gatewayBindings()).toEqual([]);
    expect(account.dnsRecords).toEqual([
      expect.objectContaining({ name: "www.example.com" }),
      { zoneId: "zone-1", name: GW, type: "AAAA", content: "100::" },
    ]);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      gatewayHost: GW,
      appBaseDomain: GW,
      jwtPublicKey: expect.stringContaining("BEGIN PUBLIC KEY"),
    });

    // The owner link was handed out to the agent reading the events (never
    // opened by an unattended run, and never put in a CI log: see below),
    // after one plain request to the gateway.
    expect(links()).toEqual([
      expect.objectContaining({
        type: "action_required",
        data: expect.objectContaining({
          url: expect.stringMatching(new RegExp(`^https://${GW}/setup#token=est_`)),
          waiting: true,
        }),
      }),
    ]);
    expect(worker.requests).toEqual([`https://${GW}/`]);
    expect(opened).toEqual([]);
    // It says who claimed the link, so a person can tell it was them.
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.owner",
        status: "ok",
        message: "Owner account created for owner@example.com",
        data: { email: "owner@example.com", organizationName: "Owner" },
      }),
    );
    // Nothing is kept on this machine: the next run finds the Gateway
    // through the Cloudflare login.
    expect(fs.readdirSync(`${home}/.everyapp`)).toEqual(["cf"]);
  });

  it("resumes an install that stopped before its first upload, without --domain", async () => {
    account.failNextDeploy = `You need a workers.dev subdomain before your first upload. Register one: https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`;

    const first = await setup({ domain: GW });
    expect(first.exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({ action: "register_workers_subdomain" });

    events = [];
    const { exitCode } = await setup();
    expect(exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "start",
        data: expect.objectContaining({ gatewayUrl: `https://${GW}`, from: null, change: "resume" }),
      }),
    );
    expect(account.gatewayDomains()).toEqual([GW]);
  });

  it("resumes an install that stopped for the workers.dev subdomain after its first upload published the domain", async () => {
    // The account's first Worker: cf put the Gateway and its Custom Domain
    // live (Cloudflare's placeholder record at the name), then stopped
    // for the subdomain. Seen live on a fresh account on 2026-10-24.
    account.workersDevSubdomain = false;
    const first = await setup({ domain: GW });
    expect(first.exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({ action: "register_workers_subdomain" });
    expect(account.gatewayDomains()).toEqual([GW]);
    expect(account.dnsRecords).toEqual([{ zoneId: "zone-1", name: GW, type: "AAAA", content: "100::" }]);
    const deploys = account.deploys.length;

    // The person registers it, then runs the same command: the record at
    // the hostname is the Gateway's own, not a conflict.
    account.workersDevSubdomain = true;
    events = [];
    const { exitCode, result } = await setup({ domain: GW });

    expect(exitCode).toBe(0);
    // The row recorded the upload but not its hostname: this run finishes
    // the first publication, it doesn't "repair" a Gateway never live.
    expect(result).toMatchObject({ gateway: "installed", ownerCreated: true });
    expect(events.filter((event) => event.type === "error" || event.action === "rerun_interactive")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "start",
        message: `Finishing the Gateway's first publication at ${GW} (0.2.0)`,
        data: expect.objectContaining({ change: "resume", gatewayUrl: `https://${GW}` }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "ok",
        message: `The Gateway (0.2.0) is live at https://${GW}`,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        step: "gateway.domains",
        message: `${GW} is already this Gateway's Custom Domain (an earlier run published it, then stopped)`,
      }),
    );
    expect(steps()).toContain("setup.owner ok");
    expect(account.deploys).toHaveLength(deploys + 1);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      liveVersionId: account.workers.get("every-app-gateway")!.versions.at(-1),
      liveDomains: [GW],
      jwtPublicKey: expect.stringContaining("BEGIN PUBLIC KEY"),
    });
  });

  it("resumes that same stopped upload when the row never recorded it, without a terminal", async () => {
    // The install row as the live run left it: written before the upload
    // (no version, no key), while the Worker holds the hostname.
    account.workersDevSubdomain = false;
    await setup({ domain: GW });
    account.database("every-app-gateway").sqlite.exec(
      "UPDATE _everyapp_install SET live_version_id = NULL, jwt_public_key = NULL, deployment_mode = NULL",
    );
    account.workersDevSubdomain = true;
    events = [];

    const { exitCode, result } = await setup({ domain: GW });

    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ gateway: "installed", ownerCreated: true });
    expect(events.filter((event) => event.type === "error" || event.type === "action_required" && event.action !== "claim_owner")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "start",
        data: expect.objectContaining({ change: "resume", gatewayUrl: `https://${GW}` }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "step",
        step: "gateway.resume",
        status: "ok",
        message: expect.stringMatching(/^Replacing the Gateway an earlier run uploaded at apps\.example\.com\n/),
      }),
    );
    // A new key pair went with this upload, and the row names it.
    expect(account.deploys.at(-1)!.secrets).toHaveProperty("JWT_PUBLIC_KEY");
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      liveVersionId: account.workers.get("every-app-gateway")!.versions.at(-1),
      liveDomains: [GW],
      jwtPublicKey: account.deploys.at(-1)!.secrets!["JWT_PUBLIC_KEY"],
      deploymentMode: "self_hosted",
    });
  });

  it("still refuses the address when another Worker's Custom Domain, or any other record, is there", async () => {
    // Another Worker's Custom Domain, with the record Cloudflare keeps at it.
    account.workers.set("marketing-site", { versions: ["m-1"], config: { name: "marketing-site" }, secrets: {} });
    account.customDomains.set(GW, "marketing-site");
    account.dnsRecords.push({ zoneId: "zone-1", name: GW, type: "AAAA", content: "100::" });

    const { exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "DNS_RECORD_CONFLICT",
      message: `${GW} already points somewhere else\nIts DNS record: AAAA 100::. Publishing it replaces the record.`,
      data: { rerun: expect.stringContaining("--force-dns"), authorize: true },
    });
    expect(account.databases.size).toBe(0);
  });

  it("lets an install that never uploaded go to another address", async () => {
    account.failNextDeploy = `You need a workers.dev subdomain before your first upload. Register one: https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`;
    await setup({ domain: "typo.example.com" });

    events = [];
    const { exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(0);
    expect(account.gatewayDomains()).toEqual([GW]);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      gatewayHost: GW,
      appBaseDomain: GW,
    });
  });

  it("does nothing on a second run", async () => {
    await setup({ domain: GW });
    const deploys = account.deploys.length;
    events = [];

    const { exitCode, result } = await setup();

    expect(exitCode).toBe(0);
    expect(steps()).toEqual([
      "setup.toolchain ok",
      "setup.auth ok",
      "setup.account ok",
      "setup.domain ok",
      "setup.gateway skip",
      "setup.owner skip",
    ]);
    expect(result).toMatchObject({ organizationName: "Owner", gateway: "up-to-date", ownerCreated: false });
    expect(account.deploys).toHaveLength(deploys);
    expect(events.some((event) => event.type === "action_required")).toBe(false);
  });

  it("knows the Gateway is up to date from the install row's tree hash, without building", async () => {
    // Built from a checkout whose Gateway sources hash to "tree-1".
    const fromCheckout = {
      openRelease: () => openRelease(tarball, { origin: { kind: "checkout" }, treeSha256: "tree-1", committedAt: null }),
      source: async () => ({ ...(await releaseSource(tarball)), treeSha256: "tree-1" }),
    };
    await setup({ domain: GW }, fromCheckout);
    events = [];

    const { exitCode } = await setup({}, {
      ...fromCheckout,
      openRelease: async () => {
        throw new Error("built the Gateway");
      },
    });

    expect(exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "skip",
        data: expect.objectContaining({ upToDate: true, release: "0.2.0" }),
      }),
    );
  });

  it("binds and publishes the registered apps a Gateway that is up to date doesn't", async () => {
    await setup({ domain: GW });
    // An app registered and uploaded whose rebind never ran (a deploy that
    // stopped, a row written by hand).
    const { plan } = await register(gatewayD1(), {
      appSlug: "todo",
      name: "todo",
      description: "todo",
      manifest: { id: "todo" },
      appBaseDomain: GW,
      deployer: { actor: "dev@example.com", email: "dev@example.com" },
      organizationName: "Acme",
    });
    await markDeployed(gatewayD1(), plan.app.id, {
      versionId: "todo-v1",
      manifest: { id: "todo" },
      actor: "dev@example.com",
    });
    account.workers.set(plan.app.workerName!, {
      versions: ["todo-v1"],
      config: { name: plan.app.workerName, env: {} },
      secrets: {},
    });
    const deploys = account.deploys.length;
    events = [];

    const { exitCode, result } = await setup();

    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ gateway: "repaired" });
    expect(account.deploys).toHaveLength(deploys + 1);
    expect(account.gatewayBindings()).toEqual([plan.app.workerName]);
    expect(account.gatewayDomains().sort()).toEqual([GW, `todo.${GW}`].sort());
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "start",
        data: expect.objectContaining({ from: "0.2.0", release: "0.2.0", apps: 1, was: 0 }),
      }),
    );

    // Then there is nothing to do.
    events = [];
    const again = await setup();
    expect(again.result).toMatchObject({ gateway: "up-to-date" });
    expect(account.deploys).toHaveLength(deploys + 1);
  });

  it("uploads a Gateway that is up to date with --redeploy (the key-rotation runbook)", async () => {
    await setup({ domain: GW });
    const deploys = account.deploys.length;
    events = [];

    const { exitCode, result } = await setup({ redeploy: true });

    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ gateway: "repaired" });
    expect(account.deploys).toHaveLength(deploys + 1);
    // No new key pair: the Worker keeps the secrets it has.
    expect(account.deploys.at(-1)!.secrets).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "start",
        data: expect.objectContaining({ redeploy: true }),
      }),
    );
  });

  it("redeploys a Gateway changed in the dashboard, which a person confirms at the terminal", async () => {
    await setup({ domain: GW });
    // The key-rotation runbook: secrets replaced in the dashboard.
    account.workers.get("every-app-gateway")!.versions.push("dashboard-1");
    account.strictAbortNextDeploy = true;
    const deploys = account.deploys.length;
    events = [];

    const { exitCode, result } = await setup({ json: false }, { interactive: true });

    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ gateway: "repaired" });
    expect(account.deploys).toHaveLength(deploys + 1);
    // cf aborted piped, then ran attached to the terminal to ask about the
    // dashboard change.
    expect(account.deploys.at(-1)!.mode).toBe("interactive");
  });

  it("installs at --domain a Gateway whose database has no install row, then mints the owner link", async () => {
    // A Gateway installed by hand, or one whose install never got that far:
    // the database is there, but nothing recorded where it serves.
    await ensureGatewayResources(account.cf);

    const { exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(0);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({ gatewayHost: GW });
    expect(links()[0].data.url).toMatch(new RegExp(`^https://${GW}/setup#token=est_`));
    expect(steps()).toContain("setup.owner ok");
  });

  it("refuses a checkout behind the live Gateway, offering --allow-downgrade for an agent to ask about", async () => {
    const newer = await buildGatewayRelease({ builtAt: "2026-10-13T00:00:00.000Z" });
    await setup(
      { domain: GW },
      { openRelease: () => openRelease(newer), source: () => releaseSource(newer) },
    );
    events = [];

    const { exitCode } = await setup();

    expect(exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "DOWNGRADE_REFUSED",
      message: "This checkout's Gateway (0.2.0 from Oct 12) is older than the live one (from Oct 13)",
      data: {
        fix: "git pull, then run setup again",
        rerun: expect.stringContaining("--allow-downgrade"),
        authorize: true,
      },
    });
    const deploys = account.deploys.length;

    // Asked for: the older Gateway goes back.
    events = [];
    const rolledBack = await setup({ "allow-downgrade": true });
    expect(rolledBack.exitCode).toBe(0);
    expect(account.deploys).toHaveLength(deploys + 1);
    const older = await releaseSource(tarball);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      releaseOrder: older.order,
    });
  });

  describe("from a published release, with no checkout", () => {
    /** The events a Gateway source emits, among the run's. */
    const sink = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
    const fromSource = (source: { open: SetupDeps["openRelease"]; describe: SetupDeps["source"] }) => ({
      openRelease: source.open,
      source: source.describe,
    });
    const published = (fetch: typeof globalThis.fetch, release?: string) =>
      fromSource(gatewayReleaseSource({ out: sink(), cliVersion: "0.3.0", checkoutRoot: () => null, fetch, release }));

    it("installs this version's release of every-app/every-app, records where it came from, and is up to date next time", async () => {
      const github = fakeGithubReleases({
        "every-app/every-app": [{ tag: "gateway-v0.3.0", assets: { [RELEASE_TARBALL]: tarball } }],
      });

      const { result, exitCode } = await setup({ domain: GW }, published(github.fetch));

      expect(exitCode).toBe(0);
      expect(result).toMatchObject({ gateway: "installed", release: "0.2.0" });
      expect(events).toContainEqual(
        expect.objectContaining({
          step: "gateway.release",
          message: "Using Gateway 0.2.0 from every-app/every-app release gateway-v0.3.0",
        }),
      );
      // No checkout: no tree hash, ordered by the release's release.json; the origin kept for rebinds.
      await expect(readInstall(gatewayD1())).resolves.toMatchObject({
        sourceTreeSha256: null,
        releaseOrder: { committedAt: Date.parse("2026-10-12T00:00:00.000Z") },
        releaseOrigin: { kind: "github", repo: "every-app/every-app", tag: "gateway-v0.3.0" },
        releaseGitSha: "test",
      });

      // Run again, the same release is up to date, by its SHA-256.
      events = [];
      const again = await setup({}, published(github.fetch));
      expect(again.exitCode).toBe(0);
      expect(again.result).toMatchObject({ gateway: "up-to-date" });
    });

    it("installs --release <file>", async () => {
      const { result, exitCode } = await setup(
        { domain: GW, release: tarball },
        fromSource(gatewayReleaseSource({ out: sink(), cliVersion: "0.3.0", release: tarball })),
      );

      expect(exitCode).toBe(0);
      expect(result).toMatchObject({ gateway: "installed", release: "0.2.0" });
      expect(events).toContainEqual(
        expect.objectContaining({ step: "gateway.release", message: `Using Gateway 0.2.0 from ${tarball}` }),
      );
      await expect(readInstall(gatewayD1())).resolves.toMatchObject({
        releaseOrigin: { kind: "file", path: tarball },
      });
      expect(account.deploys).toHaveLength(1);
    });

    it("refuses a release that needs a newer everyapp, before anything is deployed", async () => {
      const needsNewer = await buildGatewayRelease({ version: "0.4.0", minCli: "0.4.0" });

      const { exitCode } = await setup({ domain: GW, release: needsNewer }, published(fetch, needsNewer));

      expect(exitCode).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "CLI_TOO_OLD",
        message: "Gateway 0.4.0 needs everyapp 0.4.0 or newer (this is 0.3.0)",
      });
      // Before anything is asked or created.
      expect(account.deploys).toHaveLength(0);
      expect(account.databases.size).toBe(0);
    });

    it("refuses a release older than the live Gateway, by its release.json, whichever source each came from", async () => {
      const newer = await buildGatewayRelease({ builtAt: "2026-10-13T00:00:00.000Z" });
      await setup({ domain: GW, release: newer }, published(fetch, newer));
      const deploys = account.deploys.length;
      events = [];

      // The published release for this CLI is the older build.
      const github = fakeGithubReleases({
        "every-app/every-app": [{ tag: "gateway-v0.3.0", assets: { [RELEASE_TARBALL]: tarball } }],
      });
      const { exitCode } = await setup({}, published(github.fetch));

      expect(exitCode).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "DOWNGRADE_REFUSED",
        message: "The Gateway from every-app/every-app release gateway-v0.3.0 (0.2.0 from Oct 12) is older than the live one (from Oct 13)",
        data: {
          fix: "pass --release a newer Gateway release",
          rerun: expect.stringContaining("--allow-downgrade"),
          authorize: true,
        },
      });
      expect(account.deploys).toHaveLength(deploys);
    });
  });

  it("never puts the owner setup link into a CI log, and ends done: apps deploy without an owner", async () => {
    vi.stubEnv("CI", "true");

    const { exitCode, result } = await setup({ domain: GW });

    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ gateway: "installed", owner: null, ownerCreated: false });
    expect(events.find((event) => event.code === "OWNER_NOT_CLAIMED")).toMatchObject({
      type: "warning",
      step: "setup.owner",
      message: expect.stringMatching(/^The Gateway has no owner yet\nApps deploy without one\./),
      // No link: only the command to run at a terminal.
      data: { rerun: "pnpm everyapp setup", rerunNote: "at a terminal", needsTerminal: true },
    });
    expect(events.some((event) => event.type === "action_required")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("#token=");
    // None minted, so a link someone already has keeps working.
    expect(account.database("every-app-gateway").all("SELECT id FROM owner_setup_tokens")).toEqual([]);
  });

  it("shows a person in CI each step on a line, then the warning that the owner is left", async () => {
    vi.stubEnv("CI", "true");
    let stdout = "";
    let stderr = "";
    const out = createHumanSink({
      write: (text) => {
        stdout += text;
      },
      writeProblem: (text) => {
        stderr += text;
      },
    });
    const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(0, -1);

    await runSetup({ domain: GW }, out, deps());

    expect(out.exitCode).toBe(0);
    expect(plain(stdout)).toEqual([
      "Setting up EveryApp in Acme (dev@example.com)",
      "EveryApp is in early development, so expect some rough edges: https://everyapp.com/docs/early-adopters",
      "Installing the Gateway at apps.example.com (0.2.0) (usually 5–10 minutes, then the owner link)",
      expect.stringMatching(/^Database created ✓/),
      expect.stringMatching(/^Uploaded ✓/),
    ]);
    expect(plain(stderr)).toEqual([
      "! The Gateway has no owner yet",
      "  Apps deploy without one. To create it, run setup at a terminal with this Cloudflare login.",
      "  Run: pnpm everyapp setup at a terminal",
    ]);
  });

  it("says what is in front of the gateway before handing out the link, and waits all the same", async () => {
    worker.accessInFront.add(GW);

    const behindAccess = await setup({ domain: GW });

    expect(behindAccess.exitCode).toBe(0);
    const warning = events.findIndex((event) => event.code === "ACCESS_IN_FRONT");
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(events.findIndex((event) => event.action === "claim_owner"));
    expect(steps()).toContain("setup.owner ok");
  });

  it("warns when the gateway doesn't answer over HTTPS yet", async () => {
    worker.certificatePending.add(GW);

    const { exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "GATEWAY_UNREACHABLE",
        message: expect.stringContaining("Its certificate is probably still on the way"),
      }),
    );
  });

  it("names DNS, not the certificate, when the gateway's name doesn't resolve yet", async () => {
    const noName = (async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error(`${GW} has no address at its zone's nameservers yet`), {
          code: "ENOTFOUND",
        }),
      });
    }) as typeof fetch;

    const { exitCode } = await setup({ domain: GW }, { seams: { ...deps().seams!, fetch: noName } });

    expect(exitCode).toBe(0);
    const warning = events.find((event) => event.code === "GATEWAY_UNREACHABLE");
    expect(warning.message).toContain(`DNS has no address for ${GW} yet`);
    expect(warning.message).not.toContain("certificate");
  });

  it("stops when nobody opens the setup link; the next run shows a new one, and the first stops working", async () => {
    const first = await setup(
      { domain: GW },
      { seams: { ...deps().seams!, owner: nobodyOpensIt } },
    );

    expect(first.exitCode).toBe(2);
    expect(links()).toHaveLength(2);
    expect(links()[1]).toMatchObject({
      message: expect.stringMatching(/^Open the setup link above to create the owner account\nNobody opened it within /),
      // Not shown again: it is on the screen already. The rerun keeps --json:
      // the agent that relayed the link runs it as it is.
      data: { setupUrl: links()[0].data.url, rerun: "pnpm everyapp setup --json", rerunNote: "to finish" },
    });
    expect(links()[1].data.url).toBeUndefined();
    const url = links()[0].data.url;

    // A resumed setup mints a new link, and says the earlier one no longer
    // works; the owner opening the new one finishes it.
    events = [];
    const second = await setup();
    expect(second.exitCode).toBe(0);
    expect(links()[0].data.url).not.toBe(url);
    expect(links()[0].message).toMatch(
      /^Open this new link to create the owner account\nThe link shown before no longer works\./,
    );
    expect(() => worker.claim(url)).toThrow("INVALID_OR_EXPIRED_SETUP_LINK");
    expect(steps()).toContain("setup.owner ok");
  });

  it("tells a person whose link nobody opened to run setup again, without --json", async () => {
    const { exitCode } = await setup(
      { json: false, domain: GW },
      { interactive: true, seams: { ...deps().seams!, owner: nobodyOpensIt } },
    );

    expect(exitCode).toBe(2);
    expect(links()[1]).toMatchObject({
      data: { rerun: "pnpm everyapp setup", rerunNote: "to finish" },
    });
  });

  it("finishes once someone opens the link a run that gave up showed", async () => {
    await setup({ domain: GW }, { seams: { ...deps().seams!, owner: nobodyOpensIt } });
    worker.claim(links()[0].data.url, { email: "later@example.com", name: "Later" });
    events = [];

    const { exitCode } = await setup();

    expect(exitCode).toBe(0);
    expect(links()).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.owner",
        status: "skip",
        data: { email: "later@example.com", organizationName: "Later" },
      }),
    );
  });

  it("stops with a new link to get when the link it waits on is replaced", async () => {
    let replaced = false;
    const { exitCode } = await setup(
      { domain: GW },
      {
        seams: {
          ...deps().seams!,
          owner: {
            timeoutMs: 60_000,
            sleep: async () => {
              if (!replaced) await mintElsewhere();
              replaced = true;
            },
          },
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "action_required",
      action: "claim_owner",
      message: expect.stringContaining("stopped working before anyone used it"),
    });
    // Whoever has the newer link can still use it.
    expect(
      account.database("every-app-gateway").all("SELECT id FROM owner_setup_tokens WHERE expires_at > ?", Date.now()),
    ).toHaveLength(1);
  });

  it("finishes when the newer link that replaced its own is the one used", async () => {
    let newer: string | undefined;
    const { exitCode } = await setup(
      { domain: GW },
      {
        seams: {
          ...deps().seams!,
          owner: {
            timeoutMs: 60_000,
            sleep: async () => {
              if (!newer) {
                newer = (await mintElsewhere()).url;
                worker.claim(newer, { email: "elsewhere@example.com" });
              }
            },
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.owner",
        status: "ok",
        data: expect.objectContaining({ email: "elsewhere@example.com" }),
      }),
    );
  });

  it("logs in through cf's device link and code under --json", async () => {
    let approved = false;
    account.cf
      .override(["auth", "whoami"], () => ({
        stdout: JSON.stringify(
          approved
            ? { authenticated: true, email: "dev@example.com", accounts: [{ id: account.accountId, name: "Acme" }] }
            : { authenticated: false },
        ),
      }))
      .override(["auth", "login"], () => {
        approved = true;
        return {
          stdout: "please visit:\n\n  https://dash.cloudflare.com/oauth2/device\n\nand enter the code:\n\n  ABCD-EFGH\n",
        };
      });

    const { exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "action_required",
        action: "cloudflare_login",
        data: { url: "https://dash.cloudflare.com/oauth2/device", code: "ABCD-EFGH", expiresAt: expect.any(String), waiting: true, waitingFor: "Cloudflare login" },
      }),
    );
    expect(steps()).toContain("setup.owner ok");
  });

  it("says how to buy a domain when the account has none, before installing anything", async () => {
    account.zones.length = 0;

    const { exitCode } = await setup();

    expect(exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "action_required",
      action: "add_domain",
      message: expect.stringMatching(/^Add a domain to this Cloudflare account\n/),
      data: { url: `https://dash.cloudflare.com/${account.accountId}/domains/overview` },
    });
    expect(account.deploys).toEqual([]);
    expect(account.databases.size).toBe(0);
  });

  it("says the command to run when unattended without --domain and the account has one zone", async () => {
    const { exitCode } = await setup();

    expect(exitCode).toBe(1);
    const error = events.at(-1);
    expect(error).toMatchObject({
      type: "error",
      code: "DOMAIN_REQUIRED",
      message: expect.stringMatching(/^Choose the Gateway's address with --domain\n.*: example\.com\./),
      data: {
        zones: ["example.com"],
        rerun: expect.stringMatching(/^pnpm everyapp\b.* --domain apps\.example\.com$/),
        rerunNote: "or another name under example.com",
      },
    });
    // The rerun says it all: an agent sent here by install_gateway isn't stuck.
    expect(error.data["fix"]).toBe("add --domain apps.example.com, or another name under example.com");
    expect(error.data).not.toHaveProperty("choices");
  });

  it("offers one command per zone when unattended without --domain and the account has several", async () => {
    account.zones.push({ id: "zone-2", name: "other.dev", status: "active" });

    const { exitCode } = await setup();

    expect(exitCode).toBe(1);
    const error = events.at(-1);
    expect(error).toMatchObject({
      type: "error",
      code: "DOMAIN_REQUIRED",
      message: expect.stringMatching(/: example\.com, other\.dev\./),
      data: {
        zones: ["example.com", "other.dev"],
        fix: "add --domain apps.example.com, or another name under example.com or other.dev",
        choices: [
          { label: "example.com", rerun: expect.stringMatching(/ --domain apps\.example\.com$/) },
          { label: "other.dev", rerun: expect.stringMatching(/ --domain apps\.other\.dev$/) },
        ],
      },
    });
    // No single command fits: the choices are the way on.
    expect(error.data).not.toHaveProperty("rerun");
  });

  it("warns about Workers Paid it can't confirm, never asks, and stops when Cloudflare refuses for the plan", async () => {
    account.cf.override(["accounts", "subscriptions", "get"], { stdout: "[]" });
    account.failNextDeploy = "Your account must be on the Workers Paid plan to use this feature.";

    const refused = await setup({ domain: GW });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "WORKERS_PAID_UNVERIFIED" }),
    );
    expect(refused.exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "action_required",
      action: "upgrade_workers_paid",
      message: expect.stringMatching(/^Subscribe this account to Workers Paid\n/),
      data: { url: `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/plans` },
    });

    // Subscribed: at a terminal, the same command goes on without a question
    // (the deps' prompts throw if asked).
    events = [];
    const { exitCode } = await setup({ domain: GW }, { interactive: true });
    expect(exitCode).toBe(0);
  });

  it("stops on a plan that reads as Free before creating anything", async () => {
    account.cf.override(["accounts", "subscriptions", "get"], {
      stdout: JSON.stringify([{ state: "Paid", rate_plan: { id: "workers_free", public_name: "Workers Free" } }]),
    });

    const { exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "action_required",
      action: "upgrade_workers_paid",
      data: { url: `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/plans`, plan: "free" },
    });
    expect(account.databases.size).toBe(0);
    expect(account.deploys).toEqual([]);
  });

  it("only notes a plan it can't read, for --verbose", async () => {
    account.cf.override(["accounts", "subscriptions", "get"], {
      exitCode: 1,
      stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
    });

    const { exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(0);
    expect(events.some((event) => event.code === "WORKERS_PAID_UNVERIFIED")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ step: "setup.plan", status: "skip", data: expect.objectContaining({ plan: "unreadable" }) }),
    );
  });

  it("refuses a --domain in no zone of the account, naming the account's domains", async () => {
    const { exitCode } = await setup({ domain: "apps.example.org" });

    expect(exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "ZONE_NOT_FOUND",
      message: "apps.example.org isn't under a domain in this Cloudflare account\nThis account's domains: example.com",
      data: { url: `https://dash.cloudflare.com/${ACCOUNT_ID}/domains/overview`, zones: ["example.com"] },
    });
    expect(account.databases.size).toBe(0);
  });

  it("asks for a --domain whose zone isn't active yet to be finished, then the same command", async () => {
    account.zones.push({ id: "zone-2", name: "pending.dev", status: "pending" });

    const { exitCode } = await setup({ domain: "apps.pending.dev" });

    expect(exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "action_required",
      action: "add_domain",
      message: "Finish activating pending.dev on Cloudflare\nIts nameservers don't point at Cloudflare yet.",
      data: { url: `https://dash.cloudflare.com/${ACCOUNT_ID}/pending.dev` },
    });
  });

  it("refuses a --domain that isn't a hostname before asking Cloudflare anything", async () => {
    const { exitCode } = await setup({ domain: "everyapp" });

    expect(exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "INVALID_DOMAIN",
      message: "--domain everyapp isn't a full hostname",
      data: { fix: "use a name like apps.example.com" },
    });
    expect(account.cf.calls).toEqual([]);
  });

  it("checks the new address's DNS before it says the install starts", async () => {
    account.dnsRecords.push({ zoneId: "zone-1", name: GW, type: "CNAME", content: "ghs.googlehosted.com" });

    const { exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "DNS_RECORD_CONFLICT" });
    expect(events.some((event) => event.step === "setup.gateway")).toBe(false);
    expect(account.databases.size).toBe(0);
  });

  it("asks a person at a terminal where the gateway goes, and opens the setup link", async () => {
    account.zones.push({ id: "zone-2", name: "other.dev", status: "active" });
    const asked: string[] = [];

    const { exitCode } = await setup(
      { json: false },
      {
        interactive: true,
        prompts: {
          browserDeploymentToken: async () => null,
          accessInFront: async () => false,
          pickZone: async () => {
            throw new Error("asked for a zone");
          },
          // One question, under any of the account's domains.
          gatewayAddress: async (zones) => {
            asked.push(zones.join(","));
            return "Tools.Example.com";
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    // Where, and nothing else: no go-ahead for the install.
    expect(asked).toEqual(["example.com,other.dev"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "start",
        data: expect.objectContaining({ gatewayUrl: "https://tools.example.com", from: null }),
      }),
    );
    expect(opened).toEqual([expect.stringMatching(/^https:\/\/tools\.example\.com\/setup#token=est_/)]);
    expect(account.gatewayDomains()).toEqual(["tools.example.com"]);
  });

  it("offers Cloudflare Access once the owner exists, Yes by default: Yes turns it on inside the run, No leaves it", async () => {
    const contexts: Array<{ owner: string; cloudflareEmail: string | null }> = [];
    let answer = false;
    const prompts: SetupDeps["prompts"] = {
      browserDeploymentToken: async () => null,
      accessInFront: async (context) => {
        contexts.push(context);
        return answer;
      },
      pickZone: async () => {
        throw new Error("asked for a zone");
      },
      gatewayAddress: async () => {
        throw new Error("asked for an address");
      },
    };
    const zt = account.zeroTrust;

    // No: nothing at Access, the next steps still recommend it.
    const declined = await setup({ json: false, domain: GW }, { interactive: true, prompts });
    expect(declined.exitCode).toBe(0);
    expect(declined.result).toMatchObject({ gateway: "installed", ownerCreated: true, accessOn: false });
    // Asked with the owner's address and the Cloudflare login's (the fake's whoami), for the prompt's context.
    expect(contexts).toEqual([{ owner: expect.stringContaining("@"), cloudflareEmail: expect.any(String) }]);
    expect(zt.organization).toBeNull();
    expect(zt.applications.size).toBe(0);
    expect(account.workers.get("every-app-gateway")!.secrets).not.toHaveProperty("CLOUDFLARE_ACCESS_AUD");

    // Yes, on the next run (the owner exists, Access isn't on): the team (named by the test, as a person would), both
    // sign-in methods, the policy with the owner, both applications and the settings; the inner done is a step.
    answer = true;
    events.length = 0;
    const agreed = await setup(
      { json: false, domain: GW },
      { interactive: true, prompts, askTeam: async (suggested) => `${suggested}-team` },
    );
    expect(agreed.exitCode).toBe(0);
    expect(agreed.result).toMatchObject({ gateway: "up-to-date", accessOn: true });
    expect(zt.organization).toMatchObject({ auth_domain: "example-team.cloudflareaccess.com" });
    expect([...zt.identityProviders.values()].map((p) => p["type"]).sort()).toEqual(["cloudflare", "onetimepin"]);
    expect(zt.applications.size).toBe(2);
    const secrets = account.workers.get("every-app-gateway")!.secrets;
    expect(secrets).toHaveProperty("CLOUDFLARE_ACCESS_TEAM_DOMAIN");
    expect(secrets).toHaveProperty("CLOUDFLARE_ACCESS_AUD");
    expect(secrets).toHaveProperty("CLOUDFLARE_ACCESS_APPS_AUD");
    const dones = events.filter((event) => event.type === "done");
    expect(dones).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "step",
        step: "setup.access",
        status: "ok",
        data: expect.objectContaining({
          team: expect.objectContaining({ created: true }),
          identityProviders: { oneTimePinAdded: true, cloudflareAdded: true },
          // The fake's owner has no password account to link, so nobody is pending.
          signIn: expect.objectContaining({ url: `https://${GW}`, first: "both" }),
        }),
      }),
    );
    expect(events.some((event) => event.type === "warning" && event.code === "ACCESS_SETUP_SKIPPED")).toBe(false);

    // On already: not asked again.
    const again = await setup({ json: false, domain: GW }, { interactive: true, prompts });
    expect(again.exitCode).toBe(0);
    expect(again.result).toMatchObject({ accessOn: null });
    expect(contexts).toHaveLength(2);
  });

  it("turns Access on by itself unattended when the account can, leaves it off with --no-access, and never from update", async () => {
    let asked = 0;
    const prompts: SetupDeps["prompts"] = {
      ...deps().prompts,
      accessInFront: async () => {
        asked += 1;
        return true;
      },
    };
    // The account can: a Zero Trust team exists, and whoever claims the
    // Gateway is the Cloudflare login itself (the fake's whoami, dev@example.com).
    account.zeroTrust.organization = { name: "acme", auth_domain: "acme.cloudflareaccess.com", session_duration: "720h" };
    const claimAsLogin = {
      ...deps().seams,
      owner: {
        sleep: async () => {
          const link = events.findLast((event) => event.type === "action_required" && event.action === "claim_owner");
          try {
            if (link) worker.claim(link.data.url, { email: "dev@example.com" });
          } catch {
            // Claimed already.
          }
        },
        timeoutMs: 60_000,
      },
    };
    const zt = account.zeroTrust;

    // --no-access: installed, claimed, nothing at Access, no warning either.
    const left = await setup({ domain: GW, "no-access": true }, { seams: claimAsLogin, prompts });
    expect(left.result).toMatchObject({ gateway: "installed", ownerCreated: true, owner: "dev@example.com", accessOn: null });
    expect(events.filter((event) => event.type === "warning" && event.code === "ACCESS_SETUP_SKIPPED")).toEqual([]);
    expect(zt.applications.size).toBe(0);

    // `update` never offers it, --yes or not.
    const out: EventSink = createNdjsonSink((line) => events.push(JSON.parse(line)));
    const updated = await runGatewayDeploy({ json: true, yes: true }, out, deps({ seams: claimAsLogin }));
    expect(updated).toMatchObject({ accessOn: null });
    expect(zt.applications.size).toBe(0);

    // Unattended (--json here; --yes at a terminal does the same): on, with
    // no question: both sign-in methods, the policy with the owner, both
    // applications, the three settings; the inner done is the step.
    events.length = 0;
    const on = await setup({ domain: GW }, { seams: claimAsLogin, prompts });
    expect(on.exitCode).toBe(0);
    expect(on.result).toMatchObject({ gateway: "up-to-date", accessOn: true });
    expect(asked).toBe(0);
    expect([...zt.identityProviders.values()].map((p) => p["type"]).sort()).toEqual(["cloudflare", "onetimepin"]);
    expect(zt.applications.size).toBe(2);
    const secrets = account.workers.get("every-app-gateway")!.secrets;
    expect(secrets).toHaveProperty("CLOUDFLARE_ACCESS_TEAM_DOMAIN");
    expect(secrets).toHaveProperty("CLOUDFLARE_ACCESS_AUD");
    expect(secrets).toHaveProperty("CLOUDFLARE_ACCESS_APPS_AUD");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "step", step: "setup.access", status: "ok", data: expect.objectContaining({ policy: expect.objectContaining({ emails: ["dev@example.com"] }) }) }),
    );
    expect(events.filter((event) => event.type === "warning" && event.code === "ACCESS_SETUP_SKIPPED")).toEqual([]);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);

    // On already: nothing more, and --yes at a terminal asks nothing either.
    const again = await setup({ json: false, domain: GW, yes: true }, { interactive: true, prompts, seams: claimAsLogin });
    expect(again.result).toMatchObject({ accessOn: null });
    expect(asked).toBe(0);
  });

  it("says why Access stayed off unattended, and names access on; a failure is a warning and setup still ends done", async () => {
    let asked = 0;
    const prompts: SetupDeps["prompts"] = {
      ...deps().prompts,
      accessInFront: async () => {
        asked += 1;
        return true;
      },
    };
    const skipped = () => events.filter((event) => event.type === "warning" && event.code === "ACCESS_SETUP_SKIPPED");

    // No Zero Trust team: its name is permanent, never picked for someone.
    const noTeam = await setup({ json: false, domain: GW, yes: true }, { interactive: true, prompts });
    expect(noTeam.result).toMatchObject({ gateway: "installed", ownerCreated: true, accessOn: false });
    expect(asked).toBe(0);
    expect(skipped()).toEqual([
      expect.objectContaining({
        step: "setup.access",
        message: expect.stringContaining("This Cloudflare account has no Zero Trust team yet, and a team's name is permanent"),
        data: { rerun: "pnpm everyapp access on --team example", rerunNote: expect.stringContaining("another name") },
      }),
    ]);
    expect(account.zeroTrust.applications.size).toBe(0);

    // A team, but the Cloudflare login (dev@example.com) isn't an owner or
    // admin of the Gateway (owner@example.com claimed it): Sign in with
    // Cloudflare would sign them in as someone the Gateway refuses.
    account.zeroTrust.organization = { name: "acme", auth_domain: "acme.cloudflareaccess.com", session_duration: "720h" };
    events.length = 0;
    const stranger = await setup({ domain: GW });
    expect(stranger.result).toMatchObject({ gateway: "up-to-date", accessOn: false });
    expect(skipped()).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("would sign you in as dev@example.com, which isn't an owner or admin of this Gateway"),
        data: { rerun: "pnpm everyapp access on", rerunNote: expect.stringContaining("dev@example.com is an owner or admin") },
      }),
    ]);
    expect(account.zeroTrust.applications.size).toBe(0);

    // A login that can't read Access: the same warning, with cf's reason.
    account.cf.override(["zero-trust", "organization", "get"], {
      exitCode: 1,
      stderr: "┌ APIError\n│ [10000] Authentication error\n└\n",
    });
    events.length = 0;
    const noPermission = await setup({ domain: GW });
    expect(noPermission.result).toMatchObject({ accessOn: false });
    expect(skipped()).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Cloudflare Access wasn't turned on\nThis Cloudflare login can't manage Access"),
        data: expect.objectContaining({ rerunNote: "with a login that can manage Access" }),
      }),
    ]);

    // Yes at a terminal, but Access refuses: a warning with the rerun, exit 0.
    events.length = 0;
    const failed = await setup({ json: false, domain: GW }, { interactive: true, prompts });
    expect(asked).toBe(1);
    expect(failed.exitCode).toBe(0);
    expect(failed.result).toMatchObject({ accessOn: false });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "ACCESS_SETUP_SKIPPED",
        step: "setup.access",
        message: expect.stringContaining("Cloudflare Access wasn't turned on\nThis Cloudflare login can't manage Access"),
        data: expect.objectContaining({ rerun: expect.stringContaining("access on") }),
      }),
    );
    expect(account.zeroTrust.applications.size).toBe(0);
  });

  it("ends the run when Ctrl-C answers the team name inside the Access offer, as at every other setup prompt", async () => {
    const prompts: SetupDeps["prompts"] = {
      browserDeploymentToken: async () => null,
      accessInFront: async () => true,
      pickZone: async () => {
        throw new Error("asked for a zone");
      },
      gatewayAddress: async () => {
        throw new Error("asked for an address");
      },
    };
    const { exitCode, result } = await setup(
      { json: false, domain: GW },
      {
        interactive: true,
        prompts,
        askTeam: async () => {
          throw new CancelledError();
        },
      },
    );
    expect(result).toBeUndefined();
    expect(exitCode).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "CANCELLED" }));
    expect(events.some((event) => event.type === "warning" && event.code === "ACCESS_SETUP_SKIPPED")).toBe(false);
    // The name comes before the first write: nothing at Access.
    expect(account.zeroTrust.organization).toBeNull();
  });

  it("brings both Access applications in line with the release on update, under the Access lease, and never fails the run for it", async () => {
    await setup({ domain: GW });
    const sink = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
    await turnAccessOn({
      flags: { json: true, gateway: `https://${GW}` },
      out: sink(),
      createCf: () => account.cf,
      team: "acme",
      interactive: false,
    });
    const zt = account.zeroTrust;
    type Destination = { uri: string; overrides: Array<{ path_pattern: string; behavior: string }> };
    const application = (uri: string) =>
      [...zt.applications.values()].find((app) => (app["destinations"] as Destination[]).some((d) => d.uri === uri))!;
    const overrides = (uri: string) =>
      (application(uri)["destinations"] as Destination[]).find((d) => d.uri === uri)!.overrides.map((o) => o.path_pattern);
    const writes = () =>
      account.cf.calls.filter((call) => call.args[0] === "zero-trust" && call.args.includes("update")).length;
    const accessSteps = () => events.filter((event) => event.type === "step" && event.step === "gateway.access");
    expect(overrides(GW)).toContain("/health");
    const providers = (application(GW)["allowed_idps"] as string[]).length;
    expect(providers).toBe(2);
    // Refusals a later part of the test switches on and off (an override can't be taken back).
    let refuse: { update?: string; list?: string } = {};
    const zeroTrust = (verb: string) => (args: string[]) =>
      args[0] === "zero-trust" && args[1] === "access" && args[2] === "applications" && args[3] === verb;
    account.cf.override((args) => zeroTrust("update")(args) && refuse.update !== undefined, () => ({
      exitCode: 1,
      stderr: refuse.update!,
    }));
    account.cf.override((args) => zeroTrust("list")(args) && refuse.list !== undefined, () => ({
      exitCode: 1,
      stderr: refuse.list!,
    }));

    // Drift by hand, as a dashboard edit or an older release would leave it:
    // the Gateway's application lost /health and its sign-in methods, the
    // apps' wildcard lets everything through.
    // (Read again each time: an update stores a new object in the fake.)
    const dropHealth = () => {
      const destination = (application(GW)["destinations"] as Destination[]).find((d) => d.uri === GW)!;
      destination.overrides = destination.overrides.filter((o) => o.path_pattern !== "/health");
    };
    const gateway = application(GW);
    dropHealth();
    gateway["allowed_idps"] = [];
    const wildcard = (application(`*.${GW}`)["destinations"] as Destination[]).find((d) => d.uri === `*.${GW}`)!;
    wildcard.overrides = [{ path_pattern: "/*", behavior: "public" }];
    events = [];
    account.cf.calls.length = 0;

    // update: the Gateway is up to date, and Access is brought back.
    const updated = await runGatewayDeploy({ json: true }, sink(), deps());
    expect(updated.gateway).toBe("up-to-date");
    expect(overrides(GW)).toContain("/health");
    expect(application(GW)["allowed_idps"]).toHaveLength(providers);
    expect(overrides(`*.${GW}`)).toEqual([]);
    expect(writes()).toBe(2);
    expect(accessSteps().at(-1)).toMatchObject({
      status: "ok",
      message: expect.stringContaining("brought in step"),
      data: { changed: expect.arrayContaining([gateway["id"]]), missing: [], combined: false },
    });
    expect(events.filter((event) => event.type === "warning")).toEqual([]);
    // The Gateway's settings weren't rewritten: the applications are the same ones.
    expect(account.workers.get("every-app-gateway")!.versions).toHaveLength(updated.gateway === "up-to-date" ? 2 : 3);

    // Again: nothing to do, nothing written.
    events = [];
    account.cf.calls.length = 0;
    await runGatewayDeploy({ json: true }, sink(), deps());
    expect(writes()).toBe(0);
    expect(accessSteps().at(-1)).toMatchObject({ status: "skip", message: "Cloudflare Access already matches this Gateway." });

    // Access refuses the update: a warning with the rerun, and the run ends done.
    dropHealth();
    refuse = { update: "\n┌ APIError\n│ [12060] access.api.error.invalid_request\n│ 400 Bad Request · HTTP /accounts/x/access/apps/y\n└\n" };
    events = [];
    const refused = await runGatewayDeploy({ json: true }, sink(), deps());
    expect(refused.gateway).toBe("up-to-date");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "ACCESS_RECONCILE_FAILED",
        step: "gateway.access",
        message: expect.stringContaining("Couldn't bring Cloudflare Access in step with this Gateway"),
        data: { rerun: expect.stringContaining("access on") },
      }),
    );
    expect(accessSteps()).toEqual([]);

    // A login that can't read Access (a CI token): nothing said, nothing touched.
    refuse = { list: "┌ APIError\n│ [10000] Authentication error\n└\n" };
    events = [];
    await runGatewayDeploy({ json: true }, sink(), deps());
    expect(events.filter((event) => event.type === "warning")).toEqual([]);
    expect(accessSteps()).toEqual([]);
    expect(overrides(GW)).not.toContain("/health");

    // Any other refusal to list: said once, as "if", with the rerun.
    refuse = { list: "┌ APIError\n│ [12060] access.api.error.invalid_request\n│ 400 Bad Request\n└\n" };
    events = [];
    await runGatewayDeploy({ json: true }, sink(), deps());
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "ACCESS_NOT_CHECKED",
        step: "gateway.access",
        message: expect.stringContaining("Couldn't check Cloudflare Access after the Gateway deploy"),
      }),
    );
    refuse = {};

    // Off (the applications gone): update touches nothing and says nothing.
    for (const id of [...zt.applications.keys()]) zt.applications.delete(id);
    events = [];
    account.cf.calls.length = 0;
    await runGatewayDeploy({ json: true }, sink(), deps());
    expect(writes()).toBe(0);
    expect(accessSteps()).toEqual([]);
    expect(events.filter((event) => event.type === "warning")).toEqual([]);
  });

  it("asks a person at a terminal about browser installs once the Gateway is up, unless --yes", async () => {
    let asked = 0;
    const prompts: SetupDeps["prompts"] = {
      browserDeploymentToken: async () => {
        asked += 1;
        return null;
      },
      accessInFront: async () => false,
      pickZone: async () => {
        throw new Error("asked for a zone");
      },
      gatewayAddress: async () => {
        throw new Error("asked for an address");
      },
    };

    // --yes answers everyapp's own question with a No, and nothing else changes.
    const first = await setup({ json: false, domain: GW, yes: true }, { interactive: true, prompts });
    expect(first.exitCode).toBe(0);
    expect(first.result).toMatchObject({ gateway: "installed", ownerCreated: true });
    expect(asked).toBe(0);
    expect(account.workers.get("every-app-gateway")!.secrets).not.toHaveProperty("CF_DEPLOY_TOKEN");

    // Without it, the question is asked (and declined here).
    const second = await setup({ json: false, domain: GW }, { interactive: true, prompts });
    expect(second.exitCode).toBe(0);
    expect(asked).toBe(1);
    expect(account.workers.get("every-app-gateway")!.secrets).not.toHaveProperty("CF_DEPLOY_TOKEN");
  });
});
