/**
 * Remote MCP apps in the Gateway's registry, on the Gateway's real schema
 * on SQLite through `cf d1 query` as the CLI sends it: add (new, revived,
 * every refusal), on and off, remove, the refusals for ids that aren't MCP
 * apps, refresh, one tool's override, what `show` reads, the state `list`
 * gives, and the credential's pin to its origin.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import {
  createSqliteD1,
  GATEWAY_MIGRATIONS_DIR,
  sqliteD1Script,
  type SqliteD1,
} from "@/test/sqliteD1";
import { register, type Deployer } from "./registry";
import {
  addRemoteMcpApp,
  bindRemoteMcpCredentials,
  listMcpApps,
  mcpAppState,
  readCredentialBindings,
  readMcpAppDetail,
  refreshMcpAppTools,
  remoteMcpCredentialNames,
  remoteMcpTables,
  removeMcpApp,
  resolveMcpApp,
  setMcpAppStatus,
  setRemoteMcpTool,
  unbindRemoteMcpCredentials,
  type RemoteMcpAddInput,
} from "./remoteMcpApps";

const DB_ID = "0123456789abcdef0123456789abcdef";
const BEN: Deployer = { actor: "ben@example.com", email: "ben@example.com" };
const NOW = Date.parse("2026-10-25T12:00:00Z");
const ENV = { gatewayUrl: "https://gw.example.com", appBaseDomain: "gw.example.com" };

let sqlite: SqliteD1;
let cf: FakeCf;

beforeEach(async () => {
  sqlite = createSqliteD1();
  cf = new FakeCf().on(["d1"], sqliteD1Script({ [DB_ID]: sqlite }));
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["d1", "migrations", "apply", DB_ID, "--dir", GATEWAY_MIGRATIONS_DIR],
  });
});

const db = () => cfD1Database(cf, DB_ID);

const add = (overrides: Partial<RemoteMcpAddInput> = {}) =>
  addRemoteMcpApp(db(), {
    url: "https://treg.to/mcp/",
    auth: { kind: "bearer" },
    env: ENV,
    deployer: BEN,
    organizationName: "Acme",
    now: NOW,
    ...overrides,
  });

const row = (appSlug: string) =>
  sqlite.all(
    "SELECT id, organization_id, hostname, worker_name, tier, status, manifest, deployed_by_actor FROM apps WHERE app_slug = ?",
    appSlug,
  )[0];
const manifestOf = (appSlug: string) => JSON.parse(String(row(appSlug)!["manifest"]));
const grantees = (appSlug: string) =>
  sqlite
    .all(
      "SELECT user_id FROM user_app_access WHERE app_row_id = (SELECT id FROM apps WHERE app_slug = ?) ORDER BY user_id",
      appSlug,
    )
    .map((r) => r["user_id"]);

function addUser(id: string, organization: string, role = "member"): void {
  sqlite.sqlite
    .prepare("INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)")
    .run(id, id, `${id}@example.com`);
  sqlite.sqlite
    .prepare("INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, 0)")
    .run(`m-${id}`, organization, id, role);
}

/** What the Gateway writes when it lists a remote app's tools: the snapshot, the catalog, the listing. */
function seedListing(appSlug: string): void {
  const app = row(appSlug)!;
  const [id, org] = [String(app["id"]), String(app["organization_id"])];
  sqlite.sqlite
    .prepare(
      "INSERT INTO app_tool_catalogs (app_row_id, organization_id, status, catalog_hash, tool_count, fetched_at) VALUES (?, ?, 'ok', 'h1', 2, ?)",
    )
    .run(id, org, NOW + 60_000);
  const tool = sqlite.sqlite.prepare(
    "INSERT INTO app_tools (app_row_id, organization_id, name, description, risk, input_schema, catalog_hash) VALUES (?, ?, ?, 'd', ?, '{}', 'h1')",
  );
  tool.run(id, org, "get_user", "read");
  tool.run(id, org, "delete_everything", "write");
  const listed = sqlite.sqlite.prepare(
    "INSERT INTO remote_mcp_tools (app_row_id, organization_id, upstream_name, local_name, title, risk_hint, listed, problem, listed_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)",
  );
  listed.run(id, org, "getUser", "get_user", "read", 1, null, NOW + 60_000);
  listed.run(id, org, "delete-everything", "delete_everything", "unknown", 1, null, NOW + 60_000);
  listed.run(id, org, "get.user", null, "write", 0, 'two tools normalize to "get_user"', NOW + 60_000);
}

