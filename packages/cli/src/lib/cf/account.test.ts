import { afterEach, describe, expect, it, vi } from "vitest";
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
    });
    expect(cf.calls).toHaveLength(1);
  });

  it("blames a token cf can't use", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "bad");
    const cf = new FakeCf().on(["auth", "whoami"], { stdout: LOGGED_OUT });
    await expect(ensureCfAuth({ cf, interactive: true })).rejects.toMatchObject({
      code: "CLOUDFLARE_TOKEN_REJECTED",
    });
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
      code: "ACCOUNT_REQUIRED",
      message: expect.stringContaining("acct-2 (Globex)"),
    });
  });

  it("refuses an account the login can't use", async () => {
    await expect(
      resolveAccount({ whoami: whoami(), flag: "acct-9", interactive: false }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACCESSIBLE" });
  });
});
