/**
 * `everyapp signin add|list|show|remove` end to end, in a fake Cloudflare
 * account with a deployed gateway (as mcp/index.test.ts): add writes the
 * provider's whole family in one Gateway version and never takes the
 * secret from the command line; unattended without a value it stops before
 * anything is written; a malformed issuer or tenant is refused before
 * anything connects; list and show read names only; remove unsets every
 * name in one version; the `signin_provider.*` events each queues; and how
 * `secret set` and `secret list` treat the sign-in family.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createNdjsonSink } from "@/lib/output/events";
import { readSecretValue } from "@/lib/secretValue";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { listSecrets, setSecrets } from "../secret";
import {
  addProvider,
  listProviders,
  removeProvider,
  showProvider,
  type AddFlags,
  type SigninOptions,
} from "./index";

const GATEWAY = "every-app-gateway";
const GATEWAY_URL = "https://example.com";

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const flags = { json: true };
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const db = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0],
  );
const gatewayWorker = () => account.workers.get(GATEWAY)!;
const secrets = () => gatewayWorker().secrets;
const done = () => events.findLast((event) => event["type"] === "done");
const createCf = vi.fn(() => account.cf);
/** The `cf workers secrets bulk` calls on the Gateway Worker since `from`. */
const bulkCalls = (from = 0) =>
  account.cf.calls
    .slice(from)
    .filter((call) => call.args.slice(0, 3).join(" ") === "workers secrets bulk" && call.args.includes(GATEWAY));

const options = <F extends SigninOptions["flags"] = typeof flags>(extra: Partial<SigninOptions<F>> = {}): SigninOptions<F> => ({
  flags: flags as F,
  out: out(),
  createCf,
  interactive: false,
  ...extra,
});

const add = (id: string, addFlags: AddFlags = {}, extra: Partial<SigninOptions<AddFlags>> = {}) =>
  addProvider(options<AddFlags>({ flags: { ...flags, ...addFlags }, ...extra }), id);

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
  const resources = await ensureGatewayResources(account.cf);
  await applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: "example.com",
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    ...seams,
  });
  events = [];
  createCf.mockClear();
});

const dirs: string[] = [];

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory with no app in it. */
function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-signin-none-"));
  dirs.push(dir);
  return dir;
}

