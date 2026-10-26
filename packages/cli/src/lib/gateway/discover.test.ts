/**
 * Finding the Gateway through the Cloudflare login: every account the login
 * sees is asked for the Gateway's database, each with its own cf pinned to
 * it, and the install row says where the Gateway serves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import type { FakeCfResponse } from "@/lib/cf/fakeCf";
import type { CfRunner } from "@/lib/cf/runner";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import { connectToGateway } from "./connect";
import { discoverGateway, refuseUnchecked, requireGateway } from "./discover";
import { writeInstall } from "./install";

/** A Cloudflare account, with or without a Gateway in it. */
interface TestAccount {
  id: string;
  name: string;
  cloudflare: FakeCloudflare;
}

let accounts: TestAccount[];
let asked: string[];

const AUTH_ERROR: FakeCfResponse = {
  exitCode: 1,
  stderr: "┌ APIError\n│ [10000] Authentication error\n└\n",
};

async function account(
  id: string,
  name: string,
  gatewayHost?: string,
): Promise<TestAccount> {
  const cloudflare = new FakeCloudflare();
  const entry = { id, name, cloudflare };
  if (gatewayHost) {
    const { uuid } = cloudflare.createDatabase("every-app-gateway");
    await writeInstall(cfD1Database(cloudflare.cf, uuid), {
      accountId: id,
      zoneId: "zone-1",
      zoneName: "example.com",
      gatewayHost,
      appBaseDomain: gatewayHost,
      oauthKvId: "kv",
      sourceTreeSha256: null,
      releaseOrigin: null,
      releaseGitSha: null,
      releaseVersion: "0.2.0",
      releaseSha256: "a".repeat(64),
      releaseOrder: { schema: 1, committedAt: 1 },
      liveVersionId: "every-app-gateway-version-1",
      liveDomains: [gatewayHost],
      liveAppWorkers: [],
      updatedAt: 0,
      updatedBy: null,
      jwtPublicKey: "-----BEGIN PUBLIC KEY-----",
      deploymentMode: "self_hosted",
    });
  }
  return entry;
}

const whoami = () => ({
  authenticated: true,
  email: "dev@example.com",
  accounts: accounts.map(({ id, name }) => ({ id, name })),
});

/** cf per account, as the runner pins CLOUDFLARE_ACCOUNT_ID; whoami without one. */
function createCf(accountId?: string): CfRunner {
  if (!accountId) {
    return accounts[0]!.cloudflare.cf.override(["auth", "whoami"], {
      stdout: JSON.stringify(whoami()),
    });
  }
  asked.push(accountId);
  const found = accounts.find((entry) => entry.id === accountId);
  if (!found) {
    // An account this login can't reach.
    return new FakeCloudflare().cf.override(["d1", "list"], AUTH_ERROR);
  }
  return found.cloudflare.cf;
}

const discover = (options: Partial<Parameters<typeof discoverGateway>[0]> = {}) =>
  discoverGateway({ whoami: whoami(), createCf, interactive: false, retryDelayMs: 0, ...options });

/** cf answers `failure` to the first `d1 list`, then as the fake account does. */
function failOnce(entry: TestAccount, failure: FakeCfResponse): void {
  let failed = false;
  entry.cloudflare.cf.override(
    (args) => args[0] === "d1" && args[1] === "list" && !failed,
    () => {
      failed = true;
      return failure;
    },
  );
}

