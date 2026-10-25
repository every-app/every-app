/**
 * `everyapp provider add|list|show|remove` end to end, in a fake
 * Cloudflare account with a deployed gateway (its D1 a real SQLite with
 * the gateway's migrations, `providers` included): the row each writes,
 * every refusal before anything is written, what list and show report,
 * and the hidden `provider on|off` that run `mcp on|off`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { parseProviderSpec, providerBindingKey, providerSpecOf } from "@every-app/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { readInstall } from "@/lib/gateway/install";
import { register } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createHumanSink, createNdjsonSink, type EventSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import {
  addFromSpec,
  listProviders,
  MAX_SPEC_BYTES,
  removeRegistered,
  runMcpAlias,
  showProvider,
} from "./index";

const GATEWAY = "every-app-gateway";

const STRIPE = {
  id: "stripe",
  name: "Stripe",
  docs: "https://dashboard.stripe.com/apikeys",
  hosts: ["api.stripe.com"],
  auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
  hint: "A restricted key from the Stripe dashboard.",
  data: "account",
};

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;
const dirs: string[] = [];

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const flags = { json: true };
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const db = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0],
  );
const gatewayWorker = () => account.workers.get(GATEWAY)!;
const done = () => events.find((event) => event["type"] === "done");
const steps = (step: string) => events.filter((event) => event["type"] === "step" && event["step"] === step);
const createCf = vi.fn(() => account.cf);

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
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A directory holding `spec` as stripe.json (or `name`). */
function specDir(spec: unknown, name = "stripe.json"): string {
  const dir = tempDir("everyapp-provider-spec-");
  fs.writeFileSync(path.join(dir, name), typeof spec === "string" ? spec : JSON.stringify(spec));
  return dir;
}

/** An app's directory: an everyapp.config.ts is there. */
function appDir(spec?: unknown): string {
  const dir = spec === undefined ? tempDir("everyapp-provider-app-") : specDir(spec);
  fs.writeFileSync(path.join(dir, "everyapp.config.ts"), 'export default { id: "shop" };\n');
  return dir;
}

const add = (cwd: string, source = "stripe.json", options: { replace?: boolean; fetch?: typeof fetch } = {}) =>
  addFromSpec(
    { flags: { ...flags, replace: options.replace }, out: out(), cwd, createCf, ...(options.fetch ? { fetch: options.fetch } : {}) },
    source,
  );
const list = () => listProviders({ flags, out: out(), createCf });
const show = (id: string, cwd = tempDir("everyapp-provider-none-"), save = false) =>
  showProvider({ flags: { ...flags, save }, out: out(), cwd, createCf }, id);
const remove = (id: string, force = false) => removeRegistered({ flags: { ...flags, force }, out: out(), createCf }, id);

/** What a person sees of a run: the human sink's output, without color. */
async function human(run: (out: EventSink) => Promise<void>): Promise<string> {
  let text = "";
  await run(createHumanSink({ write: (chunk) => (text += chunk), writeProblem: (chunk) => (text += chunk) }));
  return stripVTControlCharacters(text);
}

const rows = async () =>
  (await db().run([{ sql: "SELECT id, spec, added_by, bound_to, bound_at FROM providers ORDER BY id" }]))[0] ?? [];

/** Register an app (as a first deploy does) whose manifest is `manifest`. */
async function registerApp(id: string, manifest: Record<string, unknown>) {
  await register(db(), {
    appSlug: id,
    name: id,
    description: id,
    manifest: { id, ...manifest },
    appBaseDomain: "example.com",
    deployer: { actor: "dev@example.com", email: "dev@example.com" },
    organizationName: "Acme",
  });
}

