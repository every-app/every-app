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
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { mintSetupLink } from "@/lib/gateway/setup-link";
import { gatewayReleaseSource } from "@/lib/gateway/source";
import { cfD1Database } from "@/lib/cf/d1";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { reportFailure } from "@/lib/output/report";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { fakeGithubReleases } from "@/test/fakeGithub";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { runSetup, setupDeps, type SetupDeps, type SetupFlags } from "./runSetup";

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
      pickZone: async () => {
        throw new Error("asked a person");
      },
      hostname: async () => {
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
    expect(result).toEqual({
      gatewayUrl: `https://${GW}`,
      organizationName: "Owner",
      release: "0.2.0",
      gateway: "installed",
      ownerCreated: true,
    });

    // The gateway, its own Custom Domain in the zone; no app yet.
    expect(account.gatewayDomains()).toEqual([GW]);
    expect(account.gatewayBindings()).toEqual([]);
    expect(account.dnsRecords).toHaveLength(1);
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
        message: "Owner created: owner@example.com (Owner).",
        data: { email: "owner@example.com", organizationName: "Owner" },
      }),
    );
    // Nothing is kept on this machine: the next run finds the Gateway
    // through the Cloudflare login.
    expect(fs.readdirSync(`${home}/.everyapp`)).toEqual(["cf"]);
  });

  it("installs a self-hosted Gateway by default, and a hosted one with --mode hosted", async () => {
    expect((await setup({ domain: GW })).exitCode).toBe(0);
    expect(account.deploys[0]!.secrets).toMatchObject({ GATEWAY_DEPLOYMENT_MODE: "self_hosted" });
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({ deploymentMode: "self_hosted" });

    const hosted = new FakeCloudflare();
    account = hosted;
    worker = new GatewayWorker(hosted);
    events = [];
    expect((await setup({ domain: GW, mode: "hosted" })).exitCode).toBe(0);
    const [first] = hosted.deploys;
    expect(first!.workerName).toBe("every-app-gateway");
    expect(first!.secrets).toMatchObject({
      GATEWAY_DEPLOYMENT_MODE: "hosted",
      GATEWAY_URL: `https://${GW}`,
    });
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({ deploymentMode: "hosted" });
    // Its owner claims it like any other: the install organization is the
    // platform organization.
    expect(events).toContainEqual(expect.objectContaining({ step: "setup.owner", status: "ok" }));

    // Run again with the mode it has: nothing to do, and no secrets sent.
    events = [];
    expect((await setup({ mode: "hosted" })).exitCode).toBe(0);
    expect(hosted.deploys).toHaveLength(1);
  });

  it("refuses to change the mode of a live Gateway", async () => {
    await setup({ domain: GW, mode: "hosted" });
    events = [];

    const { exitCode } = await setup({ mode: "self_hosted" });

    expect(exitCode).not.toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", code: "MODE_CHANGE_UNSUPPORTED" }),
    );
    expect(account.deploys).toHaveLength(1);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({ deploymentMode: "hosted" });
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
        data: expect.objectContaining({ gatewayUrl: `https://${GW}`, from: null }),
      }),
    );
    expect(account.gatewayDomains()).toEqual([GW]);
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
      message: expect.stringContaining("Run git pull, then: pnpm everyapp"),
      data: {
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

    it("installs the latest release of every-app/every-app, and says where it came from", async () => {
      const github = fakeGithubReleases({
        "every-app/every-app": [{ tag: "gateway-v0.2.0", assets: { [RELEASE_TARBALL]: tarball } }],
      });
      const source = gatewayReleaseSource({ out: sink(), checkoutRoot: () => null, fetch: github.fetch });

      const { result, exitCode } = await setup({ domain: GW }, fromSource(source));

      expect(exitCode).toBe(0);
      expect(result).toMatchObject({ gateway: "installed", release: "0.2.0" });
      expect(events).toContainEqual(
        expect.objectContaining({
          step: "gateway.release",
          message: "Using Gateway 0.2.0 from every-app/every-app release gateway-v0.2.0.",
        }),
      );
      // No checkout: no tree hash, ordered by the release's release.json.
      await expect(readInstall(gatewayD1())).resolves.toMatchObject({
        sourceTreeSha256: null,
        releaseOrder: { committedAt: Date.parse("2026-10-12T00:00:00.000Z") },
      });

      // Run again, the same release is up to date, by its SHA-256.
      events = [];
      const again = await setup({}, fromSource(
        gatewayReleaseSource({ out: sink(), checkoutRoot: () => null, fetch: github.fetch }),
      ));
      expect(again.exitCode).toBe(0);
      expect(again.result).toMatchObject({ gateway: "up-to-date" });
    });

    it("installs --release <file>", async () => {
      const deps = setupDeps({ out: sink(), json: true, release: tarball });

      const { result, exitCode } = await setup(
        { domain: GW, release: tarball },
        { openRelease: deps.openRelease, source: deps.source },
      );

      expect(exitCode).toBe(0);
      expect(result).toMatchObject({ gateway: "installed", release: "0.2.0" });
      expect(events).toContainEqual(
        expect.objectContaining({ step: "gateway.release", message: `Using Gateway 0.2.0 from ${tarball}.` }),
      );
      expect(account.deploys).toHaveLength(1);
    });

    it("refuses a release that needs a newer everyapp, before anything is deployed", async () => {
      const needsNewer = await buildGatewayRelease({ version: "0.4.0", minCli: "0.4.0" });
      const source = gatewayReleaseSource({ out: sink(), release: needsNewer, checkoutRoot: () => null });

      const { exitCode } = await setup({ domain: GW, release: needsNewer }, fromSource(source));

      expect(exitCode).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "CLI_TOO_OLD",
        message: expect.stringContaining(
          "Gateway release 0.4.0 needs everyapp 0.4.0 or newer; this is 0.3.0. Update everyapp",
        ),
      });
      expect(account.deploys).toHaveLength(0);
    });

    it("refuses a release older than the live Gateway, by its release.json", async () => {
      const newer = await buildGatewayRelease({ builtAt: "2026-10-13T00:00:00.000Z" });
      await setup(
        { domain: GW, release: newer },
        fromSource(gatewayReleaseSource({ out: sink(), release: newer, checkoutRoot: () => null })),
      );
      const deploys = account.deploys.length;
      events = [];

      const { exitCode } = await setup(
        { release: tarball },
        fromSource(gatewayReleaseSource({ out: sink(), release: tarball, checkoutRoot: () => null })),
      );

      expect(exitCode).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "DOWNGRADE_REFUSED",
        message: expect.stringContaining(
          `The Gateway from ${tarball} (0.2.0 of 2026-10-12) is older than the one live at https://${GW} (0.2.0 of 2026-10-13). Pass --release a newer one, or run everyapp from a checkout at least as new`,
        ),
        data: { rerun: expect.stringContaining("--allow-downgrade"), authorize: true },
      });
      expect(account.deploys).toHaveLength(deploys);
    });
  });

  it("never puts the owner setup link into a CI log", async () => {
    vi.stubEnv("CI", "true");

    const { exitCode } = await setup({ domain: GW });

    expect(exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "action_required",
      action: "claim_owner",
      message: expect.stringContaining("Run `pnpm everyapp setup` at a terminal"),
    });
    expect(events.at(-1).message).toContain("apps deploy without one");
    // No link: only the command to run at a terminal.
    expect(events.at(-1).data).toEqual({ rerun: "pnpm everyapp setup" });
    expect(JSON.stringify(events)).not.toContain("#token=");
    // None minted, so a link someone already has keeps working.
    expect(account.database("every-app-gateway").all("SELECT id FROM owner_setup_tokens")).toEqual([]);
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
        message: expect.stringContaining("certificate may still be on its way"),
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
    expect(warning.message).toContain("DNS has no address for it yet");
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
      message: expect.stringContaining("open it, then run `pnpm everyapp setup` again"),
      data: { url: links()[0].data.url },
    });
    const url = links()[0].data.url;

    // A resumed setup mints a new link, and says the earlier one no longer
    // works; the owner opening the new one finishes it.
    events = [];
    const second = await setup();
    expect(second.exitCode).toBe(0);
    expect(links()[0].data.url).not.toBe(url);
    expect(links()[0].message).toContain("The setup link shown before no longer works");
    expect(() => worker.claim(url)).toThrow("INVALID_OR_EXPIRED_SETUP_LINK");
    expect(steps()).toContain("setup.owner ok");
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
        data: { url: "https://dash.cloudflare.com/oauth2/device", code: "ABCD-EFGH", waiting: true, waitingFor: "Cloudflare login" },
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
      message: expect.stringContaining("Domains → Buy a domain"),
      data: { url: `https://dash.cloudflare.com/${account.accountId}/domains/overview` },
    });
    expect(account.deploys).toEqual([]);
    expect(account.databases.size).toBe(0);
  });

  it("names the zones to choose from when unattended without --domain", async () => {
    const { exitCode } = await setup();

    expect(exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "DOMAIN_REQUIRED",
      message: expect.stringContaining("--domain apps.example.com"),
    });
  });

  it("warns about Workers Paid it can't confirm, never asks, and stops when Cloudflare refuses for the plan", async () => {
    account.failNextDeploy = "Your account must be on the Workers Paid plan to use this feature.";

    const refused = await setup({ domain: GW });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "WORKERS_PAID_UNVERIFIED" }),
    );
    expect(refused.exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "action_required",
      action: "upgrade_workers_paid",
      data: { url: `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/plans` },
    });

    // Subscribed: at a terminal, the same command goes on without a question
    // (the deps' prompts throw if asked).
    events = [];
    const { exitCode } = await setup({ domain: GW }, { interactive: true });
    expect(exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "WORKERS_PAID_UNVERIFIED" }),
    );
  });

  it("asks a person at a terminal where the gateway goes, and opens the setup link", async () => {
    account.zones.push({ id: "zone-2", name: "other.dev", status: "active" });
    const asked: string[] = [];

    const { exitCode } = await setup(
      { json: false },
      {
        interactive: true,
        prompts: {
          pickZone: async (zones) => {
            asked.push(zones.join(","));
            return "example.com";
          },
          hostname: async (zone) => `tools.${zone}`,
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
});