describe("signin add", () => {
  it("writes the client id and the secret from the environment in one Gateway version, and says what to do next", async () => {
    vi.stubEnv("GOOGLE_SECRET", "GOCSPX-secret\n");
    const before = account.cf.calls.length;

    await add("google", { "client-id": " 123.apps.googleusercontent.com ", "client-secret-from-env": "GOOGLE_SECRET" });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(bulkCalls(before)).toHaveLength(1);
    expect(secrets()).toMatchObject({
      GOOGLE_SIGNIN_CLIENT_ID: "123.apps.googleusercontent.com",
      GOOGLE_SIGNIN_CLIENT_SECRET: "GOCSPX-secret",
    });
    expect(done()).toMatchObject({
      data: {
        id: "google",
        label: "Google",
        status: "on",
        changed: true,
        set: ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"],
        kept: [],
        callbackUrl: `${GATEWAY_URL}/api/auth/callback/google`,
        signInUrl: `${GATEWAY_URL}/sign-in`,
        setup: "setup/signin-google.md",
      },
    });
    const message = String(done()!["message"]);
    expect(message).toContain("Sign in with Google is on.");
    expect(message).toContain(`${GATEWAY_URL}/api/auth/callback/google`);
    expect(message).toContain("Testing only signs in the test users");
    expect(message).toContain(`Sign in at ${GATEWAY_URL}/sign-in`);
    expect(message).toContain("Guide: .claude/skills/everyapp/setup/signin-google.md");
    // The secret's value is in no event.
    expect(JSON.stringify(events)).not.toContain("GOCSPX-secret");
  });

  it("writes every setting of oidc, the optional label included, in one version", async () => {
    vi.stubEnv("OKTA_SECRET", "s3cret");
    const before = account.cf.calls.length;

    await add("oidc", {
      issuer: "https://acme.okta.com/",
      "client-id": "0oa1",
      "client-secret-from-env": "OKTA_SECRET",
      label: "Okta",
    });

    expect(bulkCalls(before)).toHaveLength(1);
    expect(secrets()).toMatchObject({
      OIDC_SIGNIN_ISSUER: "https://acme.okta.com/",
      OIDC_SIGNIN_CLIENT_ID: "0oa1",
      OIDC_SIGNIN_CLIENT_SECRET: "s3cret",
      OIDC_SIGNIN_LABEL: "Okta",
    });
    expect(done()!["data"]["set"]).toEqual([
      "OIDC_SIGNIN_ISSUER",
      "OIDC_SIGNIN_CLIENT_ID",
      "OIDC_SIGNIN_CLIENT_SECRET",
      "OIDC_SIGNIN_LABEL",
    ]);
  });

  it("stops unattended without a required value, naming what is missing and the rerun, and writes nothing", async () => {
    const before = account.cf.calls.length;

    await expect(add("github", { "client-id": "Iv1.abc" })).rejects.toMatchObject({
      code: "SIGNIN_VALUE_REQUIRED",
      message: expect.stringContaining("Sign in with GitHub needs GITHUB_SIGNIN_CLIENT_SECRET"),
      rerun: "pnpm everyapp signin add github --client-id Iv1.abc --client-secret-from-env <VAR> --json",
      data: {
        provider: "github",
        missing: ["GITHUB_SIGNIN_CLIENT_SECRET"],
        flags: ["--client-secret-from-env"],
        callbackUrl: `${GATEWAY_URL}/api/auth/callback/github`,
      },
    });
    expect(bulkCalls(before)).toEqual([]);
    expect(Object.keys(secrets()).filter((name) => name.includes("_SIGNIN_"))).toEqual([]);

    await expect(add("oidc")).rejects.toMatchObject({
      code: "SIGNIN_VALUE_REQUIRED",
      rerun: "pnpm everyapp signin add oidc --issuer <issuer url> --client-id <client id> --client-secret-from-env <VAR> --json",
      data: { missing: ["OIDC_SIGNIN_ISSUER", "OIDC_SIGNIN_CLIENT_ID", "OIDC_SIGNIN_CLIENT_SECRET"] },
    });
  });

  it("refuses a malformed issuer or tenant, a flag of another provider and an unknown id before anything connects", async () => {
    vi.stubEnv("S", "x");
    const before = account.cf.calls.length;

    for (const issuer of ["http://acme.okta.com", "https://acme.okta.com/?x=1", "https://u:p@acme.okta.com", "acme.okta.com", "https://localhost:8443"]) {
      await expect(add("oidc", { issuer, "client-id": "c", "client-secret-from-env": "S" })).rejects.toMatchObject({
        code: "SIGNIN_ISSUER_INVALID",
        message: expect.stringContaining(`OIDC_SIGNIN_ISSUER can't be`),
        data: { name: "OIDC_SIGNIN_ISSUER" },
      });
    }
    await expect(add("microsoft", { tenant: "acme.onmicrosoft.com", "client-id": "c", "client-secret-from-env": "S" })).rejects.toMatchObject({
      code: "SIGNIN_TENANT_INVALID",
      fix: expect.stringContaining("Directory (tenant) ID"),
    });
    await expect(add("oidc", { issuer: "https://acme.okta.com", label: "x".repeat(41) })).rejects.toMatchObject({
      code: "SETTING_VALUE_INVALID",
      data: { name: "OIDC_SIGNIN_LABEL" },
    });
    await expect(add("google", { tenant: "common", issuer: "https://acme.okta.com" })).rejects.toMatchObject({
      code: "SIGNIN_FLAG_NOT_APPLICABLE",
      message: expect.stringContaining("--issuer and --tenant aren't settings of Sign in with Google"),
      data: { provider: "google", flags: ["--issuer", "--tenant"] },
    });
    await expect(add("okta")).rejects.toMatchObject({
      code: "SIGNIN_UNKNOWN_PROVIDER",
      rerun: "pnpm everyapp signin list",
      data: { providers: ["google", "microsoft", "github", "apple", "cloudflare", "oidc"] },
    });
    await expect(add("github", { "client-secret-from-env": "UNSET_VARIABLE" })).rejects.toMatchObject({
      code: "SECRET_EMPTY",
      fix: expect.stringContaining("--client-secret-from-env"),
    });

    expect(account.cf.calls.slice(before)).toEqual([]);
    expect(createCf).not.toHaveBeenCalled();
  });

  it("takes a GUID tenant and the login.microsoftonline.com words", async () => {
    vi.stubEnv("S", "x");
    await add("microsoft", { tenant: "72F988BF-86F1-41AF-91AB-2D7CD011DB47", "client-id": "c", "client-secret-from-env": "S" });
    expect(secrets()["MICROSOFT_SIGNIN_TENANT"]).toBe("72F988BF-86F1-41AF-91AB-2D7CD011DB47");
    await add("microsoft", { tenant: "organizations" });
    expect(secrets()["MICROSOFT_SIGNIN_TENANT"]).toBe("organizations");
  });

  it("keeps what is set and not given again: a rotated secret alone, one version, and nothing at all when nothing is given", async () => {
    vi.stubEnv("APPLE_SECRET", "jwt-one");
    await add("apple", { "client-id": "com.acme.gateway", "client-secret-from-env": "APPLE_SECRET" });
    vi.stubEnv("APPLE_SECRET", "jwt-two");
    const before = account.cf.calls.length;

    await add("apple", { "client-secret-from-env": "APPLE_SECRET" });

    expect(bulkCalls(before)).toHaveLength(1);
    expect(secrets()).toMatchObject({ APPLE_SIGNIN_CLIENT_ID: "com.acme.gateway", APPLE_SIGNIN_CLIENT_SECRET: "jwt-two" });
    expect(done()).toMatchObject({ data: { set: ["APPLE_SIGNIN_CLIENT_SECRET"], kept: ["APPLE_SIGNIN_CLIENT_ID"], changed: true } });
    expect(done()!["message"]).toContain("expires within six months");

    const again = account.cf.calls.length;
    await add("apple");
    expect(bulkCalls(again)).toEqual([]);
    expect(done()).toMatchObject({ data: { changed: false, set: [] } });
    expect(done()!["message"]).toContain("was on already; nothing changed");
  });

  it("asks at the terminal for what no flag gave, in catalog order, leaving an empty optional one unset", async () => {
    const asked: Array<{ name: string; canKeep: boolean }> = [];
    const answers: Record<string, string> = {
      OIDC_SIGNIN_ISSUER: "https://sso.acme.com/realms/acme",
      OIDC_SIGNIN_CLIENT_SECRET: "typed-secret",
      OIDC_SIGNIN_LABEL: "",
    };
    await add(
      "oidc",
      { json: false, "client-id": "gateway" },
      {
        interactive: true,
        readValue: async (setting, { canKeep }) => {
          asked.push({ name: setting.name, canKeep });
          return answers[setting.name]!;
        },
      },
    );

    expect(asked).toEqual([
      { name: "OIDC_SIGNIN_ISSUER", canKeep: false },
      { name: "OIDC_SIGNIN_CLIENT_SECRET", canKeep: false },
      { name: "OIDC_SIGNIN_LABEL", canKeep: true },
    ]);
    expect(secrets()).toMatchObject({
      OIDC_SIGNIN_ISSUER: "https://sso.acme.com/realms/acme",
      OIDC_SIGNIN_CLIENT_ID: "gateway",
      OIDC_SIGNIN_CLIENT_SECRET: "typed-secret",
    });
    expect(secrets()).not.toHaveProperty("OIDC_SIGNIN_LABEL");
  });

  it("refuses a typed issuer the Gateway wouldn't read, and an empty required answer, writing nothing", async () => {
    const before = account.cf.calls.length;
    await expect(
      add("oidc", { json: false }, { interactive: true, readValue: async (setting) => (setting.role === "issuer" ? "http://sso.acme.com" : "x") }),
    ).rejects.toMatchObject({ code: "SIGNIN_ISSUER_INVALID" });
    await expect(add("github", { json: false }, { interactive: true, readValue: async () => "" })).rejects.toMatchObject({
      code: "SIGNIN_VALUE_REQUIRED",
      message: expect.stringContaining("Nothing was changed."),
    });
    expect(bulkCalls(before)).toEqual([]);
  });
});

