import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI } from "@/lib/output/command";
import { ensureCfAuth, resolveAccount } from "./account";
import { FakeCf } from "./fakeCf";

const LOGGED_OUT = JSON.stringify({ authenticated: false, error: "Not logged in" });
const ACCOUNTS = [
  { id: "acct-1", name: "Acme" },
  { id: "acct-2", name: "Globex" },
];
const loggedIn = (accounts = ACCOUNTS) =>
  JSON.stringify({ authenticated: true, email: "dev@example.com", accounts });

afterEach(() => vi.unstubAllEnvs());

describe("ensureCfAuth", () => {
  it("passes when cf is logged in", async () => {
    const cf = new FakeCf().on(["auth", "whoami"], { stdout: loggedIn() });
    await expect(ensureCfAuth({ cf, interactive: false })).resolves.toMatchObject({
      email: "dev@example.com",
    });
  });

  it("takes a person at a terminal through cf auth login", async () => {
    let calls = 0;
    const cf = new FakeCf().on(["auth", "whoami"], () => ({
      stdout: (calls += 1) === 1 ? LOGGED_OUT : loggedIn(),
    }));

    await ensureCfAuth({ cf, interactive: true });

    expect(cf.calls.map((call) => [call.args.join(" "), call.mode])).toEqual([
      ["auth whoami", "json"],
      ["auth login", "interactive"],
      ["auth whoami", "json"],
    ]);
  });

  it("hands an agent cf's device link and code, and waits for the approval", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    let approved = false;
    const cf = new FakeCf()
      .on(["auth", "whoami"], () => ({ stdout: approved ? loggedIn() : LOGGED_OUT }))
      .on(["auth", "login"], () => {
        approved = true;
        return {
          stdout: [
            "To authorize Cloudflare CLI, please visit:",
            "",
            "  https://dash.cloudflare.com/oauth2/device",
            "",
            "and enter the code:",
            "",
            "  WXYZ-1234",
            "",
            "You have 15 minutes to approve this request.",
          ].join("\n"),
        };
      });
    const logins: unknown[] = [];

    await expect(
      ensureCfAuth({ cf, interactive: false, onDeviceLogin: (login) => logins.push(login) }),
    ).resolves.toMatchObject({ authenticated: true });

    expect(logins).toEqual([
      { url: "https://dash.cloudflare.com/oauth2/device", code: "WXYZ-1234" },
    ]);
    expect(cf.calls.map((call) => [call.args.join(" "), call.mode])).toEqual([
      ["auth whoami", "json"],
      ["auth login --no-browser", "text"],
      ["auth whoami", "json"],
    ]);
  });

  it("asks anyone else to log in, without starting a login", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const cf = new FakeCf().on(["auth", "whoami"], { stdout: LOGGED_OUT });
    await expect(ensureCfAuth({ cf, interactive: false })).rejects.toMatchObject({
      action: "cloudflare_login",
      message: `Log in to Cloudflare with ${CLI} login\nUnattended? Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID instead.`,
    });
    expect(cf.calls).toHaveLength(1);
  });

  it("points a login that didn't take at everyapp login", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const cf = new FakeCf().on(["auth", "whoami"], { stdout: LOGGED_OUT });
    await expect(ensureCfAuth({ cf, interactive: true })).rejects.toMatchObject({
      code: "CLOUDFLARE_LOGIN_FAILED",
      message: "Cloudflare login didn't complete",
      rerun: `${CLI} login`,
    });
  });

  it("blames a token cf can't use", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "bad");
    const cf = new FakeCf().on(["auth", "whoami"], { stdout: LOGGED_OUT });
    await expect(ensureCfAuth({ cf, interactive: true })).rejects.toMatchObject({
      code: "CLOUDFLARE_TOKEN_REJECTED",
      message: expect.stringMatching(/^Cloudflare didn't accept CLOUDFLARE_API_TOKEN\n/),
      fix: `set a valid token, or unset CLOUDFLARE_API_TOKEN and run ${CLI} login`,
    });
    // Never a login over the token.
    expect(cf.calls).toHaveLength(1);
  });
});

describe("resolveAccount", () => {
  const whoami = (accounts = ACCOUNTS) => ({
    authenticated: true,
    email: "dev@example.com",
    accounts,
  });

  it("prefers the flag, then CLOUDFLARE_ACCOUNT_ID", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-2");
    await expect(
      resolveAccount({ whoami: whoami(), flag: "acct-1", interactive: false }),
    ).resolves.toEqual({ id: "acct-1", name: "Acme" });
    await expect(
      resolveAccount({ whoami: whoami(), interactive: false }),
    ).resolves.toEqual({ id: "acct-2", name: "Globex" });
  });

  it("uses the only account, and makes an unattended run choose among several", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    await expect(
      resolveAccount({ whoami: whoami([ACCOUNTS[0]!]), interactive: false }),
    ).resolves.toEqual({ id: "acct-1", name: "Acme" });
    await expect(
      resolveAccount({ whoami: whoami(), interactive: false }),
    ).rejects.toMatchObject({
      action: "choose_account",
      message: "Choose the Cloudflare account to install in\ndev@example.com can use 2 accounts. Run one of:",
      rerun: null,
      data: {
        choices: [
          expect.objectContaining({ label: "Acme", rerun: expect.stringMatching(/--account-id acct-1$/) }),
          expect.objectContaining({ label: "Globex", rerun: expect.stringMatching(/--account-id acct-2$/) }),
        ],
      },
    });
  });

  it("refuses an account the login can't use", async () => {
    await expect(
      resolveAccount({ whoami: whoami(), flag: "acct-9", interactive: false }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_NOT_ACCESSIBLE",
      message: [
        "dev@example.com can't use Cloudflare account acct-9",
        "Accounts this login can use:",
        "  Acme    acct-1",
        "  Globex  acct-2",
      ].join("\n"),
      rerun: `${CLI} login`,
    });
  });
});
