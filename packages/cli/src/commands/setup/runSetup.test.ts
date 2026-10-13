/**
 * `everyapp setup` end to end against a fake Cloudflare account: real
 * gateway migrations on SQLite, Build Outputs checked with cf's schema,
 * the gateway's deploy API over the same registry, and the person's part
 * (approving a login, opening the setup link) played by the test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deployApp } from "@/commands/app/deploy/deployApp";
import { starterTemplateDir } from "@/lib/app/starter";
import { readGatewayCredential } from "@/lib/gateway/credentials";
import { readInstall } from "@/lib/gateway/install";
import { listPendingClaims } from "@/lib/gateway/pendingClaims";
import { openRelease } from "@/lib/gateway/release";
import { mintSetupLink } from "@/lib/gateway/setup-link";
import { cfD1Database } from "@/lib/cf/d1";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { reportFailure } from "@/lib/output/report";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import { FakeGateway } from "@/test/fakeGateway";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { runSetup, type SetupDeps, type SetupFlags } from "./runSetup";

const GW = "apps.example.com";

let account: FakeCloudflare;
let gateway: FakeGateway;
let tarball: string;
let home: string;
let cwd: string;
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
  gateway = new FakeGateway(account, GW);
  tarball = await buildGatewayRelease();
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-setup-"));
  events = [];
  opened = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

/** The owner, opening the setup link the run hands out, while it waits. */
function ownerOpensTheLink(): () => Promise<void> {
  return async () => {
    const link = events.findLast(
      (event) => event.type === "action_required" && event.action === "claim_owner",
    );
    try {
      if (link) gateway.claim(link.data.url);
    } catch {
      // Claimed already.
    }
  };
}

