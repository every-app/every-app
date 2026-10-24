import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountsError,
  configDir,
  describeAccounts,
  findAccount,
  loadAccountsFile,
  loadProviders,
  parseAccountsFile,
  parseProvidersEnv,
  readRotateMarkers,
  refuseInheritedEnv,
  rotateRefusal,
  sha256,
} from "./accounts";

const ID = "0123456789abcdef0123456789abcdef";
const FORBIDDEN = "23bc28f0b638fbfc1c7f838573c17ee3";
const TOKEN = "fakeTokenValue_0123456789abcdefghij";

const valid = () =>
  JSON.stringify({
    accounts: [
      {
        name: "loop-1",
        accountId: ID.toUpperCase(),
        zone: "Everyapp-Loop1.com",
        email: "owner@everyapp-loop1.com",
        token: TOKEN,
      },
    ],
  });

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-accounts-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("accounts", () => {
  it("refuses to start when the driver's own environment carries what it derives for its children", () => {
    expect(() => refuseInheritedEnv({ PATH: "/bin" })).not.toThrow();
    for (const name of [
      "EVERYAPP_TEST_ACCOUNTS",
      "CLOUDFLARE_API_TOKEN",
      "EVERYAPP_GATEWAY_URL",
    ]) {
      expect(() => refuseInheritedEnv({ [name]: "x" })).toThrow(AccountsError);
      expect(() => refuseInheritedEnv({ [name]: "x" })).toThrow(name);
    }
  });

  it("parses accounts.json, lowercasing the id and the zone", () => {
    const file = parseAccountsFile(valid());
    expect(file.accounts[0]).toEqual({
      name: "loop-1",
      accountId: ID,
      zone: "everyapp-loop1.com",
      email: "owner@everyapp-loop1.com",
      token: TOKEN,
    });
  });

  it("refuses the forbidden account id whatever the file says", () => {
    const text = valid().replace(ID.toUpperCase(), FORBIDDEN);
    expect(() => parseAccountsFile(text)).toThrow(/forbidden/);
    try {
      parseAccountsFile(text);
    } catch (error) {
      expect((error as AccountsError).code).toBe("account_forbidden");
    }
  });

  it("refuses an id that is not 32 hex, a duplicate name, and non-JSON", () => {
    expect(() =>
      parseAccountsFile(valid().replace(ID.toUpperCase(), "not-an-id")),
    ).toThrow(/32 hex/);
    const twice = JSON.parse(valid()) as { accounts: unknown[] };
    twice.accounts.push(twice.accounts[0]);
    expect(() => parseAccountsFile(JSON.stringify(twice))).toThrow(/twice/);
    expect(() => parseAccountsFile("{")).toThrow(/not JSON/);
  });

  it("reads the file only when it is mode 600", () => {
    const dir = tempDir();
    const file = path.join(dir, "accounts.json");
    fs.writeFileSync(file, valid(), { mode: 0o644 });
    expect(() => loadAccountsFile(dir)).toThrow(/mode 600/);
    fs.chmodSync(file, 0o600);
    expect(loadAccountsFile(dir).accounts).toHaveLength(1);
    expect(() => loadAccountsFile(tempDir())).toThrow(/missing/);
  });

  it("finds an account by name and lists rows without the id or the token", () => {
    const file = parseAccountsFile(valid());
    expect(findAccount(file, "loop-1").accountId).toBe(ID);
    expect(() => findAccount(file, "loop-9")).toThrow(/No account "loop-9"/);
    const rows = describeAccounts(file);
    expect(rows).toEqual([
      {
        name: "loop-1",
        zone: "everyapp-loop1.com",
        email: "owner@everyapp-loop1.com",
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(ID);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("parses providers.env with comments, quotes and export, and only the four variables", () => {
    const providers = parseProvidersEnv(
      [
        "# keys",
        'ANTHROPIC_API_KEY="sk-ant-fake-0000000000"',
        "export OPENCODE_API_KEY=zen-fake-1111",
        "CURSOR_API_KEY=",
        "CODEX_API_KEY=REPLACE_ME",
        "",
      ].join("\n"),
    );
    // An empty value and the runbook's REPLACE_ME placeholder are both unset.
    expect(providers).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-fake-0000000000",
      OPENCODE_API_KEY: "zen-fake-1111",
    });
    expect(() => parseProvidersEnv("OPENAI_API_KEY=x")).toThrow(
      /not a provider variable/,
    );
    expect(() => parseProvidersEnv("garbage")).toThrow(/VAR=value/);
  });

  it("a missing providers.env is an empty set; a world-readable one is refused", () => {
    const dir = tempDir();
    expect(loadProviders(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, "providers.env"), "CODEX_API_KEY=fake\n", {
      mode: 0o640,
    });
    expect(() => loadProviders(dir)).toThrow(/mode 600/);
  });

  it("refuses a value whose hash an earlier run's rotate.json recorded", () => {
    const runs = tempDir();
    fs.mkdirSync(path.join(runs, "2026-10-25T10:00-claude-abc123"));
    fs.writeFileSync(
      path.join(runs, "2026-10-25T10:00-claude-abc123", "rotate.json"),
      JSON.stringify({ values: [{ name: "cf_token", sha256: sha256(TOKEN) }] }),
    );
    fs.mkdirSync(path.join(runs, "2026-10-25T11:00-codex-def456"));
    const markers = readRotateMarkers(runs);
    expect(markers).toEqual([
      {
        runId: "2026-10-25T10:00-claude-abc123",
        name: "cf_token",
        sha256: sha256(TOKEN),
      },
    ]);
    expect(rotateRefusal(markers, TOKEN)?.runId).toBe(
      "2026-10-25T10:00-claude-abc123",
    );
    expect(rotateRefusal(markers, "rolled-token-0000000000000")).toBeNull();
    expect(readRotateMarkers(path.join(runs, "nope"))).toEqual([]);
  });

  it("the config dir honours XDG_CONFIG_HOME", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "/home/me")).toBe(
      "/x/everyapp/onboarding-loop",
    );
    expect(configDir({}, "/home/me")).toBe(
      "/home/me/.config/everyapp/onboarding-loop",
    );
  });
});