describe("signin list and show", () => {
  it("lists every provider as on, needs setup (naming what is missing) or off, from names alone", async () => {
    Object.assign(secrets(), {
      GOOGLE_SIGNIN_CLIENT_ID: "id",
      GOOGLE_SIGNIN_CLIENT_SECRET: "secret",
      GITHUB_SIGNIN_CLIENT_ID: "id",
      MICROSOFT_SIGNIN_TENANT: "common",
    });

    await listProviders(options());

    const providers = done()!["data"]["providers"] as Array<Record<string, unknown>>;
    expect(providers.map((each) => [each["id"], each["status"], each["missing"]])).toEqual([
      ["google", "on", []],
      ["microsoft", "needs setup", ["MICROSOFT_SIGNIN_CLIENT_ID", "MICROSOFT_SIGNIN_CLIENT_SECRET"]],
      ["github", "needs setup", ["GITHUB_SIGNIN_CLIENT_SECRET"]],
      ["apple", "off", []],
      ["cloudflare", "off", []],
      ["oidc", "off", []],
    ]);
    expect(providers[0]).toEqual({
      id: "google",
      label: "Google",
      status: "on",
      missing: [],
      set: ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"],
      callbackUrl: `${GATEWAY_URL}/api/auth/callback/google`,
      setup: "setup/signin-google.md",
    });
    expect(done()).toMatchObject({
      message: "1 of 6 sign-in providers on",
      data: {
        signInUrl: `${GATEWAY_URL}/sign-in`,
        next: [
          { command: "pnpm everyapp signin add microsoft", note: "finish Sign in with Microsoft" },
          { command: "pnpm everyapp signin add github", note: "finish Sign in with GitHub" },
        ],
      },
    });
    expect(JSON.stringify(done())).not.toContain('"secret"');
  });

  it("shows where to make the OAuth app, the redirect URL, every setting and whether it is set, changing nothing", async () => {
    secrets()["APPLE_SIGNIN_CLIENT_ID"] = "com.acme.gateway";
    const before = account.cf.calls.length;

    await showProvider(options(), "apple");

    expect(bulkCalls(before)).toEqual([]);
    expect(done()).toMatchObject({
      data: {
        id: "apple",
        status: "needs setup",
        missing: ["APPLE_SIGNIN_CLIENT_SECRET"],
        set: ["APPLE_SIGNIN_CLIENT_ID"],
        console: "https://developer.apple.com/account/resources/identifiers/list/serviceId",
        appNoun: "Services ID",
        callbackUrl: `${GATEWAY_URL}/api/auth/callback/apple`,
        scopes: ["email", "name"],
        settings: [
          { name: "APPLE_SIGNIN_CLIENT_ID", role: "clientId", required: true, plain: true, set: true },
          { name: "APPLE_SIGNIN_CLIENT_SECRET", role: "clientSecret", required: true, plain: false, set: false },
        ],
        setup: "setup/signin-apple.md",
        next: [{ command: "pnpm everyapp signin add apple", note: "turn Sign in with Apple on" }],
      },
    });
    expect(done()!["data"]["notes"]).toHaveLength(2);
    expect(done()!["message"]).toContain("Redirect URL");

    await expect(showProvider(options(), "facebook")).rejects.toMatchObject({ code: "SIGNIN_UNKNOWN_PROVIDER" });
  });
});

