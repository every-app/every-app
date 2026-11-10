/**
 * `everyapp mcp add|remove|on|off|list|show|refresh|tool` end to end, in a
 * fake Cloudflare account with a deployed gateway (as secret/index.test.ts):
 * the rows (the app's and its own provider row), the access, the probe
 * first (a credential refused before anything is written, OAuth chosen
 * from the 401), OAuth discovery and client registration, the credential
 * offered, set through secret set's path, bound and checked, each
 * credential's state as a warning and in the list, the tools a show
 * reads, how secret set, secret list, delete and status treat MCP apps, and
 * the `mcp_app.*` event each change queues for the Gateway to deliver.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { existingGateway } from "@/lib/gateway/connect";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { removeApp as deleteApp } from "../delete";
import { listSecrets, setSecrets, unsetSecrets } from "../secret";
import { reportStatus } from "../status";
import {
  addServer,
  changeTool,
  listMcp,
  refreshApp,
  removeApp,
  showApp,
  turnOff,
  turnOn,
  type AddFlags,
  type McpOptions,
  type ToolFlags,
} from "./index";

const GATEWAY = "every-app-gateway";
const TREG = "https://treg.to/mcp/";
/** The fake Cloudflare login's email: who the rows and pins record. */
const ACTOR = "dev@example.com";

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
const done = () => events.findLast((event) => event["type"] === "done");
const warnings = (code: string) =>
  events.filter((event) => event["type"] === "warning" && event["code"] === code);
const createCf = vi.fn(() => account.cf);

/** A fetch whose every POST to the server answers as `answer` says. */
const serverAnswering = (answer: () => Response) => vi.fn(async () => answer()) as unknown as typeof fetch;
const listsTools = () =>
  serverAnswering(
    () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "getUser" }, { name: "delete-everything" }], _meta: { "io.modelcontextprotocol/serverInfo": { name: "treg" } } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

type Route = Record<string, unknown> | ((init: RequestInit) => Response);