beforeEach(() => {
  asked = [];
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  vi.stubEnv("EVERYAPP_GATEWAY_URL", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("discoverGateway", () => {
  it("finds the one Gateway among the login's accounts, asking each with its own account", async () => {
    accounts = await Promise.all([
      account("acct-1", "Personal"),
      account("acct-2", "Acme", "apps.acme.com"),
    ]);

    const { gateway, probed, found } = await discover();

    expect(gateway).toMatchObject({
      account: { id: "acct-2", name: "Acme" },
      install: { gatewayHost: "apps.acme.com" },
    });
    expect(found).toHaveLength(1);
    expect(probed.map((a) => a.id)).toEqual(["acct-1", "acct-2"]);
    expect(asked.sort()).toEqual(["acct-1", "acct-2"]);
    // Each account's database list went to that account's cf.
    for (const { cloudflare } of accounts) {
      expect(
        cloudflare.cf.calls.filter((call) => call.args.slice(0, 2).join(" ") === "d1 list"),
      ).toEqual([
        expect.objectContaining({
          args: ["d1", "list", "--name", "every-app-gateway", "--per-page", "100"],
        }),
      ]);
    }
  });

  it("needs a choice when several accounts have one: --account-id, CLOUDFLARE_ACCOUNT_ID, the host or a person", async () => {
    accounts = await Promise.all([
      account("acct-1", "Personal", "apps.me.dev"),
      account("acct-2", "Acme", "apps.acme.com"),
    ]);

    const unattended = await discover().catch((error: unknown) => error);
    expect(unattended).toMatchObject({
      name: "ActionRequiredError",
      action: "choose_account",
      message: expect.stringMatching(/^Choose which Gateway to use\n.* sees a Gateway in 2 Cloudflare accounts\. Run one of:$/),
      rerun: null,
      data: {
        choices: [
          expect.objectContaining({ accountId: "acct-1", gatewayUrl: "https://apps.me.dev" }),
          expect.objectContaining({
            accountId: "acct-2",
            label: "Acme · apps.acme.com",
            rerun: expect.stringContaining("--account-id acct-2"),
          }),
        ],
      },
    });
    // setup names a Gateway by its address.
    await expect(discover({ hostFlag: "--domain" })).rejects.toMatchObject({
      data: {
        choices: [
          expect.objectContaining({ label: "Personal", rerun: expect.stringMatching(/ --domain apps\.me\.dev$/) }),
          expect.objectContaining({ label: "Acme", rerun: expect.stringMatching(/ --domain apps\.acme\.com$/) }),
        ],
      },
    });

    await expect(discover({ accountId: "acct-1" })).resolves.toMatchObject({
      gateway: { account: { id: "acct-1" } },
    });
    await expect(discover({ host: "apps.acme.com" })).resolves.toMatchObject({
      gateway: { account: { id: "acct-2" } },
    });
    const pick = vi.fn(async (found: Array<{ account: { id: string } }>) => found[1]!);
    await expect(
      discover({ interactive: true, pick: pick as never }),
    ).resolves.toMatchObject({ gateway: { account: { id: "acct-2" } } });
    expect(pick).toHaveBeenCalledOnce();

    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-2");
    await expect(discover()).resolves.toMatchObject({
      gateway: { account: { id: "acct-2" } },
    });
  });


  it("builds each choice's rerun like a plain rerun: --json once when the run had it", async () => {
    accounts = await Promise.all([
      account("acct-1", "Personal", "apps.me.dev"),
      account("acct-2", "Acme", "apps.acme.com"),
    ]);
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "status", "--json"];
    try {
      await expect(discover()).rejects.toMatchObject({
        data: {
          choices: [
            expect.objectContaining({ rerun: "pnpm everyapp status --json --account-id acct-1" }),
            expect.objectContaining({ rerun: "pnpm everyapp status --json --account-id acct-2" }),
          ],
        },
      });
      // setup names a Gateway by its address: --domain is replaced, --json stays.
      process.argv = [...argv.slice(0, 2), "setup", "--domain", "apps.old.dev", "--json"];
      await expect(discover({ hostFlag: "--domain" })).rejects.toMatchObject({
        data: {
          choices: [
            expect.objectContaining({ rerun: "pnpm everyapp setup --json --domain apps.me.dev" }),
            expect.objectContaining({ rerun: "pnpm everyapp setup --json --domain apps.acme.com" }),
          ],
        },
      });
    } finally {
      process.argv = argv;
    }
  });

  it("asks an account a token can't read twice, then calls it unchecked, and goes on with the others", async () => {
    // A CI token scoped to acct-2: cf refuses acct-1's databases.
    accounts = await Promise.all([
      account("acct-1", "Personal"),
      account("acct-2", "Acme", "apps.acme.com"),
    ]);
    accounts[0]!.cloudflare.cf.override(["d1", "list"], AUTH_ERROR);

    const discovery = await discover();
    expect(discovery).toMatchObject({
      gateway: { account: { id: "acct-2" } },
      unchecked: [{ id: "acct-1", name: "Personal", reason: "auth" }],
    });
    expect(asked.filter((id) => id === "acct-1")).toHaveLength(1);
    expect(accounts[0]!.cloudflare.cf.calls.filter((call) => call.args[1] === "list")).toHaveLength(2);
  });

  it("asks once more after a refusal or a network failure, and finds the Gateway the second time", async () => {
    accounts = await Promise.all([account("acct-1", "Acme", "everyapp.team")]);
    failOnce(accounts[0]!, AUTH_ERROR);
    await expect(discover()).resolves.toMatchObject({ gateway: { account: { id: "acct-1" } }, unchecked: [] });

    accounts = await Promise.all([account("acct-1", "Acme", "everyapp.team")]);
    failOnce(accounts[0]!, { exitCode: 1, stderr: "┌ Error\n│ fetch failed: ECONNRESET\n└\n" });
    await expect(discover()).resolves.toMatchObject({ gateway: { account: { id: "acct-1" } } });
  });

  it("says it couldn't check, never that there is no Gateway, when the only account couldn't be asked", async () => {
    accounts = await Promise.all([account("acct-1", "Acme", "everyapp.team")]);
    accounts[0]!.cloudflare.cf.override(["d1", "list"], AUTH_ERROR);

    const discovery = await discover({ host: "everyapp.team" });
    expect(discovery.gateway).toBeNull();
    expect(() => requireGateway(discovery, whoami(), "everyapp.team")).toThrowError(
      expect.objectContaining({
        code: "GATEWAY_CHECK_FAILED",
        retryable: true,
        message: expect.stringMatching(
          /^Couldn't check Acme for a Gateway \(looking for everyapp\.team\)\nCloudflare refused to list its databases, twice\./,
        ),
        data: expect.objectContaining({ unchecked: [{ id: "acct-1", name: "Acme", reason: "auth" }], host: "everyapp.team" }),
      }),
    );
    expect(() => refuseUnchecked(discovery, whoami())).toThrowError(expect.objectContaining({ code: "GATEWAY_CHECK_FAILED" }));
  });

  it("asks an account a token names but cf doesn't list", async () => {
    accounts = await Promise.all([account("acct-2", "Acme", "apps.acme.com")]);
    const listed = accounts[0]!;
    // whoami lists no accounts for this token.
    const discovery = await discoverGateway({
      whoami: { authenticated: true, accounts: [] },
      createCf: () => listed.cloudflare.cf,
      accountId: "acct-2",
      interactive: false,
    });
    expect(discovery.gateway).toMatchObject({ account: { id: "acct-2", name: null } });
  });

  it("stops on any other failure, rather than call an account empty", async () => {
    accounts = await Promise.all([account("acct-1", "Acme", "apps.acme.com")]);
    accounts[0]!.cloudflare.cf.override(["d1", "list"], {
      exitCode: 1,
      stderr: "┌ Error\n│ fetch failed: ECONNRESET\n└\n",
    });

    await expect(discover()).rejects.toThrow("ECONNRESET");
  });

  it("finds nothing, and says which accounts it asked", async () => {
    accounts = await Promise.all([account("acct-1", "Personal"), account("acct-2", "Acme")]);

    const discovery = await discover();

    expect(discovery.gateway).toBeNull();
    expect(() => requireGateway(discovery, whoami())).toThrowError(
      expect.objectContaining({
        code: "GATEWAY_NOT_FOUND",
        message: expect.stringContaining("No Gateway in the 2 accounts this login sees\nPersonal, Acme."),
        rerun: "pnpm everyapp setup --domain <hostname>",
        data: { accounts: [{ id: "acct-1", name: "Personal" }, { id: "acct-2", name: "Acme" }] },
      }),
    );
  });

  it("refuses an --account-id that isn't the Gateway's, and says where it is", async () => {
    accounts = await Promise.all([
      account("acct-1", "Personal"),
      account("acct-2", "Acme", "apps.acme.com"),
    ]);

    const discovery = await discover({ accountId: "acct-1" });

    expect(discovery.gateway).toBeNull();
    expect(() => requireGateway(discovery, whoami())).toThrowError(
      expect.objectContaining({
        code: "GATEWAY_NOT_FOUND",
        message: expect.stringContaining(
          "Cloudflare account acct-1 has no Gateway\nThis login's Gateway is in Acme at https://apps.acme.com.",
        ),
      }),
    );
  });
});

describe("connectToGateway", () => {
  it("connects to the Gateway in the login's accounts", async () => {
    accounts = await Promise.all([account("acct-1", "Personal"), account("acct-2", "Acme", "apps.acme.com")]);

    await expect(connectToGateway({ createCf, interactive: false })).resolves.toMatchObject({
      accountId: "acct-2",
      accountName: "Acme",
      gatewayUrl: "https://apps.acme.com",
      deployer: { actor: "dev@example.com" },
    });
  });

  it("refuses a --gateway that isn't the Gateway it finds", async () => {
    accounts = await Promise.all([account("acct-2", "Acme", "apps.acme.com")]);

    await expect(
      connectToGateway({ gateway: "https://apps.other.dev", createCf, interactive: false }),
    ).rejects.toMatchObject({
      code: "GATEWAY_URL_MISMATCH",
      message: expect.stringContaining("The Gateway here is apps.acme.com, not apps.other.dev\n"),
    });
    await expect(
      connectToGateway({ gateway: "https://apps.acme.com", createCf, interactive: false }),
    ).resolves.toMatchObject({ accountId: "acct-2" });
  });

  it("fails with GATEWAY_NOT_FOUND when no account has one", async () => {
    accounts = await Promise.all([account("acct-1", "Personal")]);

    await expect(connectToGateway({ createCf, interactive: false })).rejects.toMatchObject({
      code: "GATEWAY_NOT_FOUND",
    });
  });

  it("never offers an install when the command names the Gateway or its account, or an account couldn't be asked", async () => {
    accounts = await Promise.all([account("acct-1", "Personal")]);
    const offered: string[] = [];
    const onNoGateway = async () => {
      offered.push("install");
      throw new Error("offered an install");
    };

    await expect(
      connectToGateway({ gateway: "https://everyapp.team", createCf, interactive: true, onNoGateway }),
    ).rejects.toMatchObject({
      code: "GATEWAY_NOT_FOUND",
      message: expect.stringContaining("No Gateway at everyapp.team in Personal"),
      data: expect.objectContaining({ host: "everyapp.team" }),
    });
    await expect(
      connectToGateway({ accountId: "acct-1", createCf, interactive: true, onNoGateway }),
    ).rejects.toMatchObject({ code: "GATEWAY_NOT_FOUND" });
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-1");
    await expect(connectToGateway({ createCf, interactive: true, onNoGateway })).rejects.toMatchObject({
      code: "GATEWAY_NOT_FOUND",
    });
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");

    accounts[0]!.cloudflare.cf.override(["d1", "list"], AUTH_ERROR);
    await expect(connectToGateway({ createCf, interactive: true, onNoGateway })).rejects.toMatchObject({
      code: "GATEWAY_CHECK_FAILED",
    });
    expect(offered).toEqual([]);

    // Nothing named, every account asked, none has one: the offer.
    accounts = await Promise.all([account("acct-1", "Personal")]);
    await expect(connectToGateway({ createCf, interactive: true, onNoGateway })).rejects.toThrow("offered an install");
  });

  it("refuses an install that stopped before its first upload", async () => {
    accounts = await Promise.all([account("acct-2", "Acme", "apps.acme.com")]);
    accounts[0]!.cloudflare
      .database("every-app-gateway")
      .sqlite.exec("UPDATE _everyapp_install SET live_version_id = NULL");

    await expect(connectToGateway({ createCf, interactive: false })).rejects.toMatchObject({
      code: "GATEWAY_NOT_INSTALLED",
      rerun: "pnpm everyapp setup",
    });
  });
});
