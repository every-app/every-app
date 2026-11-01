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
import {
  CAPABILITIES,
  capabilitySettings,
  OAUTH_PRESETS,
  oauthPreset,
  parseProviderSpec,
  providerBindingKey,
  providerSpecOf,
} from "@every-app/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { readInstall, writeInstall } from "@/lib/gateway/install";
import { register } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createHumanSink, createNdjsonSink, type EventSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import {

  addAny,
  addFromSpec,
  listProviders,
  MAX_SPEC_BYTES,
  removeRegistered,
  runMcpAlias,
  showProvider,
} from "./index";
import { addOAuth, disconnectProvider, listPresets, listProviderConnections } from "./oauth";

const GATEWAY = "every-app-gateway";

// A person at a terminal for the tests that set `terminal.on`: every
// "Which Gateway?" counted, answered with the first choice.
const terminal = vi.hoisted(() => ({ on: false, picks: 0 }));
vi.mock("@/lib/output/prompt", async (importOriginal) => {
  const prompt = await importOriginal<typeof import("@/lib/output/prompt")>();
  return {
    ...prompt,
    canPromptInTerminal: (json: boolean) => (terminal.on ? !json : prompt.canPromptInTerminal(json)),
    choose: async <T,>(question: string, choices: ReadonlyArray<{ value: T }>, asked?: object) => {
      if (!terminal.on) return prompt.choose(question, choices as never, asked);
      if (question === "Which Gateway?") terminal.picks += 1;
      return choices[0]!.value;
    },
  };
});