describe("provider add", () => {
  it("registers a spec from a file, says where its key goes, and names the one command next", async () => {
    await add(specDir(STRIPE));

    expect(await rows()).toEqual([
      { id: "stripe", spec: JSON.stringify(STRIPE), added_by: "dev@example.com", bound_to: null, bound_at: null },
    ]);
    expect(steps("provider.add").map((step) => step["status"])).toEqual(["start", "ok"]);
    expect(done()).toMatchObject({
      message: expect.stringContaining("Registered Stripe (stripe) on example.com.\nIts key goes to api.stripe.com only, as a bearer token."),
      data: {
        id: "stripe",
        name: "Stripe",
        hosts: ["api.stripe.com"],
        settings: ["STRIPE_API_KEY"],
        source: "row",
        replaced: false,
        next: [
          {
            command: "pnpm everyapp secret set STRIPE_API_KEY",
            note: "Stripe's key, from https://dashboard.stripe.com/apikeys; the Gateway sends it only to api.stripe.com",
          },
        ],
      },
    });
    // Not in an app's directory: no file for everyapp dev.
    expect(done()!["data"]["devFile"]).toBeUndefined();
  });

  it("writes the spec for everyapp dev when run in an app's directory", async () => {
    const dir = appDir(STRIPE);
    await add(dir);
    const file = path.join(dir, ".everyapp", "providers", "stripe.json");
    const parsed = parseProviderSpec(STRIPE);
    if (!parsed.ok) throw new Error("the spec parses");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(providerSpecOf("stripe", parsed.capability));
    expect(done()).toMatchObject({
      message: expect.stringContaining("Wrote .everyapp/providers/stripe.json for everyapp dev"),
      data: { devFile: ".everyapp/providers/stripe.json" },
    });
  });

  it("fetches a spec from an https URL, 64 KiB at most, and refuses any other", async () => {
    const fetcher = vi.fn(async () => Response.json(STRIPE));
    await add(tempDir("everyapp-provider-url-"), "https://specs.example.org/stripe.json", { fetch: fetcher as never });
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await rows()).map((row) => row["id"])).toEqual(["stripe"]);

    const cwd = tempDir("everyapp-provider-url-");
    await expect(add(cwd, "http://specs.example.org/stripe.json", { fetch: fetcher as never })).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: "http://specs.example.org/stripe.json isn't https",
    });
    const big = vi.fn(async () => new Response("x".repeat(MAX_SPEC_BYTES + 1)));
    await expect(add(cwd, "https://specs.example.org/big.json", { fetch: big as never })).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: "https://specs.example.org/big.json is over 64 KiB",
    });
    const missing = vi.fn(async () => new Response("no", { status: 404 }));
    await expect(add(cwd, "https://specs.example.org/none.json", { fetch: missing as never })).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: "https://specs.example.org/none.json answered 404",
    });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(add(cwd, "https://specs.example.org/x.json", { fetch: offline as never })).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: "Couldn't fetch https://specs.example.org/x.json: fetch failed",
    });
  });

  it("refuses a file that isn't there, isn't JSON or is over 64 KiB, before reaching the Gateway", async () => {
    createCf.mockClear();
    const cwd = tempDir("everyapp-provider-file-");
    await expect(add(cwd, "nope.json")).rejects.toMatchObject({ code: "PROVIDER_SPEC_INVALID", message: "No file at nope.json" });
    await expect(add(specDir("{not json"))).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: expect.stringMatching(/^stripe\.json isn't JSON: /),
    });
    await expect(add(specDir({ ...STRIPE, description: "x".repeat(MAX_SPEC_BYTES) }))).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: "stripe.json is over 64 KiB",
    });
    expect(createCf).not.toHaveBeenCalled();
  });

  it("refuses a spec the parser or the rules refuse, naming why, and writes nothing", async () => {
    // Every problem, each with its path.
    const invalid = add(specDir({ ...STRIPE, hosts: [], auth: { kind: "oauth2-user", secret: "STRIPE_ID" } }));
    await expect(invalid).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: expect.stringMatching(/^The spec isn't one this Gateway takes\n.*hosts: required: at least one host/),
    });
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining("auth.kind: must be bearer, header, query or basic"),
    });
    await expect(add(specDir({ ...STRIPE, id: "dataforseo", auth: { kind: "bearer", secret: "DATAFORSEO_X" } }))).rejects.toMatchObject({
      code: "PROVIDER_BUILTIN",
      message: "dataforseo is built in\nA registered provider can't take a built-in provider's id.",
    });
    await expect(add(specDir({ ...STRIPE, auth: { kind: "bearer", secret: "OPENAI_API_KEY" } }))).rejects.toMatchObject({
      code: "PROVIDER_SECRET_TAKEN",
      message: "stripe can't use that setting: OPENAI_API_KEY doesn't start with STRIPE_: a provider's settings carry its own id",
    });
    await expect(add(specDir({ ...STRIPE, hosts: ["api.example.com"] }))).rejects.toMatchObject({
      code: "PROVIDER_HOST_REFUSED",
      message: "stripe's key can't be sent there: api.example.com is under this gateway's app domain example.com",
    });
    await expect(add(specDir({ ...STRIPE, hosts: ["10.0.0.1"] }))).rejects.toMatchObject({
      code: "PROVIDER_HOST_REFUSED",
      message: "stripe's key can't be sent there: 10.0.0.1 is an IP address, not a host name",
    });
    expect(await rows()).toEqual([]);
  });

  it("refuses a setting another row holds, or a registered app keeps as its own secret, naming the app", async () => {
    await add(specDir({ ...STRIPE, id: "stripe-connect", name: "Stripe Connect", auth: { kind: "bearer", secret: "STRIPE_CONNECT_KEY" } }));
    await expect(add(specDir({ ...STRIPE, auth: { kind: "bearer", secret: "STRIPE_CONNECT_KEY" } }))).rejects.toMatchObject({
      code: "PROVIDER_SECRET_TAKEN",
      message: "stripe can't use that setting: STRIPE_CONNECT_KEY is another registered provider's",
    });

    await registerApp("shop", { secrets: ["STRIPE_API_KEY"] });
    await expect(add(specDir(STRIPE))).rejects.toMatchObject({
      code: "PROVIDER_SECRET_TAKEN",
      message:
        "STRIPE_API_KEY is shop's own secret\nshop's deployed manifest lists it under secrets, so a provider can't read it from the Gateway.",
    });
    expect((await rows()).map((row) => row["id"])).toEqual(["stripe-connect"]);
  });

  it("refuses an id that has a row unless --replace, which writes the new spec and unbinds its key", async () => {
    await add(specDir(STRIPE));
    // As `secret set STRIPE_API_KEY` binds it.
    await db().run([{ sql: "UPDATE providers SET bound_to = 'bound', bound_at = 1 WHERE id = 'stripe'" }]);
    const moved = { ...STRIPE, hosts: ["api.stripe.com", "files.stripe.com"] };

    await expect(add(specDir(moved))).rejects.toMatchObject({
      code: "PROVIDER_EXISTS",
      message: expect.stringMatching(/^stripe is registered on this Gateway already\n/),
      rerun: expect.stringContaining("--replace"),
      authorize: true,
    });
    expect((await rows())[0]).toMatchObject({ spec: JSON.stringify(STRIPE), bound_to: "bound" });

    events = [];
    await add(specDir(moved), "stripe.json", { replace: true });
    expect((await rows())[0]).toMatchObject({ spec: JSON.stringify(moved), bound_to: null, bound_at: null });
    expect(done()).toMatchObject({
      message: expect.stringContaining("Replaced Stripe (stripe)"),
      data: { replaced: true, hosts: ["api.stripe.com", "files.stripe.com"] },
    });
    expect(done()!["message"]).toContain("set it again before the Gateway sends it");
  });

  it("refuses on a Gateway from before the providers table, naming the update", async () => {
    await db().run([{ sql: "DROP TABLE providers" }]);
    await expect(add(specDir(STRIPE))).rejects.toMatchObject({
      code: "GATEWAY_OUTDATED",
      rerun: "pnpm everyapp update",
    });
    // Its readers read no rows.
    events = [];
    await list();
    expect(done()!["data"]["providers"].filter((provider: { source: string }) => provider.source === "row")).toEqual([]);
  });
});