describe("signin remove", () => {
  it("unsets every setting of the provider in one version once confirmed, and says accounts stay", async () => {
    Object.assign(secrets(), {
      MICROSOFT_SIGNIN_CLIENT_ID: "id",
      MICROSOFT_SIGNIN_CLIENT_SECRET: "secret",
      MICROSOFT_SIGNIN_TENANT: "common",
      GOOGLE_SIGNIN_CLIENT_ID: "kept",
    });
    const before = account.cf.calls.length;

    await removeProvider(options({ flags: { ...flags, yes: true } }), "microsoft");

    expect(bulkCalls(before)).toHaveLength(1);
    expect(Object.keys(secrets()).filter((name) => name.includes("_SIGNIN_"))).toEqual(["GOOGLE_SIGNIN_CLIENT_ID"]);
    expect(done()).toMatchObject({
      data: { id: "microsoft", removed: ["MICROSOFT_SIGNIN_CLIENT_ID", "MICROSOFT_SIGNIN_CLIENT_SECRET", "MICROSOFT_SIGNIN_TENANT"] },
    });
    expect(done()!["message"]).toContain("keep their accounts");
  });

  it("needs --yes unattended, cancels on No, and does nothing for a provider that isn't set up", async () => {
    Object.assign(secrets(), { GITHUB_SIGNIN_CLIENT_ID: "id", GITHUB_SIGNIN_CLIENT_SECRET: "secret" });

    await expect(removeProvider(options(), "github")).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      message: "Turning Sign in with GitHub off needs confirmation at a terminal, or --yes",
      data: { provider: "github", names: ["GITHUB_SIGNIN_CLIENT_ID", "GITHUB_SIGNIN_CLIENT_SECRET"] },
    });
    const confirm = vi.fn(async () => false);
    await expect(removeProvider(options({ interactive: true, confirm }), "github")).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Cancelled. Sign in with GitHub stays as it was.",
    });
    expect(confirm).toHaveBeenCalledWith("Turn Sign in with GitHub off?", expect.arrayContaining([expect.stringContaining("keep their accounts")]));
    expect(secrets()).toHaveProperty("GITHUB_SIGNIN_CLIENT_SECRET");

    const before = account.cf.calls.length;
    await removeProvider(options(), "apple");
    expect(bulkCalls(before)).toEqual([]);
    expect(done()).toMatchObject({ message: "Sign in with Apple isn't set up; nothing changed.", data: { removed: [] } });
  });
});