/** A fetch answering by URL (an object as JSON, a function as it says), 404 for anything else, recording each call. */
function routes(table: Record<string, Route>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const route = table[String(url).split("?")[0]!];
    if (!route) return new Response("not found", { status: 404 });
    if (typeof route === "function") return route(init ?? {});
    return new Response(JSON.stringify(route), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const O_MCP = "https://o.example.org/mcp";
const ISSUER = "https://auth.example.org";
const AS = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
};
/** An MCP server that signs in with OAuth: its 401, its resource metadata, its authorization server, its registration. */
const oauthServer = (as: Record<string, unknown> = AS, register: Route = { client_id: "cid-1", client_secret: "csecret-1", token_endpoint_auth_method: "client_secret_basic" }) =>
  routes({
    [O_MCP]: () =>
      new Response("", {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="https://o.example.org/.well-known/oauth-protected-resource/mcp", scope="mcp"` },
      }),
    "https://o.example.org/.well-known/oauth-protected-resource/mcp": { resource: O_MCP, authorization_servers: [ISSUER], scopes_supported: ["mcp"] },
    [`${ISSUER}/.well-known/oauth-authorization-server`]: as,
    [`${ISSUER}/register`]: register,
  });

const options = <F extends McpOptions["flags"] = typeof flags>(
  extra: Partial<McpOptions<F>> = {},
): McpOptions<F> => ({ flags: flags as F, out: out(), createCf, interactive: false, ...extra });

const addTreg = (extra: Partial<McpOptions<AddFlags>> = {}, url = TREG) =>
  addServer(options<AddFlags>({ flags: { ...flags, auth: "bearer" }, fetch: listsTools(), ...extra }), url);

/** A person at the terminal who says yes to "set it now?" and types `value` at the hidden prompt. */
const settingNow = (value: string): Partial<McpOptions<AddFlags>> => ({
  interactive: true,
  confirm: async () => true,
  readValue: async () => value,
});

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

const dirs: string[] = [];

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory with no app in it. */
function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-provider-none-"));
  dirs.push(dir);
  return dir;
}

const rows = async () =>
  (
    await db().run([
      { sql: "SELECT app_slug, tier, status, hostname, worker_name FROM apps ORDER BY app_slug" },
    ])
  )[0] ?? [];
const query = async (sql: string, ...params: string[]) => (await db().run([{ sql, params }]))[0] ?? [];

/** What the Gateway writes when it lists treg's tools. */
async function seedTregListing(): Promise<void> {
  const [app] = await query("SELECT id, organization_id FROM apps WHERE app_slug = 'treg'");
  const [id, org] = [String(app!["id"]), String(app!["organization_id"])];
  await db().run([
    {
      sql: "INSERT INTO app_tool_catalogs (app_row_id, organization_id, status, catalog_hash, tool_count, fetched_at) VALUES (?, ?, 'ok', 'h', 2, ?)",
      params: [id, org, Date.parse("2026-10-25T12:05:00Z")],
    },
    {
      sql: "INSERT INTO app_tools (app_row_id, organization_id, name, description, risk, input_schema, catalog_hash) VALUES (?, ?, 'get_user', 'd', 'read', '{}', 'h'), (?, ?, 'delete_everything', 'd', 'write', '{}', 'h')",
      params: [id, org, id, org],
    },
    {
      sql: `INSERT INTO remote_mcp_tools (app_row_id, organization_id, upstream_name, local_name, risk_hint, listed, listed_at)
VALUES (?1, ?2, 'getUser', 'get_user', 'read', 1, 0), (?1, ?2, 'delete-everything', 'delete_everything', 'unknown', 1, 0)`,
      params: [id, org],
    },
  ]);
}

describe("mcp on", () => {
  it("writes the row, says who can use it and where its tools are, and warns about the unset key", async () => {
    await turnOn(options(), "dataforseo");

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(await rows()).toEqual([
      { app_slug: "dataforseo", tier: "provider", status: "active", hostname: null, worker_name: null },
    ]);
    expect(warnings("PROVIDER_KEY_UNSET")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("DATAFORSEO_API_KEY isn't set on the Gateway"),
        data: { fix: "pnpm everyapp secret set DATAFORSEO_API_KEY", name: "DATAFORSEO_API_KEY" },
      }),
    ]);
    expect(done()).toMatchObject({
      message: expect.stringContaining("DataForSEO is on for"),
      data: {
        id: "dataforseo",
        name: "DataForSEO",
        kind: "builtin",
        on: true,
        was: "new",
        key: { name: "DATAFORSEO_API_KEY", set: false },
        mcp: { url: "https://example.com/mcp", toolPrefix: "dataforseo_" },
        next: [{ command: "pnpm everyapp secret set DATAFORSEO_API_KEY", note: "the provider's key" }],
      },
    });
    expect(done()!["message"]).toContain("https://example.com/mcp as dataforseo_<tool>");
  });

  it("reports a set key, and a second run as already on", async () => {
    gatewayWorker().secrets["DATAFORSEO_API_KEY"] = "login:password";
    await turnOn(options(), "dataforseo");
    await turnOn(options(), "dataforseo");

    expect(warnings("PROVIDER_KEY_UNSET")).toEqual([]);
    const dones = events.filter((event) => event["type"] === "done");
    expect(dones[0]!["data"]).toMatchObject({ was: "new", key: { set: true } });
    expect(dones[1]!["data"]).toMatchObject({ was: "existing", key: { set: true } });
    expect(dones[1]?.["data"]?.["next"]).toBeUndefined();
    expect((await rows()).filter((row) => row["app_slug"] === "dataforseo")).toHaveLength(1);
  });

  it("refuses an id that isn't an MCP app before writing anything, naming the ones there are", async () => {
    await expect(turnOn(options(), "ahrefs")).rejects.toMatchObject({
      code: "PROVIDER_APP_UNKNOWN",
      message: '"ahrefs" is not an MCP app on this Gateway\nBuilt in: dataforseo. Added: none yet.',
    });
    expect(await rows()).toEqual([]);
  });

  it("serves a remote app that was off again, and refuses one that was removed with the add that brings it back", async () => {
    await addTreg();
    await turnOff(options(), "treg");
    events = [];
    await turnOn(options(), "treg");
    expect(done()).toMatchObject({
      message: expect.stringContaining("treg is on for"),
      data: { id: "treg", kind: "remote", was: "off", key: { name: "TREG_MCP_TOKEN", set: false, bound: false } },
    });
    expect((await rows()).find((row) => row["app_slug"] === "treg")).toMatchObject({ status: "active" });

    await removeApp(options(), "treg");
    await expect(turnOn(options(), "treg")).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      rerun: `pnpm everyapp mcp add ${TREG} --name treg`,
    });
  });
});

describe("mcp off", () => {
  it("stops serving and keeps the row and its access, so on is instant; says when it was off already", async () => {
    await turnOn(options(), "dataforseo");
    events = [];
    await turnOff(options(), "dataforseo");
    expect(done()).toMatchObject({
      message: expect.stringContaining("DataForSEO is off for"),
      data: { id: "dataforseo", on: false, wasOn: true, key: { name: "DATAFORSEO_API_KEY", set: false } },
    });
    expect(done()!["message"]).toContain("Everyone's access, its tokens and its tools snapshot are kept");
    expect(await rows()).toEqual([
      expect.objectContaining({ app_slug: "dataforseo", tier: "provider", status: "disabled" }),
    ]);

    events = [];
    await turnOff(options(), "dataforseo");
    expect(done()).toMatchObject({ message: expect.stringContaining("was off already"), data: { wasOn: false } });

    events = [];
    await turnOn(options(), "dataforseo");
    expect(done()!["data"]).toMatchObject({ was: "off" });
  });

  it("changes nothing for a built-in that was never added", async () => {
    await turnOff(options(), "dataforseo");
    expect(done()).toMatchObject({ message: expect.stringContaining("DataForSEO isn't on"), data: { wasOn: false } });
    expect(await rows()).toEqual([]);
  });
});

describe("mcp remove", () => {
  it("tombstones a built-in, says the key stays, and is safe to repeat", async () => {
    gatewayWorker().secrets["DATAFORSEO_API_KEY"] = "login:password";
    await turnOn(options(), "dataforseo");
    events = [];
    await removeApp(options(), "dataforseo");
    expect(done()).toMatchObject({
      message: expect.stringContaining("DataForSEO is removed from"),
      data: { id: "dataforseo", kind: "builtin", removed: true, key: { name: "DATAFORSEO_API_KEY", set: true } },
    });
    expect(done()!["message"]).toContain("pnpm everyapp secret unset DATAFORSEO_API_KEY removes it");
    expect(await rows()).toEqual([expect.objectContaining({ app_slug: "dataforseo", status: "deleted" })]);

    events = [];
    await removeApp(options(), "dataforseo");
    expect(done()).toMatchObject({ message: expect.stringContaining("was removed already"), data: { removed: false } });
  });

  it("tombstones a remote app and keeps its provider row and key, saying what cleans them up", async () => {
    await addTreg(settingNow("treg-secret"));
    events = [];
    await removeApp(options(), "treg");
    expect(done()).toMatchObject({
      data: { id: "treg", kind: "remote", removed: true, provider: { id: "treg-mcp", own: true, kept: true, settings: ["TREG_MCP_TOKEN"] } },
    });
    expect(done()!["message"]).toContain(
      "Its provider row treg-mcp and TREG_MCP_TOKEN stay: pnpm everyapp provider remove treg-mcp and pnpm everyapp secret unset TREG_MCP_TOKEN clean them up.",
    );
    expect(done()!["message"]).toContain(`pnpm everyapp mcp add ${TREG} --name treg adds it again`);
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBe("treg-secret");
    expect((await query("SELECT id FROM providers")).map((row) => row["id"])).toEqual(["treg-mcp"]);
  });
});

describe("mcp add", () => {
  it("looks at the server first, writes the app and its own provider row, and says to set the credential", async () => {
    const fetch = listsTools();
    await addTreg({ fetch });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(await rows()).toEqual([
      { app_slug: "treg", tier: "provider", status: "active", hostname: null, worker_name: null },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
    // The probe comes before the write.
    const steps = events.filter((event) => event["type"] === "step" && event["status"] === "ok").map((event) => event["step"]);
    expect(steps.indexOf("mcp.probe")).toBeLessThan(steps.indexOf("mcp.add"));
    expect(events.find((event) => event["step"] === "mcp.probe" && event["status"] === "ok")).toMatchObject({
      message: `${TREG} answers MCP (2026-07-28, 2 tools, server treg)`,
    });
    const [provider] = await query("SELECT id, spec, bound_to FROM providers");
    expect(provider).toMatchObject({ id: "treg-mcp", bound_to: null });
    expect(JSON.parse(String(provider!["spec"]))).toMatchObject({
      id: "treg-mcp",
      hosts: ["treg.to"],
      auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
      tags: ["mcp"],
    });
    expect(warnings("PROVIDER_KEY_UNSET")).toEqual([
      expect.objectContaining({ data: { fix: "pnpm everyapp secret set TREG_MCP_TOKEN", name: "TREG_MCP_TOKEN" } }),
    ]);
    expect(done()).toMatchObject({
      message: expect.stringContaining("treg is on for"),
      data: {
        id: "treg",
        name: "treg",
        url: TREG,
        auth: { kind: "provider", provider: "treg-mcp" },
        credential: { kind: "bearer", setting: "TREG_MCP_TOKEN", set: false, bound: false },
        risk: "annotations",
        on: true,
        was: "new",
        probe: { outcome: "reachable", era: "2026-07-28", tools: 2, server: "treg" },
        mcp: { url: "https://example.com/mcp", toolPrefix: "treg_" },
        next: [
          { command: "pnpm everyapp secret set TREG_MCP_TOKEN", note: "treg's credential" },
          { command: "pnpm everyapp mcp show treg", note: "its tools, once the Gateway lists them" },
        ],
      },
    });
    expect(done()!["message"]).toContain("TREG_MCP_TOKEN isn't set: pnpm everyapp secret set TREG_MCP_TOKEN");
  });

  it("at a terminal, offers the credential, sets it through secret set's path, binds the row and checks it from here", async () => {
    const asked: Array<{ question: string; context?: readonly string[] }> = [];
    const read: string[] = [];
    const fetch = listsTools();
    await addTreg({
      fetch,
      interactive: true,
      confirm: async (question, context) => {
        asked.push({ question, context });
        return true;
      },
      readValue: async (name) => {
        read.push(name);
        return "treg-secret";
      },
    });
    expect(asked).toEqual([
      {
        question: "Set TREG_MCP_TOKEN now?",
        context: [
          "treg's credential (bearer token) is a Gateway setting.",
          "The Gateway sends it to treg.to and nowhere else. Later: pnpm everyapp secret set TREG_MCP_TOKEN",
        ],
      },
    ]);
    expect(read).toEqual(["TREG_MCP_TOKEN"]);
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBe("treg-secret");
    expect((await query("SELECT bound_to FROM providers WHERE id = 'treg-mcp'"))[0]!["bound_to"]).not.toBeNull();
    // The check: one tools/list with the value, as the Gateway sends it.
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, check] = vi.mocked(fetch).mock.calls[1]! as unknown as [string, RequestInit];
    expect((check.headers as Record<string, string>)["authorization"]).toBe("Bearer treg-secret");
    expect(warnings("PROVIDER_KEY_UNSET")).toEqual([]);
    expect(done()!["data"]).toMatchObject({
      credential: { kind: "bearer", setting: "TREG_MCP_TOKEN", set: true, bound: true },
      verify: { ok: true, tools: 2 },
    });
    expect(done()!["message"]).toContain("Working: 2 tools.");
    expect(done()!["data"]["next"]).toEqual([{ command: "pnpm everyapp mcp show treg", note: "its tools, once the Gateway lists them" }]);
    expect(JSON.stringify(events)).not.toContain("treg-secret");
  });

  it("warns REMOTE_MCP_CREDENTIAL_REJECTED when the server refuses the value", async () => {
    vi.stubEnv("TREG_KEY", "wrong");
    await addTreg({
      flags: { ...flags, auth: "header", header: "X-Api-Key", "from-env": "TREG_KEY" },
      fetch: serverAnswering(() => new Response("", { status: 401 })),
    });
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBe("wrong");
    expect(warnings("REMOTE_MCP_CREDENTIAL_REJECTED")).toEqual([
      expect.objectContaining({
        message: `${TREG} refused TREG_MCP_TOKEN (401)\nCheck the key, and where it goes: the Gateway sends it as a header X-Api-Key. pnpm everyapp secret set TREG_MCP_TOKEN sets it again.`,
        data: expect.objectContaining({ status: 401, fix: "pnpm everyapp secret set TREG_MCP_TOKEN" }),
      }),
    ]);
    expect(done()!["data"]).toMatchObject({ credential: { kind: "header", set: true, bound: true }, verify: { ok: false, status: 401 } });
  });

  it("leaves the credential unset when the person says no, and sets nothing it wasn't given", async () => {
    const readValue = vi.fn();
    await addTreg({ interactive: true, confirm: async () => false, readValue });
    expect(readValue).not.toHaveBeenCalled();
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBeUndefined();
    expect(warnings("PROVIDER_KEY_UNSET")).toHaveLength(1);
  });

  it("sets the credential from --from-env with secret set's own reader, before writing anything", async () => {
    vi.stubEnv("TREG_KEY", "from-the-env");
    await addTreg({ flags: { ...flags, auth: "bearer", "from-env": "TREG_KEY" } });
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBe("from-the-env");
    expect(done()!["data"]).toMatchObject({ credential: { set: true, bound: true } });

    vi.stubEnv("EMPTY_KEY", "");
    await expect(
      addServer(options<AddFlags>({ flags: { ...flags, name: "other", auth: "bearer", "from-env": "EMPTY_KEY" }, fetch: listsTools() }), "https://other.example.org/mcp"),
    ).rejects.toMatchObject({ code: "SECRET_EMPTY", message: "$EMPTY_KEY is empty or not set" });
    expect((await rows()).map((row) => row["app_slug"])).toEqual(["treg"]);
    await expect(
      addServer(options<AddFlags>({ flags: { ...flags, "from-env": "TREG_KEY" } }), "https://deepwiki.com/mcp"),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_INVALID", message: "--from-env sets a static credential's value: say how it is sent" });
  });

  it("adds a server that answers without a credential with none, asking nothing", async () => {
    const confirm = vi.fn();
    await addServer(options<AddFlags>({ interactive: true, confirm, fetch: listsTools() }), "https://deepwiki.com/mcp");
    expect(confirm).not.toHaveBeenCalled();
    expect(done()!["data"]).toMatchObject({ id: "deepwiki", auth: { kind: "none" }, credential: { kind: "none" } });
    expect(await query("SELECT id FROM providers")).toEqual([]);
  });

  it("refuses a server that asks for a credential none was given for, before writing; --force adds it with a warning", async () => {
    const asks = () => serverAnswering(() => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="x"' } }));
    await expect(addServer(options<AddFlags>({ fetch: asks() }), "https://deepwiki.com/mcp")).rejects.toMatchObject({
      code: "REMOTE_MCP_NEEDS_CREDENTIAL",
      message:
        "https://deepwiki.com/mcp needs a credential. Check the server's docs for how it authenticates, then add it with --auth bearer|header|query|basic, --auth oauth, or --provider <id>. --force adds it anyway.",
    });
    await expect(addServer(options<AddFlags>({ flags: { ...flags, auth: "none" }, fetch: asks() }), "https://deepwiki.com/mcp")).rejects.toMatchObject({
      code: "REMOTE_MCP_NEEDS_CREDENTIAL",
    });
    expect(await rows()).toEqual([]);

    await addServer(options<AddFlags>({ flags: { ...flags, force: true }, fetch: asks() }), "https://deepwiki.com/mcp");
    expect(done()!["data"]).toMatchObject({ id: "deepwiki", auth: { kind: "none" }, probe: { outcome: "needs-credential", status: 401 } });
    expect(warnings("REMOTE_MCP_PROBE_FAILED")).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/^https:\/\/deepwiki.com\/mcp asks for a credential, and deepwiki sends none\n/),
      }),
    ]);
  });

  it("warns, never refuses, when the server redirects or can't be reached", async () => {
    await addServer(
      options<AddFlags>({
        flags: { ...flags, name: "moved" },
        fetch: serverAnswering(() => new Response(null, { status: 302, headers: { location: "https://new.example.org/mcp" } })),
      }),
      "https://old.example.org/mcp",
    );
    expect(warnings("REMOTE_MCP_PROBE_FAILED").at(-1)).toMatchObject({
      message: "https://old.example.org/mcp redirects to https://new.example.org/mcp\nThe Gateway follows no redirects; register the address it redirects to.",
    });
    await addServer(
      options<AddFlags>({
        flags: { ...flags, name: "far" },
        fetch: vi.fn(async () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        }) as unknown as typeof fetch,
      }),
      "https://far.example.org/mcp",
    );
    expect(warnings("REMOTE_MCP_PROBE_FAILED").at(-1)).toMatchObject({
      message: expect.stringContaining("Couldn't reach https://far.example.org/mcp from here: it refused the connection"),
    });
    expect((await rows()).map((row) => [row["app_slug"], row["status"]])).toEqual([
      ["far", "active"],
      ["moved", "active"],
    ]);
  });

  it("refuses flags that say two things before connecting, and what the registry refuses before probing", async () => {
    createCf.mockClear();
    for (const extra of [
      { auth: "bearer", header: "X-Api-Key" },
      { auth: "header" },
      { auth: "query" },
      { auth: "bearer", param: "key" },
      { auth: "basic", prefix: "Token" },
      { auth: "none", "from-env": "X" },
      { auth: "bearer", provider: "elevenlabs" },
      { "client-secret-from-env": "X" },
      { auth: "bearer", "client-id": "x" },
    ] as const) {
      await expect(addServer(options<AddFlags>({ flags: { ...flags, ...extra } }), TREG)).rejects.toMatchObject({ code: "REMOTE_MCP_INVALID" });
    }
    expect(createCf).not.toHaveBeenCalled();
    const fetch = listsTools();
    await expect(addServer(options<AddFlags>({ fetch }), "https://apps.example.com/mcp")).rejects.toMatchObject({
      code: "REMOTE_MCP_URL_REFUSED",
    });
    expect(fetch).not.toHaveBeenCalled();
    await addTreg();
    await expect(addTreg()).rejects.toMatchObject({ code: "REMOTE_MCP_EXISTS" });
    expect((await rows()).map((row) => row["app_slug"])).toEqual(["treg"]);
  });

  it("places a static credential as the flags say: a header with a prefix, a query parameter, Basic", async () => {
    await addServer(
      options<AddFlags>({ flags: { ...flags, name: "example", auth: "header", header: "X-Api-Key", prefix: "Key ", risk: "read" }, fetch: listsTools() }),
      "https://api.example.org/mcp",
    );
    expect(done()!["data"]).toMatchObject({
      id: "example",
      auth: { kind: "provider", provider: "example-mcp" },
      credential: { kind: "header", setting: "EXAMPLE_MCP_TOKEN" },
      risk: "read",
    });
    await addServer(options<AddFlags>({ flags: { ...flags, name: "q", auth: "query", param: "api_key" }, fetch: listsTools() }), "https://q.example.org/mcp");
    await addServer(options<AddFlags>({ flags: { ...flags, name: "b", auth: "basic" }, fetch: listsTools() }), "https://b.example.org/mcp");
    const specs = Object.fromEntries(
      (await query("SELECT id, spec FROM providers")).map((row) => [row["id"], JSON.parse(String(row["spec"]))["auth"]]),
    );
    expect(specs).toEqual({
      "example-mcp": { kind: "header", secret: "EXAMPLE_MCP_TOKEN", header: "X-Api-Key", prefix: "Key " },
      "q-mcp": { kind: "query", secret: "Q_MCP_TOKEN", param: "api_key" },
      "b-mcp": { kind: "basic", secret: "B_MCP_TOKEN", as: "pair" },
    });
  });
});

describe("mcp add with OAuth", () => {
  it("signs in when the server's 401 names its metadata: discovers, registers a client, sets it through secret set's path and opens the connect page", async () => {
    const server = oauthServer();
    const opened: string[] = [];
    await addServer(
      options<AddFlags>({ flags: { ...flags, name: "o" }, fetch: server.fetcher, openBrowser: async (url) => opened.push(url) }),
      O_MCP,
    );
    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    // The registration asked for the Gateway's callback.
    const registration = server.calls.find((call) => call.url === `${ISSUER}/register`)!;
    expect(JSON.parse(String(registration.init.body))).toMatchObject({
      redirect_uris: ["https://example.com/connect/o-mcp/callback"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    const [row] = await query("SELECT id, spec, bound_to FROM providers");
    expect(row!["bound_to"]).not.toBeNull();
    expect(JSON.parse(String(row!["spec"]))).toMatchObject({
      id: "o-mcp",
      hosts: ["o.example.org"],
      auth: {
        kind: "oauth2-user",
        authorizeUrl: `${ISSUER}/authorize`,
        tokenUrl: `${ISSUER}/token`,
        clientId: "O_MCP_CLIENT_ID",
        clientSecret: "O_MCP_CLIENT_SECRET",
        inject: "basic",
        pkce: true,
        resource: O_MCP,
        issuer: ISSUER,
        tolerated: ["mcp"],
      },
    });
    expect(gatewayWorker().secrets["O_MCP_CLIENT_ID"]).toBe("cid-1");
    expect(gatewayWorker().secrets["O_MCP_CLIENT_SECRET"]).toBe("csecret-1");
    // The app's capability entry lists the scopes discovery found: what the connect asks for.
    const [app] = await query("SELECT manifest FROM apps WHERE app_slug = 'o'");
    expect(JSON.parse(String(app!["manifest"])).capabilities).toEqual({
      "o-mcp": { scopes: ["mcp"], why: expect.any(String) },
    });
    const connect = "https://example.com/connect/o-mcp?app=o";
    expect(opened).toEqual([connect]);
    expect(done()).toMatchObject({
      data: {
        id: "o",
        auth: { kind: "provider", provider: "o-mcp" },
        credential: { kind: "oauth", setting: "O_MCP_CLIENT_ID", set: true, bound: true },
        connect: { url: connect },
        oauth: { issuer: ISSUER, registered: "dcr" },
      },
    });
    expect(done()!["message"]).toContain(`Each member connects their own o account: ${connect}`);
    expect(JSON.stringify(events)).not.toContain("csecret-1");

    // --no-open prints the page only.
    events = [];
    opened.length = 0;
    await removeApp(options(), "o");
    await addServer(
      options<AddFlags>({
        flags: { ...flags, name: "o", "no-open": true },
        interactive: true,
        fetch: oauthServer().fetcher,
      }),
      O_MCP,
    );
    expect(done()!["data"]["connect"]).toEqual({ url: "https://example.com/connect/o-mcp?app=o" });
  });

  it("keeps the client the row has when the server's metadata is the same, so people's connections keep working", async () => {
    await addServer(options<AddFlags>({ flags: { ...flags, name: "o" }, fetch: oauthServer().fetcher }), O_MCP);
    await removeApp(options(), "o");
    events = [];
    const again = oauthServer();
    await addServer(options<AddFlags>({ flags: { ...flags, name: "o" }, fetch: again.fetcher }), O_MCP);
    expect(again.calls.some((call) => call.url === `${ISSUER}/register`)).toBe(false);
    expect(done()!["data"]).toMatchObject({ was: "revived", oauth: { registered: "existing" } });
  });

  it("refuses a server that registers no clients, printing the redirect URI to register; takes a pasted client", async () => {
    const { registration_endpoint: _, ...noRegistration } = AS;
    await expect(
      addServer(options<AddFlags>({ flags: { ...flags, name: "o" }, fetch: oauthServer(noRegistration).fetcher }), O_MCP),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_OAUTH_NO_CLIENT",
      message: expect.stringContaining("https://example.com/connect/o-mcp/callback"),
      data: { redirectUri: "https://example.com/connect/o-mcp/callback", issuer: ISSUER },
    });
    expect(await rows()).toEqual([]);
    expect(await query("SELECT id FROM providers")).toEqual([]);

    vi.stubEnv("O_SECRET", "pasted-secret");
    await addServer(
      options<AddFlags>({
        flags: { ...flags, name: "o", "client-id": "pasted-id", "client-secret-from-env": "O_SECRET" },
        fetch: oauthServer(noRegistration).fetcher,
      }),
      O_MCP,
    );
    expect(gatewayWorker().secrets["O_MCP_CLIENT_ID"]).toBe("pasted-id");
    expect(gatewayWorker().secrets["O_MCP_CLIENT_SECRET"]).toBe("pasted-secret");
    expect(done()!["data"]).toMatchObject({ oauth: { issuer: ISSUER, registered: "pasted" } });
  });

  it("gives a server that takes client metadata documents (CIMD) and registers none the Gateway's document URL as a public client", async () => {
    const { registration_endpoint: _, ...noRegistration } = AS;
    const server = oauthServer({
      ...noRegistration,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
    await addServer(options<AddFlags>({ flags: { ...flags, name: "o" }, fetch: server.fetcher }), O_MCP);
    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(server.calls.some((call) => call.url === `${ISSUER}/register`)).toBe(false);
    expect(gatewayWorker().secrets["O_MCP_CLIENT_ID"]).toBe("https://example.com/oauth-clients/o-mcp");
    expect(gatewayWorker().secrets["O_MCP_CLIENT_SECRET"]).toBeUndefined();
    const [row] = await query("SELECT spec FROM providers");
    const spec = JSON.parse(String(row!["spec"]));
    expect(spec.auth).toMatchObject({ clientId: "O_MCP_CLIENT_ID", inject: "form", pkce: true });
    expect(spec.auth.clientSecret).toBeUndefined();
    expect(done()!["data"]).toMatchObject({ oauth: { issuer: ISSUER, registered: "cimd" } });
  });

  it("lets an OAuth server on a host the Gateway holds a key for (ElevenLabs') use its own row; a static credential there stays refused", async () => {
    const url = "https://api.elevenlabs.io/v1/mcp";
    const issuer = "https://api.us.elevenlabs.io";
    const server = routes({
      [url]: () =>
        new Response("", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="https://api.elevenlabs.io/.well-known/oauth-protected-resource"` },
        }),
      "https://api.elevenlabs.io/.well-known/oauth-protected-resource": {
        resource: url,
        authorization_servers: [issuer],
        scopes_supported: ["text_to_speech", "convai_read"],
      },
      [`${issuer}/.well-known/oauth-authorization-server`]: {
        issuer,
        authorization_endpoint: "https://elevenlabs.io/app/oauth/authorize",
        token_endpoint: `${issuer}/v1/oauth/token`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "private_key_jwt"],
        client_id_metadata_document_supported: true,
      },
    });
    await addServer(options<AddFlags>({ flags: { ...flags, name: "elevenlabs-mcp-app" }, fetch: server.fetcher }), url);
    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(done()!["data"]).toMatchObject({
      auth: { kind: "provider", provider: "elevenlabs-mcp-app-mcp" },
      oauth: { issuer, registered: "cimd" },
    });
    expect(gatewayWorker().secrets["ELEVENLABS_MCP_APP_MCP_CLIENT_ID"]).toBe(
      "https://example.com/oauth-clients/elevenlabs-mcp-app-mcp",
    );

    await expect(
      addServer(options<AddFlags>({ flags: { ...flags, name: "eleven-key", auth: "bearer" }, fetch: listsTools() }), url),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_URL_REFUSED" });
  });

  it("refuses REMOTE_MCP_OAUTH_DISCOVERY when the server's metadata can't be found, writing nothing", async () => {
    await expect(
      addServer(
        options<AddFlags>({ flags: { ...flags, name: "o", auth: "oauth" }, fetch: serverAnswering(() => new Response("not found", { status: 404 })) }),
        O_MCP,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_OAUTH_DISCOVERY" });
    expect(await rows()).toEqual([]);
  });
});

