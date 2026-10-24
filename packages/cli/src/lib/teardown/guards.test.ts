/**
 * The teardown's allowlist parser and the order of its guards, with no
 * Cloudflare: a forbidden id is refused before the allowlist is read, an
 * unlisted one before the token is looked at, and the token's scope last.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNdjsonSink } from "@/lib/output/events";
import { makeTestHome } from "@/test/home";
import {
  allowlistPath,
  checkAccountEligible,
  checkTokenScope,
  FORBIDDEN_ACCOUNTS,
  parseAllowlist,
  readAllowlist,
} from "./guards";

const TEST = "0123456789abcdef0123456789abcd01";
const OTHER = "fedcba9876543210fedcba9876543210";
const FORBIDDEN = FORBIDDEN_ACCOUNTS[0]!;

let home: string;
let events: Array<Record<string, any>>;
const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));

beforeEach(() => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeAllowlistFile(content: string, file = allowlistPath({})): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("the teardown allowlist", () => {
  it("takes ids separated by commas, whitespace or lines, skips comments and blanks, and ignores what isn't an id", () => {
    expect(parseAllowlist(`${TEST},${OTHER}`)).toEqual({ ids: [TEST, OTHER], ignored: [] });
    expect(parseAllowlist(`${TEST} ${OTHER}\n`)).toEqual({ ids: [TEST, OTHER], ignored: [] });
    expect(
      parseAllowlist(
        [
          "# the loop's accounts",
          "",
          `${TEST}   # loop-1`,
          TEST.toUpperCase(),
          "not-an-id",
          `${OTHER}`,
        ].join("\n"),
      ),
    ).toEqual({ ids: [TEST, OTHER], ignored: ["not-an-id"] });
  });

  it("is the variable and the file together, the file under $XDG_CONFIG_HOME when set", () => {
    writeAllowlistFile(`${OTHER}\n`);
    expect(readAllowlist({ EVERYAPP_TEST_ACCOUNTS: TEST })).toMatchObject({
      ids: [TEST, OTHER],
      file: path.join(home, ".config", "everyapp", "test-accounts"),
    });
    expect(readAllowlist({})).toMatchObject({ ids: [OTHER] });

    const xdg = path.join(home, "xdg");
    writeAllowlistFile(`${TEST}\nbogus\n`, path.join(xdg, "everyapp", "test-accounts"));
    expect(readAllowlist({ XDG_CONFIG_HOME: xdg })).toEqual({
      ids: [TEST],
      ignored: ["bogus"],
      file: path.join(xdg, "everyapp", "test-accounts"),
    });
  });
});

describe("the guards, in order", () => {
  it("refuses an id that isn't one, before the allowlist could ever be asked to hold it", () => {
    expect(() =>
      checkAccountEligible({ accountId: " loop-1 ", out: out(), env: { EVERYAPP_TEST_ACCOUNTS: "loop-1" } }),
    ).toThrow(
      expect.objectContaining({
        code: "TEARDOWN_INVALID_ACCOUNT_ID",
        message: expect.stringContaining('"loop-1" isn\'t a Cloudflare account id'),
        fix: expect.stringContaining("dashboard"),
      }),
    );
    // Not the allowlist's problem: no warning about its entry either.
    expect(events).toEqual([]);
  });

  it("refuses the forbidden account before reading any allowlist, even one that lists it", () => {
    writeAllowlistFile(`${FORBIDDEN}\n`);
    expect(() =>
      checkAccountEligible({
        accountId: FORBIDDEN,
        out: out(),
        env: { EVERYAPP_TEST_ACCOUNTS: FORBIDDEN, CLOUDFLARE_API_TOKEN: "token" },
      }),
    ).toThrow(expect.objectContaining({ code: "TEARDOWN_ACCOUNT_FORBIDDEN" }));
    // Nothing of the allowlist was looked at: no warning about it either.
    expect(events).toEqual([]);
  });

  it("refuses an account off the allowlist, saying how to add it, before the token is looked at", () => {
    expect(() =>
      checkAccountEligible({ accountId: TEST, out: out(), env: { EVERYAPP_TEST_ACCOUNTS: OTHER } }),
    ).toThrow(
      expect.objectContaining({
        code: "TEARDOWN_NOT_ALLOWLISTED",
        fix: expect.stringContaining(`EVERYAPP_TEST_ACCOUNTS=${TEST}`),
      }),
    );
    // The fix names the file too.
    try {
      checkAccountEligible({ accountId: TEST, out: out(), env: {} });
    } catch (error) {
      expect((error as { fix: string }).fix).toContain(path.join("everyapp", "test-accounts"));
    }
  });

  it("warns about allowlist entries that aren't ids, and then refuses without a token", () => {
    writeAllowlistFile(`${TEST}\nloop-1\n`);
    expect(() => checkAccountEligible({ accountId: TEST.toUpperCase(), out: out(), env: {} })).toThrow(
      expect.objectContaining({ code: "TEARDOWN_NEEDS_TOKEN" }),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "warning", code: "TEARDOWN_ALLOWLIST_IGNORED", data: expect.objectContaining({ ignored: ["loop-1"] }) }),
    ]);
  });

  it("passes an allowlisted account with a token, lowercased", () => {
    expect(
      checkAccountEligible({
        accountId: ` ${TEST.toUpperCase()} `,
        out: out(),
        env: { EVERYAPP_TEST_ACCOUNTS: `${TEST}, ${OTHER}`, CLOUDFLARE_API_TOKEN: "token" },
      }),
    ).toEqual({ accountId: TEST, allowlist: [TEST, OTHER] });
  });

  it("refuses a token that sees an account outside the allowlist, or the forbidden one, and one that doesn't see the target", () => {
    const whoami = (ids: string[]) => ({
      authenticated: true,
      email: null,
      accounts: ids.map((id) => ({ id, name: `Account ${id.slice(0, 4)}` })),
    });
    expect(() => checkTokenScope({ accountId: TEST, allowlist: [TEST], whoami: whoami([TEST, OTHER]) })).toThrow(
      expect.objectContaining({ code: "TEARDOWN_TOKEN_TOO_BROAD", data: { accountId: TEST, accounts: [{ id: OTHER, name: `Account ${OTHER.slice(0, 4)}` }] } }),
    );
    expect(() =>
      checkTokenScope({ accountId: TEST, allowlist: [TEST, FORBIDDEN], whoami: whoami([TEST, FORBIDDEN]) }),
    ).toThrow(expect.objectContaining({ code: "TEARDOWN_TOKEN_TOO_BROAD" }));
    expect(() => checkTokenScope({ accountId: TEST, allowlist: [TEST, OTHER], whoami: whoami([OTHER]) })).toThrow(
      expect.objectContaining({ code: "TEARDOWN_ACCOUNT_NOT_VISIBLE" }),
    );
    expect(() => checkTokenScope({ accountId: TEST, allowlist: [TEST], whoami: whoami([]) })).toThrow(
      expect.objectContaining({ code: "TEARDOWN_ACCOUNT_NOT_VISIBLE" }),
    );
    expect(() =>
      checkTokenScope({ accountId: TEST, allowlist: [TEST], whoami: { authenticated: false, accounts: [] } }),
    ).toThrow(expect.objectContaining({ code: "CLOUDFLARE_TOKEN_REJECTED" }));
    // A bogus env token, as cf 1.0.0-beta.14 reports it: authenticated, tokenValid false, no accounts.
    expect(() =>
      checkTokenScope({
        accountId: TEST,
        allowlist: [TEST],
        whoami: { authenticated: true, authSource: "CLOUDFLARE_API_TOKEN environment variable", tokenValid: false, accounts: [] },
      }),
    ).toThrow(expect.objectContaining({ code: "CLOUDFLARE_TOKEN_REJECTED" }));
    // cf authenticated with a person's login, not the environment token.
    expect(() =>
      checkTokenScope({
        accountId: TEST,
        allowlist: [TEST],
        whoami: { ...whoami([TEST]), authSource: "OAuth token from /Users/me/Library/Preferences/cloudflare/config/default.json", tokenValid: true },
      }),
    ).toThrow(expect.objectContaining({ code: "TEARDOWN_NEEDS_TOKEN", data: expect.objectContaining({ authSource: expect.stringContaining("OAuth") }) }));
    expect(() =>
      checkTokenScope({
        accountId: TEST,
        allowlist: [TEST],
        whoami: { ...whoami([TEST]), authSource: "CLOUDFLARE_API_TOKEN environment variable", tokenValid: true },
      }),
    ).not.toThrow();
    expect(() => checkTokenScope({ accountId: TEST, allowlist: [TEST], whoami: whoami([TEST]) })).not.toThrow();
  });
});
