/**
 * `everyapp mcp add|remove|on|off|list|show|refresh|tool` end to end, in a
 * fake Cloudflare account with a deployed gateway (as secret/index.test.ts):
 * the rows, the access, the probe's warnings, the credential offered and
 * pinned, each key's state as a warning and in the list, the tools a show
 * reads, and how secret set, secret list, delete and status treat MCP apps.
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

  it("tombstones a remote app and keeps its credential and pin, saying what removes them", async () => {
    await addTreg(settingNow("treg-secret"));
    events = [];
    await removeApp(options(), "treg");
    expect(done()).toMatchObject({ data: { id: "treg", kind: "remote", removed: true } });
    expect(done()!["message"]).toContain(
      "TREG_MCP_TOKEN stays on the Gateway, pinned to https://treg.to: pnpm everyapp secret unset TREG_MCP_TOKEN removes both.",
    );
    expect(done()!["message"]).toContain(`pnpm everyapp mcp add ${TREG} --name treg adds it again`);
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBe("treg-secret");
    expect(await query("SELECT name, origin FROM remote_mcp_credentials")).toEqual([
      { name: "TREG_MCP_TOKEN", origin: "https://treg.to" },
    ]);
  });
});

describe("mcp add", () => {
  it("writes the row, probes the server once without a credential, and says to set the credential", async () => {
    const fetch = listsTools();
    await addTreg({ fetch });

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(await rows()).toEqual([
      { app_slug: "treg", tier: "provider", status: "active", hostname: null, worker_name: null },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
    expect(events.find((event) => event["step"] === "mcp.probe" && event["status"] === "ok")).toMatchObject({
      message: `${TREG} answers MCP (2026-07-28, 2 tools, server treg)`,
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
        auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
        risk: "annotations",
        on: true,
        was: "new",
        probe: { outcome: "reachable", era: "2026-07-28", tools: 2, server: "treg" },
        key: { name: "TREG_MCP_TOKEN", set: false, bound: false, boundOrigin: null },
        mcp: { url: "https://example.com/mcp", toolPrefix: "treg_" },
        granted: [],
        next: [
          { command: "pnpm everyapp secret set TREG_MCP_TOKEN", note: "treg's credential" },
          { command: "pnpm everyapp mcp show treg", note: "its tools, once the Gateway lists them" },
        ],
      },
    });
    expect(done()!["message"]).toContain("TREG_MCP_TOKEN isn't set: pnpm everyapp secret set TREG_MCP_TOKEN");
  });

  it("at a terminal, offers the credential through secret set's reader, sets it on the Gateway and pins it to the origin", async () => {
    const asked: Array<{ question: string; context?: readonly string[] }> = [];
    const read: string[] = [];
    await addTreg({
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
          "The Gateway sends it to https://treg.to and nowhere else. Later: pnpm everyapp secret set TREG_MCP_TOKEN",
        ],
      },
    ]);
    expect(read).toEqual(["TREG_MCP_TOKEN"]);
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBe("treg-secret");
    expect(await query("SELECT name, origin, bound_by FROM remote_mcp_credentials")).toEqual([
      { name: "TREG_MCP_TOKEN", origin: "https://treg.to", bound_by: ACTOR },
    ]);
    expect(warnings("PROVIDER_KEY_UNSET")).toEqual([]);
    expect(done()!["data"]).toMatchObject({ key: { name: "TREG_MCP_TOKEN", set: true, bound: true, boundOrigin: "https://treg.to" } });
    expect(done()!["data"]["next"]).toEqual([{ command: "pnpm everyapp mcp show treg", note: "its tools, once the Gateway lists them" }]);
    expect(JSON.stringify(events)).not.toContain("treg-secret");
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
    expect(done()!["data"]).toMatchObject({ key: { set: true, bound: true } });

    vi.stubEnv("EMPTY_KEY", "");
    await expect(
      addServer(options<AddFlags>({ flags: { ...flags, name: "other", auth: "bearer", "from-env": "EMPTY_KEY" }, fetch: listsTools() }), "https://other.example.org/mcp"),
    ).rejects.toMatchObject({ code: "SECRET_EMPTY", message: "$EMPTY_KEY is empty or not set" });
    expect((await rows()).map((row) => row["app_slug"])).toEqual(["treg"]);
    await expect(
      addServer(options<AddFlags>({ flags: { ...flags, "from-env": "TREG_KEY" } }), "https://deepwiki.com/mcp"),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_INVALID", message: "--from-env names a credential, and --auth none sends none" });
  });

  it("asks nothing for a server that takes no credential, and warns when it asks for one", async () => {
    const confirm = vi.fn();
    await addServer(
      options<AddFlags>({
        interactive: true,
        confirm,
        fetch: serverAnswering(() => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="x"' } })),
      }),
      "https://deepwiki.com/mcp",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(done()!["data"]).toMatchObject({ id: "deepwiki", auth: { kind: "none" }, key: null, probe: { outcome: "needs-credential", status: 401 } });
    expect(warnings("REMOTE_MCP_PROBE_FAILED")).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/^https:\/\/deepwiki.com\/mcp asks for a credential, and deepwiki sends none\n/),
        data: expect.objectContaining({
          fix: "pnpm everyapp mcp remove deepwiki, then pnpm everyapp mcp add https://deepwiki.com/mcp --name deepwiki --auth bearer",
        }),
      }),
    ]);
  });

  it("warns, never refuses, when the server wants OAuth, redirects, or can't be reached", async () => {
    await addServer(
      options<AddFlags>({
        flags: { ...flags, name: "o" },
        fetch: serverAnswering(
          () =>
            new Response("", {
              status: 401,
              headers: { "www-authenticate": 'Bearer resource_metadata="https://o.example.org/.well-known/oauth-protected-resource"' },
            }),
        ),
      }),
      "https://o.example.org/mcp",
    );
    expect(warnings("REMOTE_MCP_WANTS_OAUTH")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("If the server also takes an API key, add it with --auth bearer and set the key.") }),
    ]);
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
      ["o", "active"],
    ]);
  });

  it("refuses flags that say two things before connecting, and what the registry refuses before writing", async () => {
    createCf.mockClear();
    await expect(
      addServer(options<AddFlags>({ flags: { ...flags, auth: "bearer", header: "X-Api-Key" } }), TREG),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_INVALID" });
    await expect(addServer(options<AddFlags>({ flags: { ...flags, auth: "header" } }), TREG)).rejects.toMatchObject({
      code: "REMOTE_MCP_INVALID",
    });
    await expect(
      addServer(options<AddFlags>({ flags: { ...flags, auth: "none", secret: "TREG_MCP_TOKEN" } }), TREG),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_INVALID" });
    expect(createCf).not.toHaveBeenCalled();
    await expect(addServer(options<AddFlags>({ fetch: listsTools() }), "https://apps.example.com/mcp")).rejects.toMatchObject({
      code: "REMOTE_MCP_URL_REFUSED",
    });
    await addTreg();
    await expect(addTreg()).rejects.toMatchObject({ code: "REMOTE_MCP_EXISTS" });
    expect((await rows()).map((row) => row["app_slug"])).toEqual(["treg"]);
  });

  it("takes --header for header auth and --secret for another name in the family", async () => {
    await addServer(
      options<AddFlags>({
        flags: { ...flags, name: "example", header: "X-Api-Key", secret: "EXAMPLE_KEY_MCP_TOKEN", risk: "read" },
        fetch: listsTools(),
      }),
      "https://api.example.org/mcp",
    );
    expect(done()!["data"]).toMatchObject({
      id: "example",
      auth: { kind: "header", secret: "EXAMPLE_KEY_MCP_TOKEN", header: "X-Api-Key" },
      risk: "read",
      key: { name: "EXAMPLE_KEY_MCP_TOKEN", set: false },
    });
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
    await addServer(options<AddFlags>({ flags: { ...flags, name: "o", auth: "oauth" }, fetch: listsTools() }), "https://o.example.org/mcp");
    await turnOff(options(), "deepwiki");
    events = [];
    await listMcp(options());
    expect(done()).toMatchObject({
      message: "3 of 4 MCP apps on",
      data: {
        apps: [
          { id: "dataforseo", kind: "builtin", status: "on", on: true, key: { set: true } },
          { id: "deepwiki", kind: "remote", status: "off", on: false, url: "https://deepwiki.com/mcp", auth: { kind: "none" }, supported: true, tools: null, key: null },
          { id: "o", kind: "remote", status: "on", auth: { kind: "oauth" }, supported: false, key: null },
          {
            id: "treg",
            kind: "remote",
            status: "needs setup",
            on: true,
            url: TREG,
            auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
            tools: 2,
            key: { name: "TREG_MCP_TOKEN", set: false, bound: false, boundOrigin: null },
            lastListedAt: "2026-10-25T12:05:00.000Z",
          },
        ],
        next: [{ command: "pnpm everyapp secret set TREG_MCP_TOKEN", note: "treg's credential" }],
      },
    });
  });

  it("draws the table a person reads", async () => {
    await addTreg();
    events = [];
    await listMcp({ flags: {}, out: { emit: (event) => events.push(event as never), exitCode: 0, verbose: false }, createCf });
    const display = String(done()!["display"]).replace(/\u001b\[[0-9;]*m/g, "");
    expect(display).toMatch(/^APP\s+KIND\s+STATUS\s+TOOLS\s+KEY\n/);
    expect(display).toMatch(/dataforseo  DataForSEO\s+built-in\s+not added\s+not listed yet\s+DATAFORSEO_API_KEY not set/);
    expect(display).toMatch(/treg  treg\s+remote\s+needs setup\s+not listed yet\s+TREG_MCP_TOKEN not set/);
  });
});

describe("mcp show", () => {
  it("shows a remote app's facts, its credential and pin, its snapshot, and every tool with its risk and source", async () => {
    await addTreg(settingNow("treg-secret"));
    await seedTregListing();
    await changeTool(options<ToolFlags>({ flags: { ...flags, risk: "destructive" } }), "treg", "delete-everything");
    events = [];
    await showApp(options(), "treg");
    expect(done()).toMatchObject({
      data: {
        id: "treg",
        kind: "remote",
        status: "on",
        on: true,
        url: TREG,
        auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
        risk: "annotations",
        rev: 2,
        overrides: { "delete-everything": { risk: "destructive" } },
        addedBy: ACTOR,
        key: { name: "TREG_MCP_TOKEN", set: true, bound: true, boundOrigin: "https://treg.to" },
        snapshot: { status: "ok", tools: 2, listedAt: "2026-10-25T12:05:00.000Z", lastError: null },
        tools: [
          { name: "treg_delete_everything", serverName: "delete-everything", risk: "write", source: "override", on: true },
          { name: "treg_get_user", serverName: "getUser", risk: "read", source: "hint", on: true },
        ],
        mcp: { url: "https://example.com/mcp", toolPrefix: "treg_" },
      },
    });
    expect(done()!["message"]).toMatch(/URL\s+https:\/\/treg\.to\/mcp\//);
    expect(done()!["message"]).toMatch(/Credential\s+TREG_MCP_TOKEN set, pinned to https:\/\/treg\.to/);
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

  it("routes the name to the Gateway, pins it to the declaring app's origin, and unset drops the pin", async () => {
    await addTreg();
    events = [];
    await set("TREG_MCP_TOKEN");
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBe("value-of-TREG_MCP_TOKEN");
    expect(await query("SELECT name, origin, bound_by FROM remote_mcp_credentials")).toEqual([
      { name: "TREG_MCP_TOKEN", origin: "https://treg.to", bound_by: ACTOR },
    ]);
    expect(warnings("REMOTE_MCP_SECRET_UNDECLARED")).toEqual([]);
    // Where the credential goes is said every time it is set.
    expect(done()).toMatchObject({
      message: "Set TREG_MCP_TOKEN on the Gateway\nTREG_MCP_TOKEN is sent to https://treg.to and nowhere else.",
      data: { gateway: { names: ["TREG_MCP_TOKEN"], pinned: [{ name: "TREG_MCP_TOKEN", origin: "https://treg.to" }] } },
    });

    events = [];
    await unset("TREG_MCP_TOKEN");
    expect(gatewayWorker().secrets["TREG_MCP_TOKEN"]).toBeUndefined();
    expect(await query("SELECT * FROM remote_mcp_credentials")).toEqual([]);
  });

  it("warns when no MCP app declares the name", async () => {
    await set("LOST_MCP_TOKEN");
    expect(gatewayWorker().secrets["LOST_MCP_TOKEN"]).toBe("value-of-LOST_MCP_TOKEN");
    expect(warnings("REMOTE_MCP_SECRET_UNDECLARED")).toEqual([
      expect.objectContaining({
        message: "No MCP app declares LOST_MCP_TOKEN\nThe Gateway pins it to the first MCP app that uses it.",
        data: expect.objectContaining({ name: "LOST_MCP_TOKEN", pinnedTo: null }),
      }),
    ]);
    expect(await query("SELECT * FROM remote_mcp_credentials")).toEqual([]);
  });

  it("warns at add when the credential is pinned to another origin, and list says it needs setup", async () => {
    await addTreg(settingNow("treg-secret"));
    await removeApp(options(), "treg");
    // Another server takes the same credential name: its pin to treg.to stays.
    events = [];
    await addServer(
      options<AddFlags>({ flags: { ...flags, name: "treg2", secret: "TREG_MCP_TOKEN" }, fetch: listsTools() }),
      "https://moved.example.org/mcp",
    );
    expect(warnings("REMOTE_MCP_SECRET_BOUND_ELSEWHERE")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("TREG_MCP_TOKEN was set for https://treg.to, not https://moved.example.org"),
      }),
    ]);
    events = [];
    await listMcp(options());
    expect(done()!["data"]["apps"].find((app: { id: string }) => app.id === "treg2")).toMatchObject({
      status: "needs setup",
      key: { name: "TREG_MCP_TOKEN", set: true, bound: false, boundOrigin: "https://treg.to" },
    });
  });
});

describe("MCP apps and the other commands", () => {
  it("are left out of status; secret list lists the ones that need setup, with each credential's name", async () => {
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
        gateway: { mcpCredentials: [{ name: "TREG_MCP_TOKEN", apps: ["treg"], set: false }] },
        apps: [
          {
            id: "treg",
            setup: {
              ready: false,
              unmet: [expect.objectContaining({ kind: "remote-mcp", names: ["TREG_MCP_TOKEN"], setup: "setup/remote-mcp.md" })],
              command: { command: "pnpm everyapp secret set TREG_MCP_TOKEN" },
            },
          },
        ],
      },
    });
    expect(done()!["message"]).toMatch(/TREG_MCP_TOKEN\s+not set/);
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