describe("provider list", () => {
  it("lists the catalog's providers and the rows, each setting set or not, a row bound or not, and the apps using each", async () => {
    await add(specDir(STRIPE));
    gatewayWorker().secrets["OPENROUTER_API_KEY"] = "sk-or";
    await registerApp("shop", { capabilities: { stripe: { access: "read" } }, providers: ["openrouter"] });
    events = [];
    await list();

    const providers = done()!["data"]["providers"] as Array<Record<string, any>>;
    const ids = providers.map((provider) => provider["id"]);
    // The catalog first (no services), then the rows.
    expect(ids).toEqual(expect.arrayContaining(["openai", "openrouter", "dataforseo", "linkedin", "stripe"]));
    expect(ids).not.toContain("email");
    expect(providers.at(-1)).toEqual({
      id: "stripe",
      name: "Stripe",
      kind: "api key",
      hosts: ["api.stripe.com"],
      settings: [{ name: "STRIPE_API_KEY", set: false }],
      bound: false,
      source: "row",
      addedBy: "dev@example.com",
      addedAt: expect.any(Number),
      apps: ["shop"],
    });
    expect(providers.find((provider) => provider["id"] === "openrouter")).toEqual({
      id: "openrouter",
      name: "OpenRouter",
      kind: "ai",
      hosts: ["openrouter.ai"],
      settings: [{ name: "OPENROUTER_API_KEY", set: true }],
      bound: true,
      source: "catalog",
      apps: ["shop"],
    });
    expect(providers.find((provider) => provider["id"] === "mastodon")).toMatchObject({
      kind: "oauth client",
      hostSetting: "MASTODON_URL",
    });
    expect(done()).toMatchObject({
      message: `${providers.length} providers: ${providers.length - 1} built in, 1 registered`,
      data: { mcp: "pnpm everyapp mcp list" },
    });
    const shown = await human((sink) => listProviders({ flags: {}, out: sink, createCf }));
    expect(shown).toMatch(/^ID +NAME +KIND +HOSTS +SETTINGS +SOURCE +APPS\n/);
    expect(shown).toMatch(
      /\nstripe +Stripe +api key +api\.stripe\.com +STRIPE_API_KEY not set, not bound +registered by dev@example\.com +shop\n/,
    );
    expect(shown).toMatch(/\nopenrouter +OpenRouter +ai +openrouter\.ai +OPENROUTER_API_KEY set +catalog +shop\n/);
    expect(shown).toMatch(/\nmastodon +Mastodon +oauth client +<MASTODON_URL> /);
    // Through launch week, where the MCP apps went.
    expect(shown).toMatch(/\n\nMCP apps: pnpm everyapp mcp list\n/);
  });

  it("says which rows the Gateway doesn't serve, and why", async () => {
    await db().run([
      {
        sql: "INSERT INTO providers (id, spec, added_by, added_at, updated_at) VALUES ('evil', ?, 'x@example.com', 1, 1)",
        params: [JSON.stringify({ ...STRIPE, id: "evil", name: "Evil", auth: { kind: "bearer", secret: "JWT_PRIVATE_KEY" } })],
      },
    ]);
    await list();
    expect(done()!["data"]["rejected"]).toEqual([
      { id: "evil", code: "PROVIDER_SECRET_TAKEN", message: "JWT_PRIVATE_KEY doesn't start with EVIL_: a provider's settings carry its own id" },
    ]);
    expect(done()!["data"]["providers"].map((provider: { id: string }) => provider.id)).not.toContain("evil");
    expect(await human((sink) => listProviders({ flags: {}, out: sink, createCf }))).toContain(
      "The Gateway doesn't serve evil:\n  evil: JWT_PRIVATE_KEY doesn't start with EVIL_: a provider's settings carry its own id (PROVIDER_SECRET_TAKEN)",
    );
  });
});