const NORTHWIND = {
  id: "northwind",
  name: "Northwind",
  docs: "https://developer.northwind.io/keys",
  hosts: ["api.northwind.io"],
  auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
  hint: "A restricted key from the Northwind dashboard.",
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
  terminal.on = false;
  terminal.picks = 0;
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

/** A directory holding `spec` as northwind.json (or `name`). */
function specDir(spec: unknown, name = "northwind.json"): string {
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

const add = (cwd: string, source = "northwind.json", options: { replace?: boolean; fetch?: typeof fetch } = {}) =>
  addFromSpec(
    { flags: { ...flags, replace: options.replace }, out: out(), cwd, createCf, readStdin: async () => null, ...(options.fetch ? { fetch: options.fetch } : {}) },
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
    await add(specDir(NORTHWIND));

    expect(await rows()).toEqual([
      { id: "northwind", spec: JSON.stringify(NORTHWIND), added_by: "dev@example.com", bound_to: null, bound_at: null },
    ]);
    expect(steps("provider.add").map((step) => step["status"])).toEqual(["start", "ok"]);
    expect(done()).toMatchObject({
      message: expect.stringContaining("Registered Northwind (northwind) on example.com.\nIts key goes to api.northwind.io only, as a bearer token."),
      data: {
        id: "northwind",
        name: "Northwind",
        hosts: ["api.northwind.io"],
        settings: ["NORTHWIND_API_KEY"],
        source: "row",
        replaced: false,
        keySet: false,
        next: [{ command: "pnpm everyapp secret set NORTHWIND_API_KEY" }],
      },
    });
    // Not in an app's directory: no file for everyapp dev.
    expect(done()!["data"]["devFile"]).toBeUndefined();
  });

  it("writes the spec for everyapp dev when run in an app's directory", async () => {
    const dir = appDir(NORTHWIND);
    await add(dir);
    const file = path.join(dir, ".everyapp", "providers", "northwind.json");
    const parsed = parseProviderSpec(NORTHWIND);
    if (!parsed.ok) throw new Error("the spec parses");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(providerSpecOf("northwind", parsed.capability));
    expect(done()).toMatchObject({
      message: expect.stringContaining("Wrote .everyapp/providers/northwind.json for everyapp dev"),
      data: { devFile: ".everyapp/providers/northwind.json" },
    });
  });

  it("fetches a spec from an https URL, 64 KiB at most, and refuses any other", async () => {
    const fetcher = vi.fn(async () => Response.json(NORTHWIND));
    await add(tempDir("everyapp-provider-url-"), "https://specs.example.org/northwind.json", { fetch: fetcher as never });
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await rows()).map((row) => row["id"])).toEqual(["northwind"]);

    const cwd = tempDir("everyapp-provider-url-");
    await expect(add(cwd, "http://specs.example.org/northwind.json", { fetch: fetcher as never })).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: "http://specs.example.org/northwind.json isn't https",
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
      message: expect.stringMatching(/^northwind\.json isn't JSON: /),
    });
    await expect(add(specDir({ ...NORTHWIND, description: "x".repeat(MAX_SPEC_BYTES) }))).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: "northwind.json is over 64 KiB",
    });
    expect(createCf).not.toHaveBeenCalled();
  });

  it("refuses a spec the parser or the rules refuse, naming why, and writes nothing", async () => {
    // Every problem, each with its path.
    const invalid = add(specDir({ ...NORTHWIND, hosts: [], auth: { kind: "oauth1", secret: "NORTHWIND_ID" } }));
    await expect(invalid).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: expect.stringMatching(/^The spec isn't one this Gateway takes\n.*hosts: required: at least one host/),
    });
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining("auth.kind: must be bearer, header, query, basic or oauth2-user"),
    });
    await expect(add(specDir({ ...NORTHWIND, id: "dataforseo", auth: { kind: "bearer", secret: "DATAFORSEO_X" } }))).rejects.toMatchObject({
      code: "PROVIDER_BUILTIN",
      message: "dataforseo is built in\nA registered provider can't take a built-in provider's id.",
    });
    await expect(add(specDir({ ...NORTHWIND, auth: { kind: "bearer", secret: "OPENAI_API_KEY" } }))).rejects.toMatchObject({
      code: "PROVIDER_SECRET_TAKEN",
      message: "northwind can't use that setting: OPENAI_API_KEY doesn't start with NORTHWIND_: a provider's settings carry its own id",
    });
    await expect(add(specDir({ ...NORTHWIND, hosts: ["api.example.com"] }))).rejects.toMatchObject({
      code: "PROVIDER_HOST_REFUSED",
      message: "northwind's key can't be sent there: api.example.com is under this gateway's app domain example.com",
    });
    await expect(add(specDir({ ...NORTHWIND, hosts: ["10.0.0.1"] }))).rejects.toMatchObject({
      code: "PROVIDER_HOST_REFUSED",
      message: "northwind's key can't be sent there: 10.0.0.1 is an IP address, not a host name",
    });
    expect(await rows()).toEqual([]);
  });

  it("refuses a setting another row holds, or a registered app keeps as its own secret, naming the app", async () => {
    await add(specDir({ ...NORTHWIND, id: "northwind-connect", name: "Northwind Connect", auth: { kind: "bearer", secret: "NORTHWIND_CONNECT_KEY" } }));
    await expect(add(specDir({ ...NORTHWIND, auth: { kind: "bearer", secret: "NORTHWIND_CONNECT_KEY" } }))).rejects.toMatchObject({
      code: "PROVIDER_SECRET_TAKEN",
      message: "northwind can't use that setting: NORTHWIND_CONNECT_KEY is another registered provider's",
    });

    await registerApp("shop", { secrets: ["NORTHWIND_API_KEY"] });
    await expect(add(specDir(NORTHWIND))).rejects.toMatchObject({
      code: "PROVIDER_SECRET_TAKEN",
      message:
        "NORTHWIND_API_KEY is shop's own secret\nshop's deployed manifest lists it under secrets, so a provider can't read it from the Gateway.",
    });
    expect((await rows()).map((row) => row["id"])).toEqual(["northwind-connect"]);
  });

  it("refuses an id that has a row unless --replace, which writes the new spec and unbinds its key", async () => {
    await add(specDir(NORTHWIND));
    // As `secret set NORTHWIND_API_KEY` binds it.
    await db().run([{ sql: "UPDATE providers SET bound_to = 'bound', bound_at = 1 WHERE id = 'northwind'" }]);
    const moved = { ...NORTHWIND, hosts: ["api.northwind.io", "files.northwind.io"] };

    await expect(add(specDir(moved))).rejects.toMatchObject({
      code: "PROVIDER_EXISTS",
      message: expect.stringMatching(/^northwind is registered on this Gateway already\n/),
      rerun: expect.stringContaining("--replace"),
      authorize: true,
    });
    expect((await rows())[0]).toMatchObject({ spec: JSON.stringify(NORTHWIND), bound_to: "bound" });

    events = [];
    await add(specDir(moved), "northwind.json", { replace: true });
    expect((await rows())[0]).toMatchObject({ spec: JSON.stringify(moved), bound_to: null, bound_at: null });
    expect(done()).toMatchObject({
      message: expect.stringContaining("Replaced Northwind (northwind)"),
      data: { replaced: true, hosts: ["api.northwind.io", "files.northwind.io"] },
    });
    expect(done()!["message"]).toContain("set it again before the Gateway sends it");
  });

  it("refuses on a Gateway from before the providers table, naming the update", async () => {
    await db().run([{ sql: "DROP TABLE providers" }]);
    await expect(add(specDir(NORTHWIND))).rejects.toMatchObject({
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
    await add(specDir(NORTHWIND));
    gatewayWorker().secrets["OPENROUTER_API_KEY"] = "sk-or";
    await registerApp("shop", { capabilities: { northwind: { access: "read" } }, providers: ["openrouter"] });
    events = [];
    await list();

    const providers = done()!["data"]["providers"] as Array<Record<string, any>>;
    const ids = providers.map((provider) => provider["id"]);
    // The catalog first (no services), then the rows.
    expect(ids).toEqual(expect.arrayContaining(["openai", "openrouter", "dataforseo", "slack", "northwind"]));
    expect(ids).not.toContain("email");
    expect(providers.at(-1)).toEqual({
      id: "northwind",
      name: "Northwind",
      kind: "api key",
      hosts: ["api.northwind.io"],
      settings: [{ name: "NORTHWIND_API_KEY", set: false }],
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
    expect(providers.find((provider) => provider["id"] === "slack")).toMatchObject({
      kind: "oauth client",
      hosts: ["slack.com"],
    });
    // The social networks are presets: rows only once an operator adds one.
    expect(ids).not.toContain("linkedin");
    expect(done()).toMatchObject({
      message: `${providers.length} providers: ${providers.length - 1} built in, 1 registered`,
      data: { mcp: "pnpm everyapp mcp list" },
    });
    const shown = await human((sink) => listProviders({ flags: {}, out: sink, createCf }));
    expect(shown).toMatch(/^ID +NAME +KIND +HOSTS +SETTINGS +SOURCE +APPS\n/);
    expect(shown).toMatch(
      /\nnorthwind +Northwind +api key +api\.northwind\.io +NORTHWIND_API_KEY not set, not bound +registered by dev@example\.com +shop\n/,
    );
    expect(shown).toMatch(/\nopenrouter +OpenRouter +ai +openrouter\.ai +OPENROUTER_API_KEY set +catalog +shop\n/);
    // Through launch week, where the MCP apps went.
    expect(shown).toMatch(/\n\nMCP apps: pnpm everyapp mcp list\n/);
  });

  it("says which rows the Gateway doesn't serve, and why", async () => {
    await db().run([
      {
        sql: "INSERT INTO providers (id, spec, added_by, added_at, updated_at) VALUES ('evil', ?, 'x@example.com', 1, 1)",
        params: [JSON.stringify({ ...NORTHWIND, id: "evil", name: "Evil", auth: { kind: "bearer", secret: "JWT_PRIVATE_KEY" } })],
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
    await add(specDir(NORTHWIND));
    await registerApp("shop", { capabilities: { northwind: { access: "read" } } });
    events = [];
    await show("northwind");
    const parsed = parseProviderSpec(NORTHWIND);
    if (!parsed.ok) throw new Error("the spec parses");
    expect(done()).toMatchObject({
      message: "Northwind (northwind)",
      data: {
        provider: providerSpecOf("northwind", parsed.capability),
        source: "row",
        bound: false,
        addedBy: "dev@example.com",
        addedAt: expect.any(Number),
        apps: ["shop"],
        next: [{ command: "pnpm everyapp secret set NORTHWIND_API_KEY" }],
      },
    });
    const shown = await human((sink) => showProvider({ flags: {}, out: sink, createCf }, "northwind"));
    expect(shown).toContain('"hosts": [\n    "api.northwind.io"\n  ]');
    expect(shown).toContain("Registered by dev@example.com on ");
    expect(shown).toContain("its key isn't set for these hosts yet.\nUsed by shop.");

    // Once its key is bound, nothing is next.
    await db().run([
      { sql: "UPDATE providers SET bound_to = ? WHERE id = 'northwind'", params: [providerBindingKey(parsed.capability)] },
    ]);
    events = [];
    await show("northwind");
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
    await show("slack");
    expect(done()!["data"]["provider"]).toMatchObject({
      id: "slack",
      kind: "oauth client",
      settings: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
      tokenEndpoints: ["POST https://slack.com/api/oauth.v2.access"],
    });
    expect(done()!["data"]["provider"]).not.toHaveProperty("redirectPaths");
    expect(done()!["data"]["appRedirectUris"]).toEqual([]);
  });

  it("lists the callbacks the apps using an OAuth client declare, on each app's host", async () => {
    await registerApp("crm", {
      capabilities: {
        slack: {
          access: "write",
          scopes: ["messages.write"],
          redirectPaths: ["/integrations/slack/callback"],
        },
      },
    });
    await show("slack");
    const uris = done()!["data"]["appRedirectUris"] as string[];
    expect(uris).toHaveLength(1);
    expect(uris[0]).toMatch(/^https:\/\/crm\.[^/]+\/integrations\/slack\/callback$/);
    const shown = await human((sink) => showProvider({ flags: {}, out: sink, createCf }, "slack"));
    expect(shown).toContain(`Apps that run the flow themselves list these callbacks; register them too: ${uris[0]}`);
  });

  it("refuses an id the Gateway doesn't offer, and a service", async () => {
    await expect(show("nope")).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
      message: "nope isn't a provider this Gateway offers",
      rerun: "pnpm everyapp provider list",
    });
    await expect(show("email")).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
      message: expect.stringMatching(/^email is a Gateway service, not a provider/),
    });
  });

  it("with --save, writes a registered provider's spec in an app's directory, and nowhere else", async () => {
    await add(specDir(NORTHWIND));
    await expect(show("northwind", tempDir("everyapp-provider-none-"), true)).rejects.toMatchObject({
      code: "MANIFEST_NOT_FOUND",
    });
    const dir = appDir();
    await expect(show("dataforseo", dir, true)).rejects.toMatchObject({
      code: "PROVIDER_BUILTIN",
      message: "dataforseo is built in\neveryapp dev reaches it without a file. Nothing was written.",
    });
    events = [];
    await show("northwind", dir, true);
    expect(fs.existsSync(path.join(dir, ".everyapp", "providers", "northwind.json"))).toBe(true);
    expect(done()!["data"]["saved"]).toBe(".everyapp/providers/northwind.json");
  });
});

describe("provider remove", () => {
  it("refuses a built-in id, an id with no row, and a row a registered app lists unless --force", async () => {
    await expect(remove("dataforseo")).rejects.toMatchObject({ code: "PROVIDER_BUILTIN" });
    await expect(remove("northwind")).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
      message: "No provider northwind is registered on this Gateway",
    });
    await add(specDir(NORTHWIND));
    await registerApp("shop", { capabilities: { northwind: { access: "read" } } });
    await expect(remove("northwind")).rejects.toMatchObject({
      code: "PROVIDER_IN_USE",
      message: expect.stringMatching(/^shop lists northwind under capabilities\n/),
      rerun: expect.stringContaining("--force"),
      authorize: true,
    });
    expect((await rows()).map((row) => row["id"])).toEqual(["northwind"]);

    gatewayWorker().secrets["NORTHWIND_API_KEY"] = "sk_live";
    events = [];
    await remove("northwind", true);
    expect(await rows()).toEqual([]);
    expect(done()).toMatchObject({
      data: {
        id: "northwind",
        name: "Northwind",
        removed: true,
        settings: [{ name: "NORTHWIND_API_KEY", set: true }],
        apps: ["shop"],
        next: [{ command: "pnpm everyapp secret unset NORTHWIND_API_KEY" }],
      },
    });
    // The Gateway's setting stays until it is unset.
    expect(gatewayWorker().secrets["NORTHWIND_API_KEY"]).toBe("sk_live");
    expect(done()!["message"]).toContain(
      "NORTHWIND_API_KEY stays on the Gateway, read by nothing: pnpm everyapp secret unset NORTHWIND_API_KEY removes it.",
    );
  });
});