function deps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    createCf: () => account.cf,
    gatewayClient: () => gateway.client,
    openRelease: () => openRelease(tarball),
    deployApp,
    templateDir: starterTemplateDir(),
    cwd,
    interactive: false,
    prompts: {
      confirm: async () => {
        throw new Error("asked a person");
      },
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
    hasPnpm: async () => true,
    cliVersion: "0.3.0",
    seams: {
      readStatus: () => account.gatewayStatus(),
      sleep: async () => undefined,
      verifyTimeoutMs: 0,
      leaseWaitMs: 0,
      lookupCaa: account.lookupCaa,
      certificates: { isReady: async () => true, sleep: async () => undefined },
      login: { sleep: ownerOpensTheLink(), timeoutMs: 60_000 },
      installDeps: async () => undefined,
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

/** A new setup link minted elsewhere (`gateway claim-link` on another machine). */
const mintElsewhere = () =>
  mintSetupLink({
    db: cfD1Database(account.cf, [...account.databases].find(([, d]) => d.name === "every-app-gateway")![0]),
    gatewayUrl: `https://${GW}`,
  });

describe("everyapp setup", () => {
  it("takes an empty account to a live gateway on a subdomain, its owner, a login and the starter app", async () => {
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
      "setup.login ok",
      "setup.extras skip",
      "setup.starter ok",
    ]);
    expect(result).toEqual({
      gatewayUrl: `https://${GW}`,
      organizationName: "Acme",
      apps: [{ appId: "simple-todo", url: `https://simple-todo.${GW}`, dir: path.join(cwd, "simple-todo") }],
    });

    // The gateway and the starter, each its own Custom Domain in the zone.
    expect(account.gatewayDomains()).toEqual([GW, `simple-todo.${GW}`]);
    expect(account.gatewayBindings()).toEqual(["every-acme-simple-todo"]);
    expect(gateway.app("simple-todo")).toMatchObject({ status: "active", hostname: `simple-todo.${GW}` });
    expect(account.dnsRecords).toHaveLength(1);
    await expect(
      readInstall(cfD1Database(account.cf, [...account.databases].find(([, d]) => d.name === "every-app-gateway")![0])),
    ).resolves.toMatchObject({ gatewayHost: GW, routing: "custom-domains", appBaseDomain: GW });

    // The owner link was handed out to the agent reading the events (never
    // opened by an unattended run, and never put in a CI log: see below),
    // and the CLI logged itself in with its own secret, once.
    const link = events.find((event) => event.action === "claim_owner");
    expect(link).toMatchObject({
      type: "action_required",
      data: { url: expect.stringMatching(new RegExp(`^https://${GW}/setup#token=est_`)), waiting: true },
    });
    expect(JSON.stringify(events)).not.toContain("ecs_");
    expect(opened).toEqual([]);
    // It says who claimed the link, so a person can tell it was them.
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.login",
        status: "ok",
        message: `Logged in to https://${GW} as owner@example.com (owner of Acme).`,
        data: { organizationId: "org-1", organizationName: "Acme", ownerEmail: "owner@example.com" },
      }),
    );
    await expect(readGatewayCredential(`https://${GW}`)).resolves.toMatchObject({
      token: "eak_from-the-setup-link",
      organizationId: "org-1",
    });
    await expect(listPendingClaims()).resolves.toEqual([]);

    // The starter's source, ready to work on.
    expect(fs.readFileSync(path.join(cwd, "simple-todo", "everyapp.config.ts"), "utf8")).toContain('id: "simple-todo"');
    expect(fs.existsSync(path.join(cwd, "simple-todo", "node_modules"))).toBe(false);
  });

  it("does nothing on a second run", async () => {
    await setup({ domain: GW });
    const deploys = account.deploys.length;
    events = [];

    const { exitCode } = await setup();

    expect(exitCode).toBe(0);
    expect(steps()).toEqual([
      "setup.toolchain ok",
      "setup.auth ok",
      "setup.account ok",
      "setup.domain ok",
      "setup.gateway skip",
      "setup.owner skip",
      "setup.login skip",
      "setup.extras skip",
      "setup.starter skip",
    ]);
    expect(account.deploys).toHaveLength(deploys);
    expect(events.some((event) => event.type === "action_required")).toBe(false);
  });

  it("tells a revoked token from a gateway it can't reach yet", async () => {
    await setup({ domain: GW, "no-starter": true });
    const { GatewayApiError } = await import("@/lib/gateway/api");
    const client = gateway.client as unknown as { whoami: () => Promise<unknown> };

    client.whoami = async () => {
      throw new GatewayApiError({ message: "revoked", status: 401 });
    };
    events = [];
    expect((await setup({ "no-starter": true })).exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({
      action: "create_deploy_token",
      data: { url: `https://${GW}/admin/tokens` },
    });

    client.whoami = async () => {
      throw new TypeError("fetch failed");
    };
    events = [];
    expect((await setup({ "no-starter": true })).exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "GATEWAY_UNREACHABLE",
      retryable: true,
    });
  });

  it("never puts the owner setup link into a CI log, unless asked to", async () => {
    vi.stubEnv("CI", "true");

    const { exitCode } = await setup({ domain: GW, "no-starter": true });

    expect(exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "action_required",
      action: "claim_owner",
      message: expect.stringContaining("--printSetupLink"),
    });
    expect(events.at(-1).data).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("#token=");
    // None minted, so a link someone already has keeps working.
    expect(account.database("every-app-gateway").all("SELECT id FROM owner_setup_tokens")).toEqual([]);

    // Asked for, it is printed like `gateway deploy --printSetupLink` does.
    events = [];
    const asked = await setup({ "no-starter": true, printSetupLink: true });
    expect(asked.exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "claim_owner",
        data: expect.objectContaining({ url: expect.stringMatching(new RegExp(`^https://${GW}/setup#token=est_`)) }),
      }),
    );
    expect(steps()).toContain("setup.login ok");
  });

  it("exits 1 when a step fails after the owner link it waited for", async () => {
    // The starter's hostname already has a record of the company's.
    account.dnsRecords.push({ zoneId: "zone-1", name: `simple-todo.${GW}`, type: "A", content: "192.0.2.1" });

    const { exitCode } = await setup({ domain: GW });

    expect(events).toContainEqual(
      expect.objectContaining({ action: "claim_owner", data: expect.objectContaining({ waiting: true }) }),
    );
    expect(steps()).toContain("setup.login ok");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "DNS_RECORD_CONFLICT" });
    expect(exitCode).toBe(1);
  });

  it("stops when nobody opens the setup link, and the next run shows the same link and finishes", async () => {
    const neverOpened = deps().seams!;
    const first = await setup(
      { domain: GW },
      { seams: { ...neverOpened, login: { sleep: async () => undefined, timeoutMs: 0 } } },
    );

    expect(first.exitCode).toBe(2);
    const links = () => events.filter((event) => event.action === "claim_owner");
    expect(links()).toHaveLength(2);
    expect(links()[1]).toMatchObject({
      message: expect.stringContaining("login --resume"),
    });
    const url = links()[0].data.url;
    expect(gateway.app("simple-todo")).toBeUndefined();

    // The link still works (unspent, unexpired): the next run shows it
    // again, and the owner opening it logs this CLI in.
    events = [];
    const second = await setup();
    expect(second.exitCode).toBe(0);
    expect(links()[0].data.url).toBe(url);
    expect(gateway.app("simple-todo")).toMatchObject({ status: "active" });
  });

  it("shows a new setup link when the one an earlier run showed stopped working since", async () => {
    const neverOpened = deps().seams!;
    await setup(
      { domain: GW, "no-starter": true },
      { seams: { ...neverOpened, login: { sleep: async () => undefined, timeoutMs: 0 } } },
    );
    const first = events.find((event) => event.action === "claim_owner").data.url;
    // Meanwhile someone mints a newer link elsewhere, which expires this one.
    await mintElsewhere();
    events = [];

    const { exitCode } = await setup({ "no-starter": true });

    // Not the dead link again: a fresh one, opened, and the CLI logged in.
    const shown = events.find((event) => event.action === "claim_owner");
    expect(shown.data.url).not.toBe(first);
    expect(shown.message).toContain("stopped working before anyone used it");
    expect(exitCode).toBe(0);
    expect(steps()).toContain("setup.login ok");
  });

  it("stops with a new link to get, not a token to create, when the link it waits on is replaced", async () => {
    let replaced = false;
    const { exitCode } = await setup(
      { domain: GW, "no-starter": true },
      {
        seams: {
          ...deps().seams!,
          login: {
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
    expect(events.at(-1).message).not.toContain("Admin → Tokens");
    // Whoever has the newer link can still use it.
    expect(account.database("every-app-gateway").all("SELECT id FROM owner_setup_tokens WHERE expires_at > ?", Date.now())).toHaveLength(1);
    await expect(listPendingClaims()).resolves.toEqual([]);
  });

  it("says to create a deploy token once the owner claimed the link more than 30 minutes ago", async () => {
    const neverOpened = deps().seams!;
    await setup(
      { domain: GW, "no-starter": true },
      { seams: { ...neverOpened, login: { sleep: async () => undefined, timeoutMs: 0 } } },
    );
    // The owner opens the link after this run gave up; setup runs again 31
    // minutes later, past the gateway's window for handing over the token.
    gateway.claim(events.find((event) => event.action === "claim_owner").data.url);
    gateway.now = () => Date.now() + 31 * 60_000;
    events = [];

    const { exitCode } = await setup({ "no-starter": true });

    expect(exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "SETUP_LOGIN_EXPIRED",
      message: expect.stringContaining("Admin → Tokens"),
    });
    await expect(readGatewayCredential(`https://${GW}`)).resolves.toBeNull();
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

    const { exitCode } = await setup({ domain: GW, "no-starter": true });

    expect(exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "action_required",
        action: "cloudflare_login",
        data: { url: "https://dash.cloudflare.com/oauth2/device", code: "ABCD-EFGH", waiting: true },
      }),
    );
    expect(steps()).toContain("setup.starter skip");
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

  it("warns about Workers Paid it can't confirm, and asks a person whether to go on", async () => {
    const { exitCode } = await setup({ domain: GW, "no-starter": true });
    expect(exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "WORKERS_PAID_UNVERIFIED" }),
    );

    events = [];
    const declined = await setup(
      { "no-starter": true },
      {
        interactive: true,
        prompts: {
          ...deps().prompts,
          confirm: async () => false,
        },
      },
    );
    expect(declined.exitCode).toBe(2);
    expect(events.at(-1)).toMatchObject({ action: "upgrade_workers_paid" });
  });

  it("asks a person at a terminal where the gateway goes, and opens the setup link", async () => {
    account.zones.push({ id: "zone-2", name: "other.dev", status: "active" });
    const asked: string[] = [];

    const { exitCode } = await setup(
      { json: false, "no-starter": true, "allow-free-plan": true },
      {
        interactive: true,
        prompts: {
          confirm: async (message) => {
            asked.push(message);
            return true;
          },
          pickZone: async (zones) => {
            asked.push(zones.join(","));
            return "example.com";
          },
          hostname: async (zone) => `tools.${zone}`,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(asked).toEqual([
      "example.com,other.dev",
      `Install the Every App gateway at https://tools.example.com in Acme?`,
    ]);
    expect(opened).toEqual([expect.stringMatching(/^https:\/\/tools\.example\.com\/setup#token=est_/)]);
    expect(account.gatewayDomains()).toEqual(["tools.example.com"]);
  });

  it("keeps an install from before per-app domains on its wildcard route", async () => {
    // Deployed by this CLI before per-app domains, at the zone apex.
    gateway = new FakeGateway(account, "example.com");
    await setup({ domain: "example.com", "no-starter": true });
    const db = cfD1Database(account.cf, [...account.databases].find(([, d]) => d.name === "every-app-gateway")![0]);
    const install = (await readInstall(db))!;
    const { writeInstall } = await import("@/lib/gateway/install");
    await writeInstall(db, { ...install, routing: "wildcard-route", releaseSha256: "0".repeat(64), releaseVersion: "0.1.0", releaseOrder: null });
    events = [];

    const { exitCode } = await setup();

    expect(exitCode).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ step: "setup.domain", data: expect.objectContaining({ routing: "wildcard-route" }) }),
    );
    const last = account.deploys.at(-1)!;
    expect(last.config["triggers"]).toEqual([
      { type: "scheduled", schedule: "17 * * * *" },
      { type: "fetch", pattern: "*.example.com/*", zone: "zone-1" },
    ]);
    expect(last.config["env"].APP_BASE_DOMAIN).toBeUndefined();
    // Its starter keeps the old naming: <app>-<org>.<host>.
    expect(gateway.app("simple-todo")).toMatchObject({ hostname: "simple-todo-acme.example.com", status: "active" });
  });
});