describe("provider show", () => {
  it("prints a registered provider's spec, who registered it, whether its key is bound, and the apps using it", async () => {
    await add(specDir(STRIPE));
    await registerApp("shop", { capabilities: { stripe: { access: "read" } } });
    events = [];
    await show("stripe");
    const parsed = parseProviderSpec(STRIPE);
    if (!parsed.ok) throw new Error("the spec parses");
    expect(done()).toMatchObject({
      message: "Stripe (stripe)",
      data: {
        provider: providerSpecOf("stripe", parsed.capability),
        source: "row",
        bound: false,
        addedBy: "dev@example.com",
        addedAt: expect.any(Number),
        apps: ["shop"],
        next: [{ command: "pnpm everyapp secret set STRIPE_API_KEY" }],
      },
    });
    const shown = await human((sink) => showProvider({ flags: {}, out: sink, createCf }, "stripe"));
    expect(shown).toContain('"hosts": [\n    "api.stripe.com"\n  ]');
    expect(shown).toContain("Registered by dev@example.com on ");
    expect(shown).toContain("its key isn't set for these hosts yet.\nUsed by shop.");

    // Once its key is bound, nothing is next.
    await db().run([
      { sql: "UPDATE providers SET bound_to = ? WHERE id = 'stripe'", params: [providerBindingKey(parsed.capability)] },
    ]);
    events = [];
    await show("stripe");
    expect(done()!["data"]).toMatchObject({ bound: true });
    expect(done()!["data"]["next"]).toBeUndefined();
  });

  it("prints a built-in provider's spec: an API key's whole, an AI provider's and an OAuth client's setup fields", async () => {
    await show("dataforseo");
    expect(done()!["data"]).toMatchObject({
      provider: { id: "dataforseo", name: "DataForSEO", auth: { kind: "basic", secret: "DATAFORSEO_API_KEY", as: "pair" } },
      source: "catalog",
      bound: true,
      addedBy: null,
      apps: [],
    });
    events = [];
    await show("openrouter");
    expect(done()!["data"]["provider"]).toMatchObject({
      id: "openrouter",
      kind: "ai",
      settings: ["OPENROUTER_API_KEY"],
      hosts: ["openrouter.ai"],
      setup: "setup/openrouter.md",
    });
    events = [];
    await show("linkedin");
    expect(done()!["data"]["provider"]).toMatchObject({
      id: "linkedin",
      kind: "oauth client",
      settings: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
      tokenEndpoints: ["POST https://www.linkedin.com/oauth/v2/accessToken"],
    });
  });

  it("refuses an id the Gateway doesn't offer, and a service", async () => {
    await expect(show("square")).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
      message: "square isn't a provider this Gateway offers",
      rerun: "pnpm everyapp provider list",
    });
    await expect(show("email")).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
      message: expect.stringMatching(/^email is a Gateway service, not a provider/),
    });
  });

  it("with --save, writes a registered provider's spec in an app's directory, and nowhere else", async () => {
    await add(specDir(STRIPE));
    await expect(show("stripe", tempDir("everyapp-provider-none-"), true)).rejects.toMatchObject({
      code: "MANIFEST_NOT_FOUND",
    });
    const dir = appDir();
    await expect(show("dataforseo", dir, true)).rejects.toMatchObject({
      code: "PROVIDER_BUILTIN",
      message: "dataforseo is built in\neveryapp dev reaches it without a file. Nothing was written.",
    });
    events = [];
    await show("stripe", dir, true);
    expect(fs.existsSync(path.join(dir, ".everyapp", "providers", "stripe.json"))).toBe(true);
    expect(done()!["data"]["saved"]).toBe(".everyapp/providers/stripe.json");
  });
});