describe("the signin_provider events", () => {
  const queued = async () =>
    ((await db().run([{ sql: "SELECT organization_id, type, actor, data FROM events ORDER BY rowid" }]))[0] ?? []).map((row) => ({
      organization: row["organization_id"],
      type: row["type"],
      actor: JSON.parse(String(row["actor"])),
      data: JSON.parse(String(row["data"])),
    }));

  it("queues added when a provider goes on and removed when it goes off, never for a rotation, with no setting in the data", async () => {
    await db().run([
      { sql: "INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-1', 'Acme', 'acme', 0)" },
      {
        sql: "INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, events, created_at, updated_at) VALUES ('sub_1', 'org-1', 'Slack', 'webhook', 'https://hooks.example.org/x', 'whsec_x', '[\"signin_provider.*\"]', 0, 0)",
      },
    ]);
    vi.stubEnv("S", "secret-one");
    await add("cloudflare", { "client-id": "cf-client", "client-secret-from-env": "S" });
    vi.stubEnv("S", "secret-two");
    await add("cloudflare", { "client-secret-from-env": "S" });
    await removeProvider(options({ flags: { ...flags, yes: true } }), "cloudflare");

    expect(await queued()).toEqual([
      {
        organization: "org-1",
        type: "signin_provider.added",
        actor: { kind: "operator", id: "dev@example.com", email: "dev@example.com" },
        data: { provider: "cloudflare", label: "Cloudflare" },
      },
      expect.objectContaining({ type: "signin_provider.removed", data: { provider: "cloudflare", label: "Cloudflare" } }),
    ]);
    const [deliveries = []] = await db().run([{ sql: "SELECT subscription_id, status FROM event_deliveries" }]);
    expect(deliveries).toEqual([
      { subscription_id: "sub_1", status: "pending" },
      { subscription_id: "sub_1", status: "pending" },
    ]);
  });
});

describe("secret set and secret list with the sign-in family", () => {
  const set = (...names: string[]) =>
    setSecrets({ flags, out: out(), cwd: emptyDir(), createCf, names, readValue: async (name) => `value-of-${name}` });

  it("sets a catalog provider's setting, and refuses a name of the family no provider reads", async () => {
    await set("GITHUB_SIGNIN_CLIENT_ID");
    expect(secrets()["GITHUB_SIGNIN_CLIENT_ID"]).toBe("value-of-GITHUB_SIGNIN_CLIENT_ID");

    await expect(set("FOO_SIGNIN_CLIENT_ID")).rejects.toMatchObject({
      code: "SECRET_NOT_SETTABLE",
      message: "FOO isn't a sign-in provider (google, microsoft, github, apple, cloudflare, oidc): pnpm everyapp signin list",
    });
    await expect(set("OIDC_SIGNIN_TENANT")).rejects.toMatchObject({
      code: "SECRET_NOT_SETTABLE",
      message:
        "OIDC_SIGNIN_TENANT isn't a setting of Sign in with SSO\nIt reads OIDC_SIGNIN_ISSUER, OIDC_SIGNIN_CLIENT_ID, OIDC_SIGNIN_CLIENT_SECRET and OIDC_SIGNIN_LABEL.",
      rerun: "pnpm everyapp signin show oidc",
    });
  });

  it("checks a plain sign-in setting's value as signin add does", async () => {
    vi.stubEnv("ISSUER", "http://sso.acme.com");
    await expect(readSecretValue("OIDC_SIGNIN_ISSUER", { fromEnv: "ISSUER" })).rejects.toMatchObject({
      code: "SETTING_VALUE_INVALID",
      message: expect.stringContaining("isn't an https URL"),
    });
    vi.stubEnv("TENANT", " common ");
    await expect(readSecretValue("MICROSOFT_SIGNIN_TENANT", { fromEnv: "TENANT" })).resolves.toBe("common");
  });

  it("keeps the unset sign-in settings in secret list's settable, and points at signin list", async () => {
    await listSecrets({ flags, out: out(), cwd: emptyDir(), createCf });
    const settable = done()!["data"]["gateway"]["settable"] as string[];
    expect(settable).toEqual(expect.arrayContaining(["GOOGLE_SIGNIN_CLIENT_ID", "OIDC_SIGNIN_ISSUER", "APPLE_SIGNIN_CLIENT_SECRET"]));
  });
});