describe("provider events", () => {
  const ORG = "org-1";

  /** The install organization, and a webhook subscribed to everything. */
  async function organizationWithSubscriber() {
    await db().run([
      { sql: "INSERT INTO organizations (id, name, slug, created_at) VALUES (?, 'Acme', 'acme', 0)", params: [ORG] },
      {
        sql: "INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, events, enabled, created_at, updated_at) VALUES ('sub_all', ?, 'all', 'webhook', 'https://hooks.example.org/x', 'whsec_x', '[\"*\"]', 1, 0, 0)",
        params: [ORG],
      },
    ]);
  }

  const eventRows = async () =>
    ((await db().run([{ sql: "SELECT id, organization_id, type, actor, data FROM events ORDER BY time, id" }]))[0] ?? []).map(
      (row) => ({
        id: row["id"],
        organization: row["organization_id"],
        type: row["type"],
        actor: JSON.parse(String(row["actor"])),
        data: JSON.parse(String(row["data"])),
      }),
    );
  const deliveryRows = async () =>
    (await db().run([{ sql: "SELECT event_id, subscription_id, status FROM event_deliveries ORDER BY created_at, id" }]))[0] ?? [];

  it("provider add queues one provider.added in its batch, a replace another, and a refused add nothing", async () => {
    await organizationWithSubscriber();
    await add(specDir(NORTHWIND));

    const [added, ...none] = await eventRows();
    expect(none).toEqual([]);
    expect(added).toMatchObject({
      organization: ORG,
      type: "provider.added",
      actor: { kind: "operator", id: "dev@example.com" },
      data: { provider: { id: "northwind", name: "Northwind", kind: "api_key" } },
    });
    expect(await deliveryRows()).toEqual([{ event_id: added!.id, subscription_id: "sub_all", status: "pending" }]);

    // Refused: the id has a row, a built-in id, a setting another row holds.
    await expect(add(specDir(NORTHWIND))).rejects.toMatchObject({ code: "PROVIDER_EXISTS" });
    await expect(add(specDir({ ...NORTHWIND, id: "dataforseo", auth: { kind: "bearer", secret: "DATAFORSEO_X" } }))).rejects.toMatchObject({
      code: "PROVIDER_BUILTIN",
    });
    await expect(
      add(specDir({ ...NORTHWIND, id: "northwind-connect", auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" } })),
    ).rejects.toMatchObject({ code: "PROVIDER_SECRET_TAKEN" });
    expect(await eventRows()).toHaveLength(1);

    await add(specDir({ ...NORTHWIND, name: "Northwind Billing" }), "northwind.json", { replace: true });
    expect((await eventRows()).map((event) => [event.type, event.data])).toEqual([
      ["provider.added", { provider: { id: "northwind", name: "Northwind", kind: "api_key" } }],
      ["provider.added", { provider: { id: "northwind", name: "Northwind Billing", kind: "api_key" } }],
    ]);
  });

  it("provider remove queues one provider.removed in its batch, and a refused remove nothing", async () => {
    await organizationWithSubscriber();
    await add(specDir(NORTHWIND));
    await registerApp("shop", { capabilities: { northwind: { access: "read" } } });

    // Refused: a built-in id, an id with no row, a row an app lists without --force.
    await expect(remove("dataforseo")).rejects.toMatchObject({ code: "PROVIDER_BUILTIN" });
    await expect(remove("northwind-connect")).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    await expect(remove("northwind")).rejects.toMatchObject({ code: "PROVIDER_IN_USE" });
    expect((await eventRows()).map((event) => event.type)).toEqual(["provider.added"]);

    await remove("northwind", true);
    expect(await rows()).toEqual([]);
    const removed = (await eventRows()).filter((event) => event.type === "provider.removed");
    expect(removed).toEqual([
      expect.objectContaining({
        organization: ORG,
        actor: { kind: "operator", id: "dev@example.com", email: "dev@example.com" },
        data: { provider: { id: "northwind", name: "Northwind", kind: "api_key" } },
      }),
    ]);
    expect((await deliveryRows()).filter((delivery) => delivery["event_id"] === removed[0]!.id)).toEqual([
      { event_id: removed[0]!.id, subscription_id: "sub_all", status: "pending" },
    ]);

    // Gone: a second remove is refused and queues nothing.
    await expect(remove("northwind", true)).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    expect((await eventRows()).filter((event) => event.type === "provider.removed")).toHaveLength(1);
  });

  it("writes the row and queues nothing on a Gateway without the event tables, or before it has an organization", async () => {
    // No organization yet: the registry changes, nothing is queued.
    await add(specDir(NORTHWIND));
    await remove("northwind");
    expect(await eventRows()).toEqual([]);

    await organizationWithSubscriber();
    await db().run([{ sql: "DROP TABLE event_deliveries" }, { sql: "DROP TABLE events" }, { sql: "DROP TABLE event_subscriptions" }]);
    await add(specDir(NORTHWIND));
    expect((await rows()).map((row) => row["id"])).toEqual(["northwind"]);
    await remove("northwind");
    expect(await rows()).toEqual([]);
    const [tables = []] = await db().run([{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'event%'" }]);
    expect(tables).toEqual([]);
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

describe("provider add --oauth, presets, connections and disconnect", () => {
  const GITHUB = OAUTH_PRESETS["github-oauth"]!;
  const githubCapability = () => oauthPreset("github-oauth")!;
  const githubConsole = () => {
    const capability = githubCapability();
    return capability.mode === "oauth_client" ? capability.console : "";
  };
  const addOAuthProvider = (
    value: string,
    options: {
      clientId?: string;
      stdin?: string | null;
      env?: Record<string, string>;
      fromEnv?: boolean;
      replace?: boolean;
      cwd?: string;
    } = {},
  ) =>
    addOAuth(
      {
        flags: {
          ...flags,
          oauth: value,
          ...(options.clientId ? { "client-id": options.clientId } : {}),
          ...(options.fromEnv ? { "from-env": true } : {}),
          ...(options.replace ? { replace: true } : {}),
        },
        out: out(),
        cwd: options.cwd ?? tempDir("everyapp-provider-oauth-"),
        createCf,
        readStdin: async () => options.stdin ?? null,
        env: options.env ?? {},
      },
      value,
    );
  const connections = (extra: { all?: boolean; user?: string; provider?: string } = {}) =>
    listProviderConnections({ flags: { ...flags, ...extra }, out: out(), createCf });
  const disconnect = (id: string, extra: { user?: string; organization?: boolean; all?: boolean } = {}) =>
    disconnectProvider({ flags: { ...flags, ...extra }, out: out(), createCf }, id);

  /** The deployer as a member row (registering an app makes the organization, not the person). */
  async function devUserId(): Promise<string> {
    await db().run([
      { sql: "INSERT OR IGNORE INTO users (id, name, email, email_verified) VALUES ('u_dev', 'Dev', 'dev@example.com', 1)" },
    ]);
    return "u_dev";
  }
  /** The install organization's id. */
  async function orgId(): Promise<string> {
    const [found = []] = await db().run([{ sql: "SELECT id FROM organizations LIMIT 1" }]);
    return String(found[0]!["id"]);
  }
  /** A connection as the Gateway's callback writes one (the token columns hold sealed text the CLI never reads). */
  async function seedConnection(providerId: string, account: "user" | "organization", userId: string | null, label: string) {
    await db().run([
      {
        sql: `INSERT INTO provider_connections (id, organization_id, provider_id, account_kind, subject, user_id, label, external_id, scope_sets, scopes, access_token_enc, refresh_token_enc, expires_at, status, created_at, updated_at, last_used_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, 'v1.sealed.access', 'v1.sealed.refresh', NULL, 'active', ?10, ?10, NULL)`,
        params: [
          `conn_${label}`,
          await orgId(),
          providerId,
          account,
          account === "organization" ? "organization" : userId!,
          account === "organization" ? null : userId,
          label,
          JSON.stringify(["identity", "repo.read"]),
          JSON.stringify(["read:user", "repo"]),
          Date.now(),
        ],
      },
    ]);
  }
  const connectionRows = async () =>
    (await db().run([{ sql: "SELECT id, provider_id, account_kind FROM provider_connections ORDER BY id" }]))[0] ?? [];
  const uploadClient = () =>
    db().run([
      {
        sql: "INSERT INTO oauth_clients (provider_id, client_id, client_secret_enc, bound_to, added_by, added_at, updated_at) VALUES ('github-oauth', 'Iv1.ui', 'v1.sealed', 'x', 'owner@example.com', 1, 1)",
      },
    ]);

  it("lists the presets and the built-in clients without reaching the Gateway", async () => {
    createCf.mockClear();
    await listPresets({ out: out() });
    expect(createCf).not.toHaveBeenCalled();
    const presets = done()!["data"]["presets"] as Array<Record<string, any>>;
    expect(presets.find((preset) => preset["id"] === "github-oauth")).toMatchObject({
      name: "GitHub",
      builtIn: false,
      settings: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
      console: expect.stringMatching(/^https:\/\/github\.com\//),
    });
    expect(presets.find((preset) => preset["id"] === "google-workspace")).toMatchObject({ builtIn: true });
    expect(presets.find((preset) => preset["id"] === "github-oauth")!["scopeSets"].map((set: { name: string }) => set.name)).toContain("identity");
    // The built-in clients come first, every one with a Gateway flow.
    expect(presets.findIndex((preset) => preset["builtIn"])).toBe(0);
    expect(done()!["data"]["next"][0]["command"]).toBe("pnpm everyapp provider add --oauth github-oauth");
  });

  it("registers a preset as a row, prints the redirect URI and the secret set to run, and leaves the client unset", async () => {
    // An organization, so the event has somewhere to go.
    await registerApp("shop", {});
    await addOAuthProvider("github-oauth");
    expect(await rows()).toEqual([
      { id: "github-oauth", spec: JSON.stringify(GITHUB), added_by: "dev@example.com", bound_to: null, bound_at: null },
    ]);
    expect(steps("provider.redirect")[0]).toMatchObject({
      data: { id: "github-oauth", redirectUri: "https://example.com/connect/github-oauth/callback", console: githubConsole() },
    });
    expect(done()).toMatchObject({
      message: expect.stringContaining(
        "Registered GitHub (github-oauth) on example.com.\n1. Register this redirect URI at https://github.com/settings/developers:\n   https://example.com/connect/github-oauth/callback\n2. Set the client it gives you with the command below.\nDocs: https://everyapp.com/docs/providers/github",
      ),
      data: {
        id: "github-oauth",
        name: "GitHub",
        kind: "oauth",
        source: "row",
        replaced: false,
        flow: "both",
        redirectUri: "https://example.com/connect/github-oauth/callback",
        settings: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
        client: { source: "none" },
        connections: 0,
        docs: "https://everyapp.com/docs/providers/github",
        next: [{ command: "pnpm everyapp secret set GITHUB_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_SECRET" }],
      },
    });
    expect(done()!["data"]["scopeSets"].map((set: { name: string }) => set.name)).toContain("identity");
    expect(gatewayWorker().secrets["GITHUB_OAUTH_CLIENT_ID"]).toBeUndefined();
    // Its event names the kind.
    const [queued = []] = await db().run([{ sql: "SELECT type, data FROM events WHERE type = 'provider.added'" }]);
    expect(queued.map((row) => JSON.parse(String(row["data"])))).toEqual([
      { provider: { id: "github-oauth", name: "GitHub", kind: "oauth" } },
    ]);
  });

  it("sets the client in the same run from --client-id and a piped secret, or from the environment, binding the row; never half a client", async () => {
    await addOAuthProvider("github-oauth", { clientId: "Iv1.abc", stdin: "GITHUB_OAUTH_CLIENT_SECRET=shh-secret\n" });
    expect(gatewayWorker().secrets).toMatchObject({ GITHUB_OAUTH_CLIENT_ID: "Iv1.abc", GITHUB_OAUTH_CLIENT_SECRET: "shh-secret" });
    expect((await rows())[0]).toMatchObject({ id: "github-oauth", bound_to: providerBindingKey(githubCapability()) });
    expect(done()).toMatchObject({
      message: expect.stringContaining("Apps can now list github-oauth. Live now, no deploy needed."),
      data: { client: { source: "env" } },
    });
    expect(done()!["data"]["next"]).toBeUndefined();
    // The value never appears in any event.
    expect(JSON.stringify(events)).not.toContain("shh-secret");

    // Half a client: refused, nothing set, the row stays (replaced, so unbound).
    events = [];
    delete gatewayWorker().secrets["GITHUB_OAUTH_CLIENT_ID"];
    delete gatewayWorker().secrets["GITHUB_OAUTH_CLIENT_SECRET"];
    await expect(addOAuthProvider("github-oauth", { clientId: "Iv1.other", replace: true })).rejects.toMatchObject({
      code: "PROVIDER_CLIENT_INCOMPLETE",
      message: expect.stringMatching(/^GitHub's client needs GITHUB_OAUTH_CLIENT_SECRET too\n/),
    });
    expect(gatewayWorker().secrets["GITHUB_OAUTH_CLIENT_ID"]).toBeUndefined();
    expect((await rows())[0]).toMatchObject({ id: "github-oauth", bound_to: null });

    // From the environment, both names.
    events = [];
    await addOAuthProvider("github-oauth", {
      fromEnv: true,
      replace: true,
      env: { GITHUB_OAUTH_CLIENT_ID: "Iv1.env", GITHUB_OAUTH_CLIENT_SECRET: "env-secret" },
    });
    expect(gatewayWorker().secrets).toMatchObject({ GITHUB_OAUTH_CLIENT_ID: "Iv1.env", GITHUB_OAUTH_CLIENT_SECRET: "env-secret" });
    expect((await rows())[0]).toMatchObject({ bound_to: providerBindingKey(githubCapability()) });

    // A piped line that isn't the client's is refused without being echoed; a bare value too.
    await expect(addOAuthProvider("github-oauth", { replace: true, stdin: "OPENAI_API_KEY=sk\n" })).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
    });
    await expect(addOAuthProvider("github-oauth", { replace: true, stdin: "sk-bare-value\n" })).rejects.toMatchObject({
      code: "PIPED_LINE_INVALID",
    });
  });

  it("takes a built-in client without a row, a custom spec file, and refuses what isn't an OAuth preset", async () => {
    await addOAuthProvider("google-workspace");
    expect(await rows()).toEqual([]);
    expect(done()).toMatchObject({
      message: expect.stringContaining("Google (google-workspace) is on example.com."),
      data: {
        id: "google-workspace",
        kind: "oauth",
        source: "catalog",
        flow: "both",
        redirectUri: "https://example.com/connect/google-workspace/callback",
        settings: [...capabilitySettings(CAPABILITIES["google-workspace"])],
        client: { source: "none" },
      },
    });

    const auth = { ...(GITHUB["auth"] as Record<string, unknown>) };
    delete auth["identity"];
    delete auth["revokeUrl"];
    delete auth["revokeMethod"];
    const custom = {
      ...GITHUB,
      id: "acme",
      name: "Acme",
      docs: "https://developer.acme.test/apps",
      hosts: ["api.acme.test"],
      auth: {
        ...auth,
        authorizeUrl: "https://auth.acme.test/authorize",
        tokenUrl: "https://auth.acme.test/token",
        clientId: "ACME_CLIENT_ID",
        clientSecret: "ACME_CLIENT_SECRET",
      },
    };
    const dir = specDir(custom, "acme.json");
    events = [];
    await addOAuthProvider("./acme.json", { cwd: dir });
    expect((await rows()).map((row) => row["id"])).toEqual(["acme"]);
    expect(done()!["data"]).toMatchObject({
      id: "acme",
      kind: "oauth",
      redirectUri: "https://example.com/connect/acme/callback",
      settings: ["ACME_CLIENT_ID", "ACME_CLIENT_SECRET"],
    });

    await expect(addOAuthProvider("nothing")).rejects.toMatchObject({
      code: "PROVIDER_PRESET_UNKNOWN",
      message: expect.stringMatching(/^No OAuth preset nothing\nPresets: /),
      rerun: "pnpm everyapp provider presets",
    });
    await expect(addOAuthProvider("dataforseo")).rejects.toMatchObject({ code: "PROVIDER_PRESET_UNKNOWN" });
    // An API-key spec through --oauth: refused before any row.
    const apiKey = specDir(NORTHWIND);
    await expect(addOAuthProvider("./northwind.json", { cwd: apiKey })).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: expect.stringMatching(/^\.\/northwind\.json is an API-key spec/),
    });
    expect((await rows()).map((row) => row["id"])).toEqual(["acme"]);
  });

  it("shows and lists an OAuth row with its redirect URI, flow, client source and connections", async () => {
    await addOAuthProvider("github-oauth");
    await registerApp("shop", { capabilities: { "github-oauth": { access: "read", scopes: ["identity"] } } });
    await seedConnection("github-oauth", "user", await devUserId(), "ben");
    events = [];
    await show("github-oauth");
    expect(done()).toMatchObject({
      data: {
        provider: providerSpecOf("github-oauth", githubCapability()),
        source: "row",
        bound: false,
        flow: "both",
        redirectUri: "https://example.com/connect/github-oauth/callback",
        client: { source: "none" },
        connections: 1,
        apps: ["shop"],
        next: [{ command: "pnpm everyapp secret set GITHUB_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_SECRET" }],
      },
    });
    expect(done()!["message"]).toBe("GitHub (github-oauth)");
    const shown = await human((sink) => showProvider({ flags: {}, out: sink, cwd: tempDir("everyapp-provider-x-"), createCf }, "github-oauth"));
    expect(shown).toContain("Redirect URI to register at");
    expect(shown).toContain("1 connected; people connect at https://example.com/connect/github-oauth.");

    // An uploaded client (Admin → Providers) reads as set, without a bound row.
    await uploadClient();
    events = [];
    await list();
    const github = (done()!["data"]["providers"] as Array<Record<string, any>>).find((provider) => provider["id"] === "github-oauth")!;
    expect(github).toMatchObject({ kind: "oauth client", flow: "both", client: { source: "uploaded", clientId: "Iv1.ui" }, connections: 1, apps: ["shop"] });
    const table = await human((sink) => listProviders({ flags: {}, out: sink, createCf }));
    expect(table).toMatch(/github-oauth\s+GitHub\s+oauth\s+\S+\s+client uploaded, 1 connected/);
    // The secret set hint is gone once a client is uploaded.
    events = [];
    await show("github-oauth");
    expect(done()!["data"]["next"]).toBeUndefined();
  });

  it("lists connections (never a token), by provider or person, and disconnects a person's, the organization's or all, queueing the event", async () => {
    await addOAuthProvider("github-oauth");
    await registerApp("shop", {});
    const userId = await devUserId();
    await seedConnection("github-oauth", "user", userId, "ben");
    await seedConnection("github-oauth", "organization", null, "acme-bot");
    await seedConnection("google-workspace", "user", userId, "ben-google");

    events = [];
    await connections();
    const listed = done()!["data"]["connections"] as Array<Record<string, any>>;
    expect(listed.map((each) => [each["provider"], each["account"], each["label"], each["userEmail"] ?? null]).sort()).toEqual([
      ["github-oauth", "organization", "acme-bot", null],
      ["github-oauth", "user", "ben", "dev@example.com"],
      ["google-workspace", "user", "ben-google", "dev@example.com"],
    ]);
    expect(listed[0]).toMatchObject({ providerName: expect.any(String), scopeSets: ["identity", "repo.read"], status: "active" });
    expect(JSON.stringify(events)).not.toContain("sealed");
    events = [];
    await connections({ provider: "google-workspace" });
    expect((done()!["data"]["connections"] as unknown[]).length).toBe(1);
    events = [];
    await connections({ user: "DEV@example.com" });
    expect((done()!["data"]["connections"] as unknown[]).length).toBe(2);
    const table = await human((sink) => listProviderConnections({ flags: {}, out: sink, createCf }));
    expect(table).toContain("the organization");
    expect(table).toContain("dev@example.com");

    await expect(disconnect("github-oauth")).rejects.toMatchObject({ code: "PROVIDER_CONNECTION_WHICH" });
    await expect(disconnect("github-oauth", { user: "x@example.com", organization: true })).rejects.toMatchObject({
      code: "PROVIDER_CONNECTION_WHICH",
    });
    await expect(disconnect("northwind", { all: true })).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    await expect(disconnect("github-oauth", { user: "nobody@example.com" })).rejects.toMatchObject({
      code: "PROVIDER_CONNECTION_NOT_FOUND",
      rerun: "pnpm everyapp provider connections --provider github-oauth",
    });

    events = [];
    await disconnect("github-oauth", { user: "dev@example.com" });
    expect(done()).toMatchObject({
      message: expect.stringContaining("Removed dev@example.com's connection to GitHub (github-oauth)."),
      data: {
        id: "github-oauth",
        revoked: false,
        revokeAt: expect.stringMatching(/^https:\/\/github\.com/),
        removed: [expect.objectContaining({ account: "user", label: "ben" })],
      },
    });
    expect((await connectionRows()).map((row) => row["id"])).toEqual(["conn_acme-bot", "conn_ben-google"]);
    const [queued = []] = await db().run([{ sql: "SELECT data FROM events WHERE type = 'provider.disconnected'" }]);
    expect(queued.map((row) => JSON.parse(String(row["data"])))).toEqual([
      {
        provider: { id: "github-oauth", name: "GitHub" },
        account: { kind: "user", user: { id: userId, email: "dev@example.com" }, label: "ben" },
        revoked: false,
      },
    ]);

    events = [];
    await disconnect("github-oauth", { organization: true });
    expect(done()!["data"]["removed"]).toEqual([expect.objectContaining({ account: "organization", label: "acme-bot" })]);
    await expect(disconnect("github-oauth", { all: true })).rejects.toMatchObject({ code: "PROVIDER_CONNECTION_NOT_FOUND" });
    events = [];
    await disconnect("google-workspace", { all: true });
    expect(await connectionRows()).toEqual([]);
  });

  it("removes an OAuth row with its connections and its uploaded client, and counts them", async () => {
    await registerApp("shop", {});
    await addOAuthProvider("github-oauth");
    await seedConnection("github-oauth", "organization", null, "acme-bot");
    await uploadClient();
    events = [];
    await remove("github-oauth");
    expect(await rows()).toEqual([]);
    expect(await connectionRows()).toEqual([]);
    expect((await db().run([{ sql: "SELECT provider_id FROM oauth_clients" }]))[0]).toEqual([]);
    expect(done()).toMatchObject({
      message: expect.stringContaining("1 connection to it was deleted"),
      data: { id: "github-oauth", removed: true, connections: 1, client: true },
    });
    expect(done()!["message"]).toContain("The client uploaded under Admin → Providers was deleted with it.");
  });
});


describe("provider add, one step: the key or client asked for in the same run", () => {
  /** Answers each prompt from `answers` by setting name (missing: Enter on nothing), and records the questions. */
  function asker(answers: Record<string, string>) {
    const asked: string[] = [];
    return {
      asked,
      ask: async (name: string, question: string) => {
        asked.push(question);
        return answers[name] ?? "";
      },
    };
  }
  const run = (
    spec: string,
    options: {
      interactive?: boolean;
      ask?: (name: string, question: string) => Promise<string>;
      env?: Record<string, string>;
      fromEnv?: boolean;
      verbose?: boolean;
      stdin?: string;
    } = {},
  ) => (sink: EventSink) =>
    addAny(
      {
        flags: { ...(options.fromEnv ? { "from-env": true } : {}), ...(options.verbose ? { verbose: true } : {}) },
        out: sink,
        createCf,
        cwd: tempDir("everyapp-provider-one-step-"),
        readStdin: async () => options.stdin ?? null,
        env: options.env ?? {},
        interactive: options.interactive ?? false,
        ...(options.ask ? { ask: options.ask } : {}),
      },
      spec,
    );

  it("at a terminal, provider add google-workspace says the one thing to do, asks for the client and sets it", async () => {
    const { asked, ask } = asker({
      GOOGLE_WORKSPACE_CLIENT_ID: "1234.apps.googleusercontent.com",
      GOOGLE_WORKSPACE_CLIENT_SECRET: "GOCSPX-shh",
    });
    const shown = await human(run("google-workspace", { interactive: true, ask }));
    expect(shown).toBe(
      [
        "Google (google-workspace) is on example.com.",
        "1. Register this redirect URI at https://console.cloud.google.com/apis/credentials:",
        "   https://example.com/connect/google-workspace/callback",
        "2. Paste the OAuth client it gives you.",
        "Docs: https://everyapp.com/docs/providers/google",
        "Set GOOGLE_WORKSPACE_CLIENT_ID and GOOGLE_WORKSPACE_CLIENT_SECRET on the Gateway ✓",
        "Apps can now list google-workspace. Live now, no deploy needed.",
        "",
      ].join("\n"),
    );
    expect(asked).toEqual(["Client id", "Client secret"]);
    expect(gatewayWorker().secrets).toMatchObject({
      GOOGLE_WORKSPACE_CLIENT_ID: "1234.apps.googleusercontent.com",
      GOOGLE_WORKSPACE_CLIENT_SECRET: "GOCSPX-shh",
    });
    expect(shown).not.toContain("GOCSPX-shh");

    // Run again: the client is set, so nothing is asked.
    const again = asker({});
    const second = await human(run("google-workspace", { interactive: true, ask: again.ask }));
    expect(again.asked).toEqual([]);
    expect(second).toContain("Its client is set: people connect at https://example.com/connect/google-workspace. Apps can list google-workspace.");
  });

  it("asks which Gateway once when the account has two, though the key's step opens the Gateway again", async () => {
    // A second, named Gateway beside the default (multi-gateway, #867).
    const install = (await readInstall(db()))!;
    const demo = account.createDatabase("every-app-gateway-demo");
    await writeInstall(cfD1Database(account.cf, demo.uuid), { ...install, gatewayHost: "demo.example.com" });
    terminal.on = true;
    const { asked, ask } = asker({ GRANOLA_API_KEY: "grn-shh" });

    await human(run("granola", { interactive: true, ask }));

    expect(terminal.picks).toBe(1);
    expect(asked).toEqual(["GRANOLA_API_KEY"]);
    expect(gatewayWorker().secrets["GRANOLA_API_KEY"]).toBe("grn-shh");
  });

  it("Enter on nothing sets nothing and names the one command next, exiting cleanly", async () => {
    // The id typed, the secret not: never half a client.
    const { ask } = asker({ GOOGLE_WORKSPACE_CLIENT_ID: "1234.apps.googleusercontent.com" });
    const shown = await human(run("google-workspace", { interactive: true, ask }));
    expect(gatewayWorker().secrets["GOOGLE_WORKSPACE_CLIENT_ID"]).toBeUndefined();
    expect(shown).toContain("\nNext:\n  pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET\n");
    expect(shown).not.toContain("Apps can now");
  });

  it("unattended, says the steps and the command next; the scope sets and manifest entry only with --verbose", async () => {
    expect(await human(run("google-workspace"))).toBe(
      [
        "Google (google-workspace) is on example.com.",
        "1. Register this redirect URI at https://console.cloud.google.com/apis/credentials:",
        "   https://example.com/connect/google-workspace/callback",
        "2. Set the client it gives you with the command below.",
        "Docs: https://everyapp.com/docs/providers/google",
        "",
        "Next:",
        "  pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET",
        "",
      ].join("\n"),
    );
    const verbose = await human(run("google-workspace", { verbose: true }));
    expect(verbose).toContain("Scope sets: identity: Google account (who you are); gmail.read: Gmail (read-only);");
    expect(verbose).toContain('In an app\'s capabilities: { "google-workspace": { access: "read", scopes: ["identity", "gmail.read"], why: "..." } }');
    expect(gatewayWorker().secrets["GOOGLE_WORKSPACE_CLIENT_ID"]).toBeUndefined();
  });

  it("provider add <id> of an API-key provider: where the key comes from, the key asked for and set", async () => {
    const { asked, ask } = asker({ OPENROUTER_API_KEY: "sk-or-shh" });
    expect(await human(run("openrouter", { interactive: true, ask }))).toBe(
      [
        "OpenRouter (openrouter) is on example.com.",
        "1. Create a key at https://openrouter.ai/settings/keys",
        "2. Paste it below.",
        "Docs: https://everyapp.com/docs/providers/openrouter",
        "Set OPENROUTER_API_KEY on the Gateway ✓",
        "Apps can now list openrouter under providers. Live now, no deploy needed.",
        "",
      ].join("\n"),
    );
    expect(asked).toEqual(["OPENROUTER_API_KEY"]);
    expect(gatewayWorker().secrets["OPENROUTER_API_KEY"]).toBe("sk-or-shh");

    // Unattended: the key isn't asked for; --json data names the command next.
    events = [];
    await run("dataforseo")(out());
    expect(done()).toMatchObject({
      message:
        "DataForSEO (dataforseo) is on example.com.\n1. Create a key at https://app.dataforseo.com/api-access\n2. Set it with the command below.\nDocs: https://everyapp.com/docs/providers/dataforseo",
      data: {
        id: "dataforseo",
        name: "DataForSEO",
        kind: "api_key",
        source: "catalog",
        hosts: expect.any(Array),
        settings: ["DATAFORSEO_API_KEY"],
        docs: "https://everyapp.com/docs/providers/dataforseo",
        keySet: false,
        next: [{ command: "pnpm everyapp secret set DATAFORSEO_API_KEY" }],
      },
    });
    expect(steps("provider.setup")[0]).toMatchObject({ data: { id: "dataforseo", docs: "https://everyapp.com/docs/providers/dataforseo" } });
  });

  it("--from-env sets every setting from the variables of their names; part of them is refused, nothing set", async () => {
    events = [];
    await run("dataforseo", { fromEnv: true, env: { DATAFORSEO_API_KEY: "login:pass" } })(out());
    expect(gatewayWorker().secrets["DATAFORSEO_API_KEY"]).toBe("login:pass");
    expect(done()).toMatchObject({ data: { keySet: true } });
    expect(done()!["data"]["next"]).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("login:pass");

    // A setting the Gateway has already (CLOUDFLARE_ACCOUNT_ID) isn't needed again.
    expect(gatewayWorker().secrets["CLOUDFLARE_ACCOUNT_ID"]).toBeDefined();
    await run("workers-ai", { fromEnv: true, env: { WORKERS_AI_API_TOKEN: "cf-token" } })(out());
    expect(gatewayWorker().secrets["WORKERS_AI_API_TOKEN"]).toBe("cf-token");

    await expect(run("ai-gateway", { fromEnv: true, env: { AI_GATEWAY_API_KEY: "gw-token" } })(out())).rejects.toMatchObject({
      code: "PROVIDER_CLIENT_INCOMPLETE",
      message: expect.stringMatching(/^Cloudflare AI Gateway's key needs AI_GATEWAY_ID too\nNothing was set; the provider is built in\.$/),
    });
    expect(gatewayWorker().secrets["AI_GATEWAY_API_KEY"]).toBeUndefined();
  });

  it("routes an OAuth preset's id and a spec file, and refuses an unknown id and a service", async () => {
    await run("github-oauth")(out());
    expect((await rows()).map((row) => row["id"])).toEqual(["github-oauth"]);
    expect(done()).toMatchObject({ data: { id: "github-oauth", kind: "oauth" } });

    await expect(run("nothing-here")(out())).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
      message: expect.stringMatching(/^nothing-here isn't a built-in provider\n/),
      rerun: "pnpm everyapp provider list",
    });
    await expect(run("email")(out())).rejects.toMatchObject({ code: "PROVIDER_BUILTIN" });
  });
});