describe("mcp add --provider", () => {
  it("uses a provider of the registry whose host is the URL's, warning while its key isn't set", async () => {
    await addServer(options<AddFlags>({ flags: { ...flags, provider: "elevenlabs" }, fetch: listsTools() }), "https://api.elevenlabs.io/v1/mcp");
    expect(done()!["data"]).toMatchObject({
      id: "elevenlabs",
      auth: { kind: "provider", provider: "elevenlabs" },
      credential: { kind: "provider", setting: "ELEVENLABS_API_KEY", set: false, bound: true },
    });
    expect(warnings("PROVIDER_KEY_UNSET")).toEqual([
      expect.objectContaining({ data: { fix: "pnpm everyapp secret set ELEVENLABS_API_KEY", name: "ELEVENLABS_API_KEY" } }),
    ]);
    expect(await query("SELECT id FROM providers")).toEqual([]);
  });

  it("refuses REMOTE_MCP_PROVIDER_HOST when the URL's host isn't one of the provider's, before probing", async () => {
    const fetch = listsTools();
    await expect(
      addServer(options<AddFlags>({ flags: { ...flags, provider: "elevenlabs" }, fetch }), "https://mcp.elsewhere.org/mcp"),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_PROVIDER_HOST",
      message: expect.stringContaining("elevenlabs sends its key to api.elevenlabs.io, not to mcp.elsewhere.org"),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
});

describe("mcp list", () => {
  it("lists each MCP app with its kind, state, tools and key, and what to run next", async () => {
    await listMcp(options());
    expect(done()).toMatchObject({
      message: "0 of 1 MCP app on",
      data: {
        apps: [
          {
            id: "dataforseo",
            name: "DataForSEO",
            kind: "builtin",
            status: "not added",
            on: false,
            tools: null,
            key: { name: "DATAFORSEO_API_KEY", set: false },
          },
        ],
        mcp: "https://example.com/mcp",
        next: [{ command: "pnpm everyapp mcp on dataforseo", note: "offer DataForSEO" }],
      },
    });
    expect(done()!["display"]).toBeUndefined();

    gatewayWorker().secrets["DATAFORSEO_API_KEY"] = "login:password";
    await turnOn(options(), "dataforseo");
    await addTreg();
    await seedTregListing();
    await addServer(options<AddFlags>({ fetch: listsTools() }), "https://deepwiki.com/mcp");
    await addServer(options<AddFlags>({ flags: { ...flags, name: "o" }, fetch: oauthServer().fetcher }), O_MCP);
    await turnOff(options(), "deepwiki");
    events = [];
    await listMcp(options());
    expect(done()).toMatchObject({
      message: "3 of 4 MCP apps on",
      data: {
        apps: [
          { id: "dataforseo", kind: "builtin", status: "on", on: true, key: { set: true } },
          { id: "deepwiki", kind: "remote", status: "off", on: false, url: "https://deepwiki.com/mcp", auth: { kind: "none" }, credential: { kind: "none" }, tools: null, key: null },
          {
            id: "o",
            kind: "remote",
            status: "needs setup",
            auth: { kind: "provider", provider: "o-mcp" },
            credential: { kind: "oauth", provider: "o-mcp", connected: 0, client: { setting: "O_MCP_CLIENT_ID", set: true, bound: true } },
            connect: { url: "https://example.com/connect/o-mcp?app=o" },
            key: null,
          },
          {
            id: "treg",
            kind: "remote",
            status: "needs setup",
            on: true,
            url: TREG,
            auth: { kind: "provider", provider: "treg-mcp" },
            credential: { kind: "key", provider: "treg-mcp", setting: "TREG_MCP_TOKEN", set: false, bound: false },
            tools: 2,
            key: { name: "TREG_MCP_TOKEN", set: false, bound: false },
            lastListedAt: "2026-10-25T12:05:00.000Z",
          },
        ],
        next: [{ command: "pnpm everyapp secret set TREG_MCP_TOKEN", note: "treg's credential" }],
      },
    });
    // Never a token: who connected is show's, and only as an email.
    expect(done()!["data"]["apps"][2]["credential"]["people"]).toBeUndefined();
  });

  it("says a registration from before provider credentials needs removing and adding again", async () => {
    await addServer(options<AddFlags>({ fetch: listsTools() }), "https://deepwiki.com/mcp");
    const [row] = await query("SELECT manifest FROM apps WHERE app_slug = 'deepwiki'");
    const manifest = JSON.parse(String(row!["manifest"]));
    manifest.remote.auth = { kind: "bearer", secret: "DEEPWIKI_MCP_TOKEN" };
    await db().run([{ sql: "UPDATE apps SET manifest = ? WHERE app_slug = 'deepwiki'", params: [JSON.stringify(manifest)] }]);
    events = [];
    await listMcp(options());
    expect(done()!["data"]["apps"].find((app: { id: string }) => app.id === "deepwiki")).toMatchObject({
      status: "needs setup",
      url: "https://deepwiki.com/mcp",
      auth: null,
      credential: { kind: "predates" },
    });
    expect(done()!["data"]["next"]).toContainEqual({
      command: "pnpm everyapp mcp remove deepwiki",
      note: "deepwiki was registered before provider credentials; then add it again",
    });
    events = [];
    await listMcp({ flags: {}, out: { emit: (event) => events.push(event as never), exitCode: 0, verbose: false }, createCf });
    expect(String(done()!["display"]).replace(/\u001b\[[0-9;]*m/g, "")).toContain("registered before provider credentials: remove and add again");
  });

  it("draws the table a person reads", async () => {
    await addTreg();
    events = [];
    await listMcp({ flags: {}, out: { emit: (event) => events.push(event as never), exitCode: 0, verbose: false }, createCf });
    const display = String(done()!["display"]).replace(/\u001b\[[0-9;]*m/g, "");
    expect(display).toMatch(/^APP\s+KIND\s+STATUS\s+TOOLS\s+KEY\n/);
    expect(display).toMatch(/dataforseo  DataForSEO\s+built-in\s+not added\s+not listed yet\s+DATAFORSEO_API_KEY not set/);
    expect(display).toMatch(/treg  treg\s+remote\s+needs setup\s+not listed yet\s+TREG_MCP_TOKEN unset/);
  });
});

describe("mcp show", () => {
  it("shows a remote app's facts, its credential, its snapshot, and every tool with its risk and source", async () => {
    await addTreg(settingNow("treg-secret"));
    await seedTregListing();
    await changeTool(options<ToolFlags>({ flags: { ...flags, risk: "read" } }), "treg", "delete-everything");
    events = [];
    await showApp(options(), "treg");
    expect(done()).toMatchObject({
      data: {
        id: "treg",
        kind: "remote",
        status: "on",
        on: true,
        url: TREG,
        auth: { kind: "provider", provider: "treg-mcp" },
        credential: { kind: "key", provider: "treg-mcp", setting: "TREG_MCP_TOKEN", set: true, bound: true },
        risk: "annotations",
        rev: 2,
        overrides: { "delete-everything": { risk: "read" } },
        addedBy: ACTOR,
        key: { name: "TREG_MCP_TOKEN", set: true, bound: true },
        snapshot: { status: "ok", tools: 2, listedAt: "2026-10-25T12:05:00.000Z", lastError: null },
        tools: [
          { name: "treg_delete_everything", serverName: "delete-everything", risk: "write", source: "override", on: true },
          { name: "treg_get_user", serverName: "getUser", risk: "read", source: "hint", on: true },
        ],
        mcp: { url: "https://example.com/mcp", toolPrefix: "treg_" },
      },
    });
    expect(done()!["message"]).toMatch(/URL\s+https:\/\/treg\.to\/mcp\//);
    expect(done()!["message"]).toMatch(/Auth\s+bearer token/);
    expect(done()!["message"]).toMatch(/Credential\s+TREG_MCP_TOKEN set/);
  });

  it("shows who has connected an OAuth app, never a token", async () => {
    await addServer(options<AddFlags>({ flags: { ...flags, name: "o" }, fetch: oauthServer().fetcher }), O_MCP);
    const [org] = await query("SELECT organization_id FROM apps WHERE app_slug = 'o'");
    await db().run([
      {
        sql: "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u-ada', 'Ada', 'ada@example.org', 1, 0, 0)",
      },
      {
        sql: `INSERT INTO provider_connections (id, organization_id, provider_id, user_id, app_row_id, label, scopes, access_token_enc, status, created_at, updated_at)
VALUES ('c1', ?, 'o-mcp', 'u-ada', (SELECT id FROM apps WHERE app_slug = 'o'), 'Ada', '[]', 'sealed-token', 'active', 0, 0)`,
        params: [String(org!["organization_id"])],
      },
    ]);
    events = [];
    await showApp(options(), "o");
    expect(done()!["data"]).toMatchObject({
      status: "on",
      credential: { kind: "oauth", connected: 1, people: ["ada@example.org"] },
      connect: { url: "https://example.com/connect/o-mcp?app=o" },
    });
    expect(done()!["message"]).toMatch(/Auth\s+OAuth, each member connects/);
    expect(done()!["message"]).toMatch(/Credential\s+OAuth: 1 connected \(ada@example.org\)/);
    expect(JSON.stringify(events)).not.toContain("sealed-token");
  });

  it("shows a built-in's key and its catalog's tools, and one that isn't added", async () => {
    await showApp(options(), "dataforseo");
    expect(done()).toMatchObject({
      data: { id: "dataforseo", kind: "builtin", status: "not added", on: false, snapshot: null, tools: [], next: [{ command: "pnpm everyapp mcp on dataforseo" }] },
    });
    await turnOn(options(), "dataforseo");
    events = [];
    await showApp(options(), "dataforseo");
    expect(done()!["data"]).toMatchObject({ status: "needs setup", key: { name: "DATAFORSEO_API_KEY", set: false } });
  });
});

describe("mcp refresh", () => {
  it("drops the snapshot and nothing else, and says when the Gateway lists the tools again", async () => {
    await addTreg();
    await seedTregListing();
    events = [];
    await refreshApp(options(), "treg");
    expect(done()).toMatchObject({
      message: expect.stringContaining("The Gateway lists its tools again on the next request to https://example.com/mcp, or within the hour."),
      data: { id: "treg", refreshed: true, dropped: { status: "ok", tools: 2 } },
    });
    expect(await query("SELECT * FROM app_tool_catalogs")).toEqual([]);
    expect(await query("SELECT * FROM app_tools")).toEqual([]);
    expect(await query("SELECT upstream_name FROM remote_mcp_tools")).toHaveLength(2);
  });
});

describe("mcp tool", () => {
  it("overrides one tool by either name and bumps the revision; warns about a name the listing doesn't have", async () => {
    await addTreg();
    await seedTregListing();
    events = [];
    await changeTool(options<ToolFlags>({ flags: { ...flags, off: true } }), "treg", "treg_get_user");
    expect(done()).toMatchObject({
      message: expect.stringContaining("getUser (treg_get_user) on treg: risk from the app's default and the server's hints, left out of the catalog."),
      data: { id: "treg", tool: { serverName: "getUser", name: "treg_get_user", inListing: true }, override: { enabled: false }, rev: 2 },
    });
    expect(warnings("REMOTE_MCP_TOOL_NOT_LISTED")).toEqual([]);
    await changeTool(options<ToolFlags>({ flags: { ...flags, risk: "read" } }), "treg", "searchDocs");
    expect(warnings("REMOTE_MCP_TOOL_NOT_LISTED")).toEqual([expect.objectContaining({ message: expect.stringContaining("searchDocs isn't in treg's last tool listing") })]);
    expect(done()!["data"]).toMatchObject({ tool: { serverName: "searchDocs", inListing: false }, override: { risk: "read" }, rev: 3 });
    // Each override is mcp_app.tool_changed, the operator its actor, the override after the change.
    const [treg] = await query("SELECT id, name FROM apps WHERE app_slug = 'treg'");
    const app = { id: "treg", rowId: treg!["id"], name: treg!["name"] };
    expect(
      (await query("SELECT type, actor, data FROM events WHERE type = 'mcp_app.tool_changed' ORDER BY rowid")).map((event) => ({
        type: event["type"],
        actor: JSON.parse(String(event["actor"])),
        data: JSON.parse(String(event["data"])),
      })),
    ).toEqual([
      { type: "mcp_app.tool_changed", actor: { kind: "operator", id: ACTOR, email: ACTOR }, data: { app, kind: "remote", tool: "getUser", enabled: false } },
      { type: "mcp_app.tool_changed", actor: { kind: "operator", id: ACTOR, email: ACTOR }, data: { app, kind: "remote", tool: "searchDocs", risk: "read" } },
    ]);
  });

  it("refuses a built-in's tools and a change that says nothing or two things", async () => {
    await turnOn(options(), "dataforseo");
    await expect(changeTool(options<ToolFlags>({ flags: { ...flags, off: true } }), "dataforseo", "x")).rejects.toMatchObject({
      code: "MCP_APP_BUILTIN",
    });
    await expect(changeTool(options<ToolFlags>(), "treg", "x")).rejects.toMatchObject({ code: "MCP_TOOL_CHANGE_INVALID" });
    await expect(
      changeTool(options<ToolFlags>({ flags: { ...flags, on: true, off: true } }), "treg", "x"),
    ).rejects.toMatchObject({ code: "MCP_TOOL_CHANGE_INVALID" });
  });
});

describe("secret set and unset with a remote MCP credential", () => {
  const set = (...names: string[]) =>
    setSecrets({ flags, out: out(), cwd: emptyDir(), createCf, names, readValue: async (name) => `value-of-${name}` });
  const unset = (...names: string[]) =>
    unsetSecrets({ flags: { ...flags, yes: true }, out: out(), cwd: emptyDir(), createCf, names });

  it("routes the name to the Gateway through the app's own provider row and binds the row to its host", async () => {
    await addTreg();
    events = [];
    await set("TREG_MCP_TOKEN");
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBe("value-of-TREG_MCP_TOKEN");
    expect((await query("SELECT bound_to FROM providers WHERE id = 'treg-mcp'"))[0]!["bound_to"]).not.toBeNull();
    expect(events.find((event) => event["step"] === "secrets.provider")).toMatchObject({
      message: expect.stringContaining("the key is sent to treg.to"),
    });
    expect(done()).toMatchObject({
      message: "Set TREG_MCP_TOKEN on the Gateway",
      data: { gateway: { names: ["TREG_MCP_TOKEN"], bound: ["treg-mcp"] } },
    });

    events = [];
    await unset("TREG_MCP_TOKEN");
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBeUndefined();
  });

  it("refuses an _MCP_TOKEN name no provider row holds: the family is gone", async () => {
    await expect(set("LOST_MCP_TOKEN")).rejects.toMatchObject({ code: expect.any(String) });
    expect(gatewayWorker().secrets["LOST_MCP_TOKEN"]).toBeUndefined();
  });

  it("an app added again at another host replaces its row, which unbinds the key until it is set again", async () => {
    await addTreg(settingNow("treg-secret"));
    await removeApp(options(), "treg");
    events = [];
    await addServer(options<AddFlags>({ flags: { ...flags, name: "treg", auth: "bearer" }, fetch: listsTools() }), "https://moved.example.org/mcp");
    expect(warnings("PROVIDER_KEY_UNSET")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("TREG_MCP_TOKEN was set for other hosts, not moved.example.org") }),
    ]);
    events = [];
    await listMcp(options());
    expect(done()!["data"]["apps"].find((app: { id: string }) => app.id === "treg")).toMatchObject({
      status: "needs setup",
      credential: { kind: "key", set: true, bound: false },
    });
  });
});

describe("the events the mcp commands queue", () => {
  const queued = async () =>
    (await query("SELECT type, actor, data FROM events ORDER BY time, rowid")).map((event) => ({
      type: event["type"],
      actor: JSON.parse(String(event["actor"])),
      data: JSON.parse(String(event["data"])),
    }));

  it("queues one event per change as the login, kind builtin or remote, and none for a run that changes nothing", async () => {
    let clock = Date.parse("2026-10-25T12:00:00Z");
    const tick = { now: () => (clock += 1000) };
    await turnOn(options(tick), "dataforseo");
    await turnOn(options(tick), "dataforseo");
    await turnOff(options(tick), "dataforseo");
    await turnOff(options(tick), "dataforseo");
    await turnOn(options(tick), "dataforseo");
    await removeApp(options(tick), "dataforseo");
    await removeApp(options(tick), "dataforseo");
    await addTreg({ now: tick.now });
    await turnOff(options(tick), "treg");
    await turnOn(options(tick), "treg");
    await removeApp(options(tick), "treg");

    const [dataforseo, treg] = await query(
      "SELECT id, app_slug, name FROM apps WHERE app_slug IN ('dataforseo', 'treg') ORDER BY app_slug",
    );
    const builtin = { app: { id: "dataforseo", rowId: dataforseo!["id"], name: "DataForSEO" }, kind: "builtin" };
    const remote = { app: { id: "treg", rowId: treg!["id"], name: treg!["name"] }, kind: "remote" };
    const actor = { kind: "operator", id: ACTOR, email: ACTOR };
    expect(await queued()).toEqual([
      { type: "mcp_app.added", actor, data: builtin },
      { type: "mcp_app.disabled", actor, data: builtin },
      { type: "mcp_app.enabled", actor, data: builtin },
      { type: "mcp_app.removed", actor, data: builtin },
      // treg's own provider row, written in the add's batch.
      { type: "provider.added", actor, data: { provider: { id: "treg-mcp", name: "treg MCP server", kind: "api_key" } } },
      { type: "mcp_app.added", actor, data: remote },
      { type: "mcp_app.disabled", actor, data: remote },
      { type: "mcp_app.enabled", actor, data: remote },
      { type: "mcp_app.removed", actor, data: remote },
    ]);
  });
});

describe("MCP apps and the other commands", () => {
  it("are left out of status; secret list lists the ones that need setup, naming the MCP app each setting serves", async () => {
    gatewayWorker().secrets["DATAFORSEO_API_KEY"] = "login:password";
    await turnOn(options(), "dataforseo");
    events = [];

    await reportStatus({
      gateway: await existingGateway({ json: true, out: out(), createCf }),
      out: out(),
      checkout: null,
    });
    const status = done()!;
    expect(status["data"]["apps"]).toEqual([]);
    expect((status["data"]["fixes"] as Array<{ code: string }>).map((fix) => fix.code)).not.toContain(
      "SETTINGS_UNKNOWN",
    );

    events = [];
    await listSecrets({ flags, out: out(), cwd: emptyDir(), createCf });
    expect(done()).toMatchObject({ data: { apps: [], gateway: { names: expect.arrayContaining(["DATAFORSEO_API_KEY"]), mcpCredentials: [] } } });
    expect(done()!["message"]).not.toContain("couldn't");

    await addTreg();
    await addServer(options<AddFlags>({ fetch: listsTools() }), "https://deepwiki.com/mcp");
    events = [];
    await listSecrets({ flags, out: out(), cwd: emptyDir(), createCf });
    expect(done()).toMatchObject({
      data: {
        gateway: { mcpCredentials: [{ name: "TREG_MCP_TOKEN", provider: "treg-mcp", apps: ["treg"], set: false, bound: false }] },
        apps: [
          {
            id: "treg",
            setup: {
              ready: false,
              unmet: [expect.objectContaining({ names: ["TREG_MCP_TOKEN"] })],
              command: { command: "pnpm everyapp secret set TREG_MCP_TOKEN" },
            },
          },
        ],
      },
    });
    expect(done()!["message"]).toMatch(/TREG_MCP_TOKEN\s+MCP: treg\s+not set/);
  });

  it("delete refuses an MCP app, naming mcp remove", async () => {
    await addTreg();
    await expect(
      deleteApp({ appId: "treg", out: out(), json: true, interactive: false, purge: false, createCf }),
    ).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      message: "treg is an MCP app, not an app deployed to this Gateway",
      rerun: "pnpm everyapp mcp remove treg",
    });
    expect((await rows()).find((row) => row["app_slug"] === "treg")).toMatchObject({ status: "active" });
  });
});