describe("addRemoteMcpApp", () => {
  it("writes a provider row with the remote block, active at once, granted to the adder, owners and admins", async () => {
    const first = await add({ url: "https://deepwiki.com/mcp", auth: { kind: "none" } });
    const organization = first.organization.id;
    addUser("ben", organization);
    addUser("owner", organization, "owner");
    addUser("admin", organization, "admin");
    addUser("member", organization);

    const added = await add();
    expect(added.plan.kind).toBe("new");
    expect(added.actorGranted).toBe(true);
    expect(added.hasOwner).toBe(true);
    expect(row("treg")).toMatchObject({
      tier: "provider",
      status: "active",
      hostname: null,
      worker_name: null,
      deployed_by_actor: "ben@example.com",
    });
    expect(manifestOf("treg")).toEqual({
      id: "treg",
      name: "treg",
      description: expect.stringContaining("https://treg.to/mcp/"),
      remote: {
        url: "https://treg.to/mcp/",
        auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
        risk: "annotations",
        tools: {},
        rev: 1,
      },
    });
    expect(grantees("treg")).toEqual(["admin", "ben", "owner"]);
  });

  it("refuses what the registry refuses, writing nothing", async () => {
    await add();
    await expect(add()).rejects.toMatchObject({ code: "REMOTE_MCP_EXISTS" });
    await expect(add({ url: "https://apps.gw.example.com/mcp" })).rejects.toMatchObject({
      code: "REMOTE_MCP_URL_REFUSED",
    });
    await expect(add({ url: "https://api.openai.com/mcp" })).rejects.toMatchObject({
      code: "REMOTE_MCP_URL_REFUSED",
    });
    await expect(add({ id: "dataforseo" })).rejects.toMatchObject({ code: "REMOTE_MCP_INVALID" });
    // A credential name another live app sends to another origin.
    await expect(
      add({ url: "https://other.example.org/mcp", id: "other", auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" } }),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_SECRET_TAKEN" });
    expect(row("other")).toBeUndefined();
    await register(db(), {
      appSlug: "crm",
      name: "crm",
      description: "an app",
      manifest: { id: "crm" },
      appBaseDomain: "gw.example.com",
      deployer: BEN,
      organizationName: "Acme",
    });
    await expect(add({ url: "https://crm.example.org/mcp", id: "crm" })).rejects.toMatchObject({
      code: "APP_TIER_MISMATCH",
    });
  });

  it("revives its own tombstone as new: no old access, snapshot or listing", async () => {
    const { organization, plan } = await add();
    addUser("ben", organization.id);
    seedListing("treg");
    await removeMcpApp(db(), (await resolveMcpApp(db(), "treg")).app, NOW + 1);
    sqlite.sqlite
      .prepare("INSERT INTO remote_mcp_tools (app_row_id, organization_id, upstream_name, risk_hint, listed, listed_at) VALUES (?, ?, 'stale', 'unknown', 1, 0)")
      .run(plan.app.id, organization.id);

    const again = await add({ url: "https://treg.to/v2/mcp", now: NOW + 2 });
    expect(again.plan.kind).toBe("revived");
    expect(again.plan.app.id).toBe(plan.app.id);
    expect(row("treg")).toMatchObject({ status: "active" });
    expect(manifestOf("treg").remote.url).toBe("https://treg.to/v2/mcp");
    expect(sqlite.all("SELECT * FROM remote_mcp_tools WHERE app_row_id = ?", plan.app.id)).toEqual([]);
    expect(sqlite.all("SELECT * FROM app_tool_catalogs WHERE app_row_id = ?", plan.app.id)).toEqual([]);
    expect(grantees("treg")).toEqual(["ben"]);
  });
});

describe("on, off and remove", () => {
  it("turns a remote app off and on by status, and removes it with its listing, keeping the credential's pin", async () => {
    const { organization, plan } = await add();
    addUser("ben", organization.id);
    sqlite.sqlite
      .prepare("INSERT INTO user_app_access (id, user_id, app_row_id, organization_id) VALUES ('g1', 'ben', ?, ?)")
      .run(plan.app.id, organization.id);
    seedListing("treg");
    await bindRemoteMcpCredentials(db(), ["TREG_MCP_TOKEN"], "ben@example.com", NOW);
    const ref = await resolveMcpApp(db(), "treg");
    expect(ref).toMatchObject({ kind: "remote", id: "treg", app: { status: "active" } });

    expect(await setMcpAppStatus(db(), ref.app!, "disabled", NOW + 1)).toEqual({ changed: true });
    expect(row("treg")).toMatchObject({ status: "disabled" });
    expect(grantees("treg")).toEqual(["ben"]);
    const off = (await resolveMcpApp(db(), "treg")).app!;
    expect(await setMcpAppStatus(db(), off, "disabled")).toEqual({ changed: false });
    // A row read before someone else turned it on writes nothing.
    sqlite.sqlite.prepare("UPDATE apps SET status = 'active' WHERE app_slug = 'treg'").run();
    await expect(setMcpAppStatus(db(), off, "active")).rejects.toMatchObject({ code: "APP_CHANGING" });

    const live = (await resolveMcpApp(db(), "treg")).app!;
    expect(await removeMcpApp(db(), live, NOW + 2)).toEqual({ removed: true });
    expect(row("treg")).toMatchObject({ status: "deleted" });
    expect(grantees("treg")).toEqual([]);
    expect(sqlite.all("SELECT * FROM remote_mcp_tools")).toEqual([]);
    expect(sqlite.all("SELECT * FROM app_tools")).toEqual([]);
    expect(sqlite.all("SELECT name, origin FROM remote_mcp_credentials")).toEqual([
      { name: "TREG_MCP_TOKEN", origin: "https://treg.to" },
    ]);
    expect(await removeMcpApp(db(), (await resolveMcpApp(db(), "treg")).app, NOW + 3)).toEqual({ removed: false });
    // The tombstone still resolves, so on and show can say how to add it again.
    expect(await resolveMcpApp(db(), "treg")).toMatchObject({ kind: "remote", app: { status: "deleted" } });
  });

  it("answers PROVIDER_APP_UNKNOWN for an id that isn't an MCP app, naming the ones there are", async () => {
    await add();
    await expect(resolveMcpApp(db(), "ahrefs")).rejects.toMatchObject({
      code: "PROVIDER_APP_UNKNOWN",
      message: '"ahrefs" is not an MCP app on this Gateway\nBuilt in: dataforseo. Added: treg.',
      rerun: "pnpm everyapp mcp list",
    });
    await expect(resolveMcpApp(db(), "https://x.example.org/mcp")).rejects.toMatchObject({
      code: "PROVIDER_APP_UNKNOWN",
      rerun: "pnpm everyapp mcp add https://x.example.org/mcp",
    });
    await register(db(), {
      appSlug: "crm",
      name: "crm",
      description: "an app",
      manifest: { id: "crm" },
      appBaseDomain: "gw.example.com",
      deployer: BEN,
      organizationName: "Acme",
    });
    await expect(resolveMcpApp(db(), "crm")).rejects.toMatchObject({
      code: "PROVIDER_APP_UNKNOWN",
      message: expect.stringContaining("pnpm everyapp delete crm removes a deployed app"),
    });
  });
});

describe("refreshMcpAppTools", () => {
  it("drops the snapshot and the catalog, and nothing else", async () => {
    await add();
    seedListing("treg");
    const ref = await resolveMcpApp(db(), "treg");
    expect(await refreshMcpAppTools(db(), ref.app!)).toEqual({
      status: "ok",
      toolCount: 2,
      listedAt: NOW + 60_000,
      lastError: null,
    });
    expect(sqlite.all("SELECT * FROM app_tool_catalogs")).toEqual([]);
    expect(sqlite.all("SELECT * FROM app_tools")).toEqual([]);
    expect(sqlite.all("SELECT upstream_name FROM remote_mcp_tools")).toHaveLength(3);
    expect(row("treg")).toMatchObject({ status: "active" });
    expect(await refreshMcpAppTools(db(), ref.app!)).toBeNull();
  });
});

describe("setRemoteMcpTool", () => {
  it("keys an override by the server's name, found by either name, and bumps the revision", async () => {
    await add();
    seedListing("treg");
    const ref = async () => {
      const found = await resolveMcpApp(db(), "treg");
      return { ...found, app: found.app! };
    };

    expect(await setRemoteMcpTool(db(), await ref(), "treg_delete_everything", { risk: "destructive" })).toEqual({
      serverName: "delete-everything",
      listedName: "treg_delete_everything",
      inListing: true,
      before: null,
      after: { risk: "destructive" },
      rev: 2,
    });
    expect(await setRemoteMcpTool(db(), await ref(), "delete-everything", { enabled: false })).toMatchObject({
      before: { risk: "destructive" },
      after: { risk: "destructive", enabled: false },
      rev: 3,
    });
    expect(await setRemoteMcpTool(db(), await ref(), "get_user", { risk: "write" })).toMatchObject({
      serverName: "getUser",
      after: { risk: "write" },
    });
    // annotations drops the risk override; on drops enabled: false.
    expect(
      await setRemoteMcpTool(db(), await ref(), "delete-everything", { risk: "annotations", enabled: true }),
    ).toMatchObject({ after: null, rev: 5 });
    expect(manifestOf("treg").remote.tools).toEqual({ getUser: { risk: "write" } });

    // A name the listing doesn't have is the server's, verbatim.
    expect(await setRemoteMcpTool(db(), await ref(), "brandNew", { enabled: false })).toMatchObject({
      serverName: "brandNew",
      listedName: null,
      inListing: false,
    });
    expect(manifestOf("treg").remote).toMatchObject({ tools: { brandNew: { enabled: false } }, rev: 6 });
  });

  it("writes over the manifest it read only, reading it again when it changed", async () => {
    await add();
    const stale = await resolveMcpApp(db(), "treg");
    await setRemoteMcpTool(db(), { ...stale, app: stale.app! }, "a", { risk: "read" });
    // The second write starts from the row read before the first: it re-reads and keeps both.
    await setRemoteMcpTool(db(), { ...stale, app: stale.app! }, "b", { risk: "write" });
    expect(manifestOf("treg").remote).toMatchObject({ tools: { a: { risk: "read" }, b: { risk: "write" } }, rev: 3 });
  });
});

describe("readMcpAppDetail", () => {
  it("lists each tool with its effective risk, its source, and why it isn't on", async () => {
    await add();
    seedListing("treg");
    let ref = await resolveMcpApp(db(), "treg");
    await setRemoteMcpTool(db(), { ...ref, app: ref.app! }, "get.user", { enabled: false });
    ref = await resolveMcpApp(db(), "treg");
    const remote = manifestOf("treg").remote;
    const detail = await readMcpAppDetail(db(), { ...ref, app: ref.app! }, remote);
    expect(detail.snapshot).toMatchObject({ status: "ok", toolCount: 2 });
    expect(detail.listingKnown).toBe(true);
    expect(detail.remoteTools).toEqual([
      {
        name: "treg_delete_everything",
        serverName: "delete-everything",
        title: null,
        risk: "write",
        source: "default",
        on: true,
        problem: null,
      },
      { name: null, serverName: "get.user", title: null, risk: "write", source: "hint", on: false, problem: "turned off" },
      { name: "treg_get_user", serverName: "getUser", title: null, risk: "read", source: "hint", on: true, problem: null },
    ]);
  });
});

describe("listMcpApps and mcpAppState", () => {
  it("lists the built-ins, then each live remote app, with its state against the Gateway's names and pins", async () => {
    await add();
    await add({ url: "https://deepwiki.com/mcp", auth: { kind: "none" } });
    seedListing("treg");
    const entries = await listMcpApps(db());
    expect(entries.map((entry) => [entry.id, entry.kind, entry.keyName])).toEqual([
      ["dataforseo", "builtin", "DATAFORSEO_API_KEY"],
      ["deepwiki", "remote", null],
      ["treg", "remote", "TREG_MCP_TOKEN"],
    ]);
    expect(entries[2]!.snapshot).toMatchObject({ toolCount: 2 });
    const state = (id: string, names: string[], pins = new Map()) =>
      mcpAppState(entries.find((entry) => entry.id === id)!, names, pins);
    expect(state("dataforseo", [])).toBe("not added");
    expect(state("deepwiki", [])).toBe("on");
    expect(state("treg", [])).toBe("needs setup");
    expect(state("treg", ["TREG_MCP_TOKEN"])).toBe("on");
    expect(
      state("treg", ["TREG_MCP_TOKEN"], new Map([["TREG_MCP_TOKEN", { origin: "https://elsewhere.example", boundBy: null, boundAt: null }]])),
    ).toBe("needs setup");
  });
});

describe("the credential's pin", () => {
  it("pins a set credential to the origin of the live app that declares it, and drops the pin on unset", async () => {
    await add();
    expect(await remoteMcpTables(db())).toEqual({ credentials: true, tools: true });
    expect(await bindRemoteMcpCredentials(db(), ["TREG_MCP_TOKEN", "OPENAI_API_KEY", "LOST_MCP_TOKEN"], "ben@example.com", NOW)).toEqual({
      bound: [{ name: "TREG_MCP_TOKEN", origin: "https://treg.to" }],
      undeclared: [{ name: "LOST_MCP_TOKEN", kept: null }],
      ambiguous: [],
    });
    expect([...(await readCredentialBindings(db()))]).toEqual([
      ["TREG_MCP_TOKEN", { origin: "https://treg.to", boundBy: "ben@example.com", boundAt: NOW }],
    ]);
    // Set again after the app is gone: the old pin stays.
    await removeMcpApp(db(), (await resolveMcpApp(db(), "treg")).app, NOW);
    expect((await bindRemoteMcpCredentials(db(), ["TREG_MCP_TOKEN"], "ben@example.com", NOW + 1)).undeclared).toEqual([
      { name: "TREG_MCP_TOKEN", kept: "https://treg.to" },
    ]);
    expect(await unbindRemoteMcpCredentials(db(), ["TREG_MCP_TOKEN", "OPENAI_API_KEY"])).toEqual(["TREG_MCP_TOKEN"]);
    expect(await readCredentialBindings(db())).toEqual(new Map());
  });

  it("pins nothing when live apps at two origins declare the name (a row edited by hand)", async () => {
    await add();
    await add({ url: "https://two.example.org/mcp", id: "two", auth: { kind: "bearer", secret: "TWO_MCP_TOKEN" } });
    const manifest = manifestOf("two");
    manifest.remote.auth.secret = "TREG_MCP_TOKEN";
    sqlite.sqlite.prepare("UPDATE apps SET manifest = ? WHERE app_slug = 'two'").run(JSON.stringify(manifest));
    expect(await remoteMcpCredentialNames(db())).toEqual(new Map([["TREG_MCP_TOKEN", ["treg", "two"]]]));
    expect(await bindRemoteMcpCredentials(db(), ["TREG_MCP_TOKEN"], "ben@example.com", NOW)).toMatchObject({
      bound: [],
      ambiguous: [{ name: "TREG_MCP_TOKEN", origins: ["https://treg.to", "https://two.example.org"] }],
    });
  });

  it("does nothing on a Gateway whose D1 predates migration 0011", async () => {
    sqlite.sqlite.exec("DROP TABLE remote_mcp_credentials; DROP TABLE remote_mcp_tools;");
    expect(await remoteMcpTables(db())).toEqual({ credentials: false, tools: false });
    await add();
    expect(await bindRemoteMcpCredentials(db(), ["TREG_MCP_TOKEN"], "ben@example.com")).toEqual({
      bound: [],
      undeclared: [],
      ambiguous: [],
    });
    expect(await unbindRemoteMcpCredentials(db(), ["TREG_MCP_TOKEN"])).toEqual([]);
    expect(await readCredentialBindings(db())).toEqual(new Map());
    expect(await removeMcpApp(db(), (await resolveMcpApp(db(), "treg")).app)).toEqual({ removed: true });
  });
});