describe("provider remove", () => {
  it("refuses a built-in id, an id with no row, and a row a registered app lists unless --force", async () => {
    await expect(remove("dataforseo")).rejects.toMatchObject({ code: "PROVIDER_BUILTIN" });
    await expect(remove("stripe")).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
      message: "No provider stripe is registered on this Gateway",
    });
    await add(specDir(STRIPE));
    await registerApp("shop", { capabilities: { stripe: { access: "read" } } });
    await expect(remove("stripe")).rejects.toMatchObject({
      code: "PROVIDER_IN_USE",
      message: expect.stringMatching(/^shop lists stripe under capabilities\n/),
      rerun: expect.stringContaining("--force"),
      authorize: true,
    });
    expect((await rows()).map((row) => row["id"])).toEqual(["stripe"]);

    gatewayWorker().secrets["STRIPE_API_KEY"] = "sk_live";
    events = [];
    await remove("stripe", true);
    expect(await rows()).toEqual([]);
    expect(done()).toMatchObject({
      data: {
        id: "stripe",
        name: "Stripe",
        removed: true,
        settings: [{ name: "STRIPE_API_KEY", set: true }],
        apps: ["shop"],
        next: [{ command: "pnpm everyapp secret unset STRIPE_API_KEY" }],
      },
    });
    // The Gateway's setting stays until it is unset.
    expect(gatewayWorker().secrets["STRIPE_API_KEY"]).toBe("sk_live");
    expect(done()!["message"]).toContain(
      "STRIPE_API_KEY stays on the Gateway, read by nothing: pnpm everyapp secret unset STRIPE_API_KEY removes it.",
    );
  });
});

describe("provider on|off", () => {
  it("say they are mcp on|off now, then run them", async () => {
    await runMcpAlias({ flags, out: out(), createCf }, "on", "dataforseo");
    expect(steps("provider.alias")).toEqual([
      expect.objectContaining({
        status: "ok",
        message: "everyapp provider on is now everyapp mcp on; this alias goes after launch week.",
      }),
    ]);
    expect(done()).toMatchObject({ data: { id: "dataforseo", on: true } });

    events = [];
    await runMcpAlias({ flags, out: out(), createCf }, "off", "dataforseo");
    expect(steps("provider.alias")[0]!["message"]).toBe(
      "everyapp provider off is now everyapp mcp off; this alias goes after launch week.",
    );
    expect(done()).toMatchObject({ data: { id: "dataforseo", on: false, wasOn: true } });
    expect(await readInstall(db())).not.toBeNull();
  });
});
