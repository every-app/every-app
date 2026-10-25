/**
 * The app registry the CLI writes in the gateway's D1, against the
 * gateway's real schema on SQLite, through `cf d1 query` as a deploy sends
 * it: registering before and after the gateway has an owner, the takeover
 * checks, the actor, tombstones and their revival, and the live wait.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { LiveWaitVerb, waitForLive } from "@/commands/deploy/steps/waitForLive";
import { cfD1Database } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createNdjsonSink } from "@/lib/output/events";
import {
  createSqliteD1,
  GATEWAY_MIGRATIONS_DIR,
  sqliteD1Script,
  type SqliteD1,
} from "@/test/sqliteD1";
import {
  deleteApp,
  deployerFor,
  installOrganization,
  listApps,
  markDeployed,
  readApp,
  readAppEmail,
  register,
  writeAppEmail,
  writeAppSecretNames,
  type Deployer,
  type RegisterInput,
  hasSecretNamesColumn,
  readAppById,
  withoutAppData,
} from "./registry";

const DB_ID = "0123456789abcdef0123456789abcdef";
const BASE = "apps.example.com";
const DEPLOYER: Deployer = { actor: "dev@example.com", email: "dev@example.com" };

let sqlite: SqliteD1;
let cf: FakeCf;
let events: Array<Record<string, any>>;

beforeEach(async () => {
  sqlite = createSqliteD1();
  cf = new FakeCf().on(["d1"], sqliteD1Script({ [DB_ID]: sqlite }));
  // The gateway's schema, the way a deploy migrates it.
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["d1", "migrations", "apply", DB_ID, "--dir", GATEWAY_MIGRATIONS_DIR],
  });
  cf.calls.length = 0;
  events = [];
});

const db = () => cfD1Database(cf, DB_ID);
const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));

function registerApp(appSlug: string, overrides: Partial<RegisterInput> = {}) {
  return register(db(), {
    appSlug,
    name: appSlug,
    description: appSlug,
    manifest: { id: appSlug },
    appBaseDomain: BASE,
    deployer: DEPLOYER,
    organizationName: "Acme",
    ...overrides,
  });
}

const app = (appSlug: string) =>
  sqlite.all(
    "SELECT organization_id, app_slug, hostname, worker_name, status, manifest, version_id, deployed_at, deployed_by_actor, is_default, email_senders, email_inbound, secret_names FROM apps WHERE app_slug = ?",
    appSlug,
  )[0];
const grantees = (appSlug: string) =>
  sqlite
    .all(
      "SELECT user_id FROM user_app_access WHERE app_row_id = (SELECT id FROM apps WHERE app_slug = ?) ORDER BY user_id",
      appSlug,
    )
    .map((row) => row["user_id"]);

/** A user, with an organization role when `organization` is given. */
function addUser(
  id: string,
  {
    email = `${id}@example.com`,
    verified = true,
    organization,
    role = "member",
  }: { email?: string; verified?: boolean; organization?: string; role?: string } = {},
): void {
  sqlite.sqlite
    .prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
    )
    .run(id, id, email, verified ? 1 : 0);
  if (organization) {
    sqlite.sqlite
      .prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, 0)",
      )
      .run(`member-${id}`, organization, id, role);
  }
}

function addOrganization(id: string, slug: string, createdAt: number): void {
  sqlite.sqlite
    .prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run(id, slug, slug, createdAt);
}

describe("register", () => {
  it("registers before the gateway has an owner: in an organization it makes, granting nobody", async () => {
    const first = await registerApp("todo");

    // The install's organization, named after the Cloudflare account, with
    // no members for the setup claim to adopt.
    expect(sqlite.all("SELECT name, slug FROM organizations")).toEqual([
      { name: "Acme", slug: "acme" },
    ]);
    expect(sqlite.all("SELECT org_key FROM organization_keys")).toEqual([
      { org_key: "acme" },
    ]);
    expect(first).toMatchObject({
      hasOwner: false,
      deployerGranted: false,
      plan: { kind: "new", grants: [] },
    });
    expect(app("todo")).toMatchObject({
      hostname: `todo.${BASE}`,
      worker_name: "every-acme-todo",
      status: "pending",
      is_default: 0,
      version_id: null,
      deployed_by_actor: null,
    });
    // The deployer has no gateway account yet: nobody has access.
    expect(grantees("todo")).toEqual([]);

    // The next app goes to the same organization, under the same key.
    const second = await registerApp("chef", { organizationName: "Other" });
    expect(second.organization).toEqual(first.organization);
    expect(app("chef")).toMatchObject({ worker_name: "every-acme-chef" });
    expect(sqlite.all("SELECT COUNT(*) AS n FROM organizations")).toEqual([{ n: 1 }]);
  });

  it("registers into the owner's organization once there is one, granting the deployer, owners and admins", async () => {
    // An older organization nobody owns, and the owner's.
    addOrganization("org-old", "old", 1);
    addOrganization("org-1", "acme", 2);
    addUser("owner", { organization: "org-1", role: "owner" });
    addUser("admin", { organization: "org-1", role: "member,admin" });
    addUser("member", { organization: "org-1" });
    addUser("dev", { email: "DEV@example.com", organization: "org-1" });

    const registered = await registerApp("todo");

    expect(registered).toMatchObject({
      hasOwner: true,
      deployerGranted: true,
      organization: { id: "org-1", slug: "acme" },
    });
    expect(app("todo")).toMatchObject({
      organization_id: "org-1",
      hostname: `todo.${BASE}`,
      worker_name: "every-acme-todo",
    });
    expect(grantees("todo")).toEqual(["admin", "dev", "owner"]);

    // An unverified account with the login's email gets nothing for it.
    sqlite.sqlite.exec("UPDATE users SET email_verified = 0 WHERE id = 'dev'");
    await expect(registerApp("chef")).resolves.toMatchObject({ deployerGranted: false });
    expect(grantees("chef")).toEqual(["admin", "owner"]);

    // An API token is nobody's account.
    sqlite.sqlite.exec("UPDATE users SET email_verified = 1 WHERE id = 'dev'");
    await registerApp("notes", { deployer: { actor: "api-token:acct", email: null } });
    expect(grantees("notes")).toEqual(["admin", "owner"]);

    // `access: "everyone"`: every member, and members to come.
    await registerApp("board", { manifest: { id: "board", access: "everyone" } });
    expect(grantees("board")).toEqual(["admin", "dev", "member", "owner"]);
    expect(app("board")).toMatchObject({ is_default: 1 });
  });

  it("keeps a redeployed app's names, status and access, and updates its name", async () => {
    addOrganization("org-1", "acme", 1);
    addUser("owner", { organization: "org-1", role: "owner" });
    const first = await registerApp("todo");
    await markDeployed(db(), first.plan.app.id, {
      versionId: "v1",
      manifest: { id: "todo" },
      actor: DEPLOYER.actor,
    });
    sqlite.sqlite.exec("UPDATE apps SET status = 'active'");
    sqlite.sqlite.exec("DELETE FROM user_app_access");

    const again = await registerApp("todo", {
      name: "Todos",
      manifest: { id: "todo", access: "everyone" },
    });

    expect(again.plan).toMatchObject({
      kind: "existing",
      grants: [],
      versionId: "v1",
      previousManifest: { id: "todo" },
    });
    expect(app("todo")).toMatchObject({ status: "active", is_default: 0, version_id: "v1" });
    expect(sqlite.all("SELECT name FROM apps")).toEqual([{ name: "Todos" }]);
    expect(grantees("todo")).toEqual([]);
  });

  it("refuses a hostname or Worker name another organization holds, tombstones included", async () => {
    addOrganization("org-1", "acme", 1);
    addUser("owner", { organization: "org-1", role: "owner" });
    addOrganization("org-2", "other", 2);
    sqlite.sqlite.exec(`
      INSERT INTO organization_keys (organization_id, org_key) VALUES ('org-2', 'other');
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, status)
        VALUES ('theirs-todo', 'org-2', 'todo', 'todo', 'todo', 'todo.${BASE}', 'every-other-todo', 'deleted');
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, status)
        VALUES ('theirs-chef', 'org-2', 'kitchen', 'kitchen', 'kitchen', 'kitchen-other.${BASE}', 'every-acme-chef', 'active');
    `);

    await expect(registerApp("todo")).rejects.toMatchObject({
      name: "EveryAppError",
      code: "HOSTNAME_TAKEN",
    });
    await expect(registerApp("chef")).rejects.toMatchObject({ code: "WORKER_NAME_TAKEN" });
    await expect(registerApp("everyapp")).rejects.toMatchObject({ code: "RESERVED_APP_ID" });
    expect(
      sqlite.all("SELECT app_slug FROM apps WHERE organization_id = 'org-1'"),
    ).toEqual([]);
  });

  it("claims the next free key when another organization holds its slug's", async () => {
    addOrganization("org-2", "acme-two", 1);
    sqlite.sqlite.exec(
      "INSERT INTO organization_keys (organization_id, org_key) VALUES ('org-2', 'acme')",
    );
    addOrganization("org-1", "acme", 2);
    addUser("owner", { organization: "org-1", role: "owner" });

    await registerApp("todo");

    expect(
      sqlite.all("SELECT org_key FROM organization_keys WHERE organization_id = 'org-1'"),
    ).toEqual([{ org_key: "acme2" }]);
    expect(app("todo")).toMatchObject({ worker_name: "every-acme2-todo" });
  });
});

describe("markDeployed", () => {
  it("records the version, its manifest and who deployed it, and moves a new app to binding", async () => {
    const { plan } = await registerApp("todo");

    const status = await markDeployed(db(), plan.app.id, {
      versionId: "v1",
      manifest: { id: "todo", public: [{ path: "/health" }] },
      actor: "dev@example.com",
      now: 1_700_000_000_000,
    });

    expect(status).toBe("binding");
    expect(app("todo")).toMatchObject({
      status: "binding",
      version_id: "v1",
      deployed_at: 1_700_000_000_000,
      deployed_by_actor: "dev@example.com",
      manifest: JSON.stringify({ id: "todo", public: [{ path: "/health" }] }),
      // No deploy listed the Worker's secrets yet.
      secret_names: null,
    });
    await expect(readApp(db(), "todo")).resolves.toMatchObject({
      manifest: { id: "todo", public: [{ path: "/health" }] },
      secretNames: null,
    });

    // An app an admin switched off stays off.
    sqlite.sqlite.exec("UPDATE apps SET status = 'disabled'");
    await expect(
      markDeployed(db(), plan.app.id, { versionId: "v2", manifest: { id: "todo" }, actor: "api-token:acct" }),
    ).resolves.toBe("disabled");
    expect(app("todo")).toMatchObject({ version_id: "v2", deployed_by_actor: "api-token:acct" });
  });

  it("refuses an app deleted meanwhile", async () => {
    const { plan } = await registerApp("todo");
    await deleteApp(db(), "todo", DEPLOYER);

    await expect(
      markDeployed(db(), plan.app.id, { versionId: "v1", manifest: { id: "todo" }, actor: "x" }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });

  it("records the Worker's secret names when the deploy listed them, and keeps them when it didn't", async () => {
    const { plan } = await registerApp("todo");

    await markDeployed(db(), plan.app.id, {
      versionId: "v1",
      manifest: { id: "todo", secrets: ["MAIN_SECRET"] },
      actor: "x",
      secretNames: ["MAIN_SECRET", "GITHUB_TOKEN", "MAIN_SECRET"],
    });
    expect(app("todo")).toMatchObject({ secret_names: '["GITHUB_TOKEN","MAIN_SECRET"]' });
    await expect(readApp(db(), "todo")).resolves.toMatchObject({
      secretNames: ["GITHUB_TOKEN", "MAIN_SECRET"],
    });

    // A deploy that couldn't list them leaves the record as it was.
    await markDeployed(db(), plan.app.id, { versionId: "v2", manifest: { id: "todo" }, actor: "x" });
    expect(app("todo")).toMatchObject({ version_id: "v2", secret_names: '["GITHUB_TOKEN","MAIN_SECRET"]' });
  });
});

describe("writeAppSecretNames", () => {
  it("records the names on the row, sorted and each once, and a deleted app's go with it", async () => {
    const { plan } = await registerApp("todo");

    await writeAppSecretNames(db(), plan.app.id, ["STRIPE_KEY", "GITHUB_TOKEN"]);
    expect(app("todo")).toMatchObject({ secret_names: '["GITHUB_TOKEN","STRIPE_KEY"]' });
    await expect(listApps(db())).resolves.toEqual([
      expect.objectContaining({ secretNames: ["GITHUB_TOKEN", "STRIPE_KEY"] }),
    ]);

    await writeAppSecretNames(db(), plan.app.id, []);
    expect(app("todo")).toMatchObject({ secret_names: "[]" });

    await writeAppSecretNames(db(), plan.app.id, ["GITHUB_TOKEN"]);
    await deleteApp(db(), "todo", DEPLOYER);
    expect(app("todo")).toMatchObject({ status: "deleted", secret_names: null });
    // A tombstone keeps none: the write is a no-op, and a revived app starts unrecorded.
    await writeAppSecretNames(db(), plan.app.id, ["GITHUB_TOKEN"]);
    expect(app("todo")).toMatchObject({ secret_names: null });
    await registerApp("todo");
    await expect(readApp(db(), "todo")).resolves.toMatchObject({ secretNames: null });
  });
});

describe("deployerFor", () => {
  it("is the login's email, or the account's API token", () => {
    expect(deployerFor("dev@example.com", "acct", {})).toEqual({
      actor: "dev@example.com",
      email: "dev@example.com",
    });
    expect(deployerFor("dev@example.com", "acct", { CLOUDFLARE_API_TOKEN: "t" })).toEqual({
      actor: "api-token:acct",
      email: null,
    });
    expect(deployerFor(null, "acct", {})).toEqual({ actor: "api-token:acct", email: null });
  });
});

describe("deleteApp", () => {
  /**
   * An owner, a member with access (directly and through a group) and a
   * token, its tools, an AI connection and a cap.
   */
  function withAppData(appRowId: string, organizationId: string): void {
    addUser("member", { organization: organizationId });
    sqlite.sqlite.exec(`
      INSERT INTO user_app_access (id, user_id, app_row_id, organization_id) VALUES ('access-member', 'member', '${appRowId}', '${organizationId}');
      INSERT OR IGNORE INTO groups (id, organization_id, name) VALUES ('grp_writers', '${organizationId}', 'Writers');
      INSERT OR IGNORE INTO group_members (group_id, user_id, organization_id) VALUES ('grp_writers', 'member', '${organizationId}');
      INSERT INTO group_app_access (group_id, app_row_id, organization_id) VALUES ('grp_writers', '${appRowId}', '${organizationId}');
      INSERT INTO user_access_tokens (id, user_id, organization_id, app_row_id, name, token_hash, token_prefix, expires_at)
        VALUES ('token-1', 'member', '${organizationId}', '${appRowId}', 'cli', 'hash', 'epat_', 9999999999999);
      INSERT INTO app_tool_catalogs (app_row_id, organization_id, status, fetched_at) VALUES ('${appRowId}', '${organizationId}', 'ok', 0);
      INSERT INTO app_tools (app_row_id, organization_id, name, description, risk, input_schema, catalog_hash)
        VALUES ('${appRowId}', '${organizationId}', 'list', 'List', 'read', '{}', 'h');
      INSERT INTO mcp_connections (id, user_id, organization_id, client_id, client_name, redirect_uri, redirect_host, app_scope, access, created_at)
        VALUES ('conn-1', 'member', '${organizationId}', 'c', 'Claude', 'https://claude.ai/cb', 'claude.ai', 'selected', 'read', 0);
      INSERT INTO mcp_connection_apps (connection_id, app_row_id) VALUES ('conn-1', '${appRowId}');
      INSERT INTO org_app_settings (organization_id, app_row_id, monthly_call_cap, updated_at) VALUES ('${organizationId}', '${appRowId}', 500, 0);
    `);
  }
  const appData = () => ({
    access: sqlite.all("SELECT id FROM user_app_access"),
    groupAccess: sqlite.all("SELECT group_id FROM group_app_access"),
    liveTokens: sqlite.all("SELECT id FROM user_access_tokens WHERE revoked_at IS NULL"),
    catalogs: sqlite.all("SELECT app_row_id FROM app_tool_catalogs"),
    tools: sqlite.all("SELECT name FROM app_tools"),
    connections: sqlite.all("SELECT connection_id FROM mcp_connection_apps"),
    caps: sqlite.all("SELECT monthly_call_cap FROM org_app_settings"),
  });
  const nothing = {
    access: [],
    groupAccess: [],
    liveTokens: [],
    catalogs: [],
    tools: [],
    connections: [],
    caps: [],
  };

  it("leaves a tombstone, with nothing of the app's access, tokens, tools, connections, cap or email configuration", async () => {
    const { plan, organization } = await registerApp("todo");
    withAppData(plan.app.id, organization.id);
    await writeAppEmail(db(), "todo", { senders: ["*@example.com"], inbound: ["hi@example.com"] }, DEPLOYER);

    const deleted = await deleteApp(db(), "todo", DEPLOYER);

    expect(deleted).toMatchObject({
      status: "deleted",
      workerName: "every-acme-todo",
      hostname: `todo.${BASE}`,
      resources: { d1: {}, kv: {} },
    });
    expect(app("todo")).toMatchObject({
      status: "deleted",
      is_default: 0,
      email_senders: null,
      email_inbound: null,
    });
    expect(appData()).toEqual(nothing);
    // The group itself stays, with its members: only its grant to the app goes.
    expect(sqlite.all("SELECT user_id FROM group_members")).toEqual([{ user_id: "member" }]);
    expect(sqlite.all("SELECT revoked_at FROM user_access_tokens")[0]!["revoked_at"]).not.toBeNull();
    // Gone from the commands that act on an app, and from the list.
    await expect(readApp(db(), "todo")).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    await expect(listApps(db())).resolves.toEqual([]);
    // A delete that stopped part-way runs again.
    await expect(deleteApp(db(), "todo", DEPLOYER)).resolves.toMatchObject({ status: "deleted" });
    await expect(deleteApp(db(), "nope", DEPLOYER)).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });

  it("revives its own tombstone under the same names, as a new app", async () => {
    addOrganization("org-1", "acme", 1);
    addUser("owner", { organization: "org-1", role: "owner" });
    const { plan } = await registerApp("todo", {
      manifest: { id: "todo", resources: { d1: ["DB"] } },
    });
    await deleteApp(db(), "todo", DEPLOYER);
    // Whatever was left on the tombstone, by hand or by an older gateway.
    withAppData(plan.app.id, "org-1");
    sqlite.sqlite
      .prepare("UPDATE apps SET email_senders = ?, email_inbound = ? WHERE id = ?")
      .run('["*@old.example"]', '["hi@old.example"]', plan.app.id);

    const revived = await registerApp("todo");

    expect(revived.plan).toMatchObject({
      kind: "revived",
      app: { id: plan.app.id, workerName: "every-acme-todo", hostname: `todo.${BASE}` },
      previousManifest: { id: "todo", resources: { d1: ["DB"] } },
    });
    expect(app("todo")).toMatchObject({
      status: "pending",
      worker_name: "every-acme-todo",
      email_senders: null,
      email_inbound: null,
    });
    expect({ ...appData(), access: [] }).toEqual(nothing);
    // Its initial access, granted again: the owner, and nobody from before.
    expect(grantees("todo")).toEqual(["owner"]);
  });
});

describe("writeAppEmail", () => {
  const LISTS = { senders: ["*@example.com", "ceo@example.com"], inbound: ["*@example.com"] };

  it("stores the lists as JSON and an empty one as null, and reads them back", async () => {
    const { plan } = await registerApp("inbox");

    const written = await writeAppEmail(db(), "inbox", LISTS, DEPLOYER);

    expect(written).toMatchObject({ id: plan.app.id, workerName: "every-acme-inbox", email: LISTS });
    expect(app("inbox")).toMatchObject({
      email_senders: '["*@example.com","ceo@example.com"]',
      email_inbound: '["*@example.com"]',
    });
    await expect(readApp(db(), "inbox")).resolves.toMatchObject({ email: LISTS });
    await expect(readAppEmail(db(), plan.app.id)).resolves.toEqual(LISTS);
    await expect(listApps(db())).resolves.toEqual([expect.objectContaining({ email: LISTS })]);
    // The manifest it was registered from declares no inbound mail, whatever the local file says.
    await expect(readApp(db(), "inbox")).resolves.toMatchObject({ declaresInbound: false });
    await markDeployed(db(), plan.app.id, {
      versionId: "v1",
      manifest: { id: "inbox", email: { inbound: true } },
      actor: "x",
    });
    await expect(readApp(db(), "inbox")).resolves.toMatchObject({ declaresInbound: true });
    // The address list a manifest carried before the move counts: that Worker exports email() too.
    sqlite.sqlite
      .prepare("UPDATE apps SET manifest = ? WHERE id = ?")
      .run(JSON.stringify({ id: "inbox", email: { inbound: ["hi@example.com"] } }), plan.app.id);
    await expect(readApp(db(), "inbox")).resolves.toMatchObject({ declaresInbound: true });

    await writeAppEmail(db(), "inbox", { senders: [], inbound: [] }, DEPLOYER);
    expect(app("inbox")).toMatchObject({ email_senders: null, email_inbound: null });
    await expect(readAppEmail(db(), plan.app.id)).resolves.toEqual({ senders: [], inbound: [] });
    // Each change is app.email_changed, the lists as stored now (names only), the operator its actor; the same lists again are no event.
    await writeAppEmail(db(), "inbox", { senders: [], inbound: [] }, DEPLOYER);
    expect(
      sqlite.all("SELECT type, actor, data, app_row_id FROM events WHERE type = 'app.email_changed' ORDER BY rowid").map((row) => ({
        ...row,
        actor: JSON.parse(String(row["actor"])),
        data: JSON.parse(String(row["data"])),
      })),
    ).toEqual([
      {
        type: "app.email_changed",
        actor: { kind: "operator", id: "dev@example.com", email: "dev@example.com" },
        data: { app: { id: "inbox", rowId: plan.app.id, name: "inbox" }, senders: LISTS.senders, inbound: LISTS.inbound },
        app_row_id: plan.app.id,
      },
      expect.objectContaining({ data: { app: { id: "inbox", rowId: plan.app.id, name: "inbox" }, senders: [], inbound: [] } }),
    ]);
    await expect(readAppEmail(db(), "no-such-row")).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });

  it("refuses an app that isn't registered or is deleted", async () => {
    await expect(writeAppEmail(db(), "inbox", LISTS, DEPLOYER)).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
    });
    await registerApp("inbox");
    await deleteApp(db(), "inbox", DEPLOYER);
    await expect(writeAppEmail(db(), "inbox", LISTS, DEPLOYER)).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
    });
    expect(app("inbox")).toMatchObject({ email_senders: null, email_inbound: null });
  });

  it("lets only a platform admin change a shared app's", async () => {
    addOrganization("org-1", "everyapp", 1);
    addUser("owner", { organization: "org-1", role: "owner" });
    addUser("member", { organization: "org-1", role: "member" });
    const owner: Deployer = { actor: "owner@example.com", email: "owner@example.com" };
    await registerApp("inbox", { scope: "shared", deployer: owner });
    const member: Deployer = { actor: "member@example.com", email: "member@example.com" };

    await expect(writeAppEmail(db(), "inbox", LISTS, member)).rejects.toMatchObject({
      code: "SHARED_APP_FORBIDDEN",
    });
    expect(app("inbox")).toMatchObject({ email_senders: null, email_inbound: null });

    await expect(writeAppEmail(db(), "inbox", LISTS, owner)).resolves.toMatchObject({ email: LISTS });
    // An API token has the account's authority.
    await expect(
      writeAppEmail(db(), "inbox", { senders: [], inbound: [] }, { actor: "api-token:acc", email: null }),
    ).resolves.toMatchObject({ email: { senders: [], inbound: [] } });
  });

  it("keeps the lists across markDeployed", async () => {
    const { plan } = await registerApp("inbox");
    await writeAppEmail(db(), "inbox", LISTS, DEPLOYER);

    await markDeployed(db(), plan.app.id, {
      versionId: "v1",
      manifest: { id: "inbox", email: { inbound: true } },
      actor: DEPLOYER.actor,
    });

    await expect(readAppEmail(db(), plan.app.id)).resolves.toEqual(LISTS);
    await expect(readApp(db(), "inbox")).resolves.toMatchObject({ status: "binding", email: LISTS });
  });
});

describe("installOrganization", () => {
  it("is the oldest with an owner, else the oldest of all, else none", async () => {
    await expect(installOrganization(db())).resolves.toBeNull();
    addOrganization("org-b", "b", 2);
    addOrganization("org-a", "a", 1);
    await expect(installOrganization(db())).resolves.toMatchObject({
      organization: { id: "org-a" },
      hasOwner: false,
    });
    addUser("owner", { organization: "org-b", role: "owner" });
    await expect(installOrganization(db())).resolves.toMatchObject({
      organization: { id: "org-b" },
      hasOwner: true,
    });
  });
});

describe("the live wait", () => {
  /** A gateway that activates the app on a request once `bound`. */
  function gateway({
    bound = () => true,
    answer = () => new Response("ok"),
  }: { bound?: () => boolean; answer?: (url: string) => Response | Promise<Response> } = {}) {
    const requests: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      requests.push(String(input));
      const response = await answer(String(input));
      if (response.status < 300 && bound()) {
        sqlite.sqlite.exec("UPDATE apps SET status = 'active' WHERE status = 'binding'");
      }
      return response;
    }) as typeof fetch;
    return { requests, fetch: fetchImpl };
  }

  async function uploaded() {
    const { plan } = await registerApp("todo");
    await markDeployed(db(), plan.app.id, { versionId: "v1", manifest: { id: "todo" }, actor: "x" });
    return plan.app.id;
  }

  const wait = (appRowId: string, seams: Partial<Parameters<typeof waitForLive>[0]>) =>
    waitForLive({
      db: db(),
      appRowId,
      appId: "todo",
      hostname: `todo.${BASE}`,
      out: out(),
      verb: LiveWaitVerb.Deploy,
      sleep: async () => undefined,
      ...seams,
    });

  it("requests the app until the gateway's activation shows in D1", async () => {
    const id = await uploaded();
    let bound = false;
    const live = gateway({
      bound: () => bound,
      // The gateway version with the binding rolls out meanwhile.
      answer: () => {
        const answer = bound
          ? new Response("ok")
          : Response.json({ code: "app_deploying" }, { status: 503 });
        bound = true;
        return answer;
      },
    });

    await expect(wait(id, { fetch: live.fetch })).resolves.toMatchObject({ outcome: "live" });

    expect(live.requests).toEqual([`https://todo.${BASE}/`, `https://todo.${BASE}/`]);
    expect(app("todo")).toMatchObject({ status: "active" });
  });

  it("sends the first request at once, with no pause for DNS", async () => {
    const id = await uploaded();
    const order: string[] = [];
    const live = gateway();

    await expect(
      wait(id, {
        fetch: (async (input: Parameters<typeof fetch>[0]) => {
          order.push("request");
          return live.fetch(input);
        }) as typeof fetch,
        sleep: async () => {
          order.push("sleep");
        },
      }),
    ).resolves.toMatchObject({ outcome: "live" });
    expect(order).toEqual(["request"]);
  });

  it("warns, once live, when this computer still remembers the hostname as missing", async () => {
    const id = await uploaded();
    const asked: string[] = [];

    await expect(
      wait(id, {
        fetch: gateway().fetch,
        localDns: {
          lookup: async (hostname) => {
            asked.push(hostname);
            throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
          },
          negativeCacheTtlSeconds: async () => 1800,
        },
      }),
    ).resolves.toMatchObject({ outcome: "live" });
    expect(asked).toEqual([`todo.${BASE}`]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "LOCAL_DNS_STALE",
        step: "app.live",
        message: expect.stringMatching(
          /^todo is live at https:\/\/todo\.apps\.example\.com, but this computer's DNS resolver.*within 30 minutes; a browser with its own DNS, such as Chrome, works now\./,
        ),
      }),
    );
  });

  it("asks this computer nothing for an app that was live already", async () => {
    const id = await uploaded();
    sqlite.sqlite.exec("UPDATE apps SET status = 'active'");
    const asked: string[] = [];

    await expect(
      wait(id, {
        fetch: gateway().fetch,
        localDns: {
          lookup: async (hostname) => {
            asked.push(hostname);
            throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
          },
          negativeCacheTtlSeconds: async () => null,
        },
      }),
    ).resolves.toMatchObject({ outcome: "live" });
    expect(asked).toEqual([]);
    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);
  });

  it("never takes an answer for activation: only D1 says live", async () => {
    const id = await uploaded();
    const answering = gateway({ bound: () => false });
    let now = 0;

    await expect(
      wait(id, {
        fetch: answering.fetch,
        maxWaitMs: 10_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toMatchObject({ code: "APP_NOT_LIVE", retryable: true });
    expect(app("todo")).toMatchObject({ status: "binding" });
  });

  it("stops at Cloudflare Access in front, once TLS answers, and says it goes live on its first visit", async () => {
    const id = await uploaded();
    const behindAccess = gateway({
      answer: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://acme.cloudflareaccess.com/cdn-cgi/access/login/x" },
        }),
    });

    await expect(wait(id, { fetch: behindAccess.fetch })).resolves.toMatchObject({ outcome: "first_visit" });

    expect(behindAccess.requests).toHaveLength(1);
    expect(app("todo")).toMatchObject({ status: "binding" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "ACCESS_IN_FRONT",
        message: expect.stringContaining("goes live on its first visit"),
      }),
    );
  });

  it("gives up on a certificate that doesn't come, with a warning, not an error", async () => {
    const id = await uploaded();
    let now = 0;
    const noTls = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("handshake failure") });
    }) as typeof fetch;

    await expect(
      wait(id, {
        fetch: noTls,
        maxWaitMs: 60_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).resolves.toMatchObject({ outcome: "first_visit" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "CERT_PENDING" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "progress", step: "app.live" }),
    );
  });

  it("needs no request for an app that is live already", async () => {
    const id = await uploaded();
    sqlite.sqlite.exec("UPDATE apps SET status = 'active'");
    const live = gateway();

    await expect(wait(id, { fetch: live.fetch })).resolves.toMatchObject({ outcome: "live" });
    expect(live.requests).toEqual([]);
  });
});

describe("a Gateway from before apps.secret_names (migration 0004)", () => {
  // The live Gateway's D1 until `update` runs its migrations.
  beforeEach(() => {
    sqlite.sqlite.exec("ALTER TABLE apps DROP COLUMN secret_names");
  });

  it("reads every app's names as never recorded and leaves them unwritten, instead of failing on the missing column", async () => {
    const { plan } = await registerApp("todo", { manifest: { id: "todo", secrets: ["STRIPE_KEY"] } });
    expect(await hasSecretNamesColumn(db())).toBe(false);
    expect(await readAppById(db(), plan.app.id)).toMatchObject({ appSlug: "todo", secretNames: null });

    // Recording and deploying skip the column; the rest of the row is written.
    await writeAppSecretNames(db(), plan.app.id, ["STRIPE_KEY"]);
    const status = await markDeployed(db(), plan.app.id, {
      versionId: "v1",
      manifest: { id: "todo", secrets: ["STRIPE_KEY"] },
      actor: "dev@example.com",
      secretNames: ["STRIPE_KEY"],
    });
    expect(typeof status).toBe("string");
    expect(sqlite.all("SELECT version_id, deployed_by_actor FROM apps WHERE app_slug = ?", "todo")).toEqual([
      { version_id: "v1", deployed_by_actor: "dev@example.com" },
    ]);
    expect(await listApps(db())).toEqual([expect.objectContaining({ appSlug: "todo", secretNames: null })]);

    // Deleting clears what the row has, and not the column it lacks.
    const statements = withoutAppData(plan.app, 0, { secretNames: false });
    expect(statements[0]!.sql).not.toContain("secret_names");
    await db().run(statements);
  });
});

describe("the events a registry change queues (the outbox)", () => {
  /** A webhook subscription of the install organization's, taking `events`. */
  function subscribe(events: string[]): void {
    const organizationId = String(sqlite.all("SELECT id FROM organizations ORDER BY created_at LIMIT 1")[0]!["id"]);
    sqlite.sqlite
      .prepare(
        "INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, events, created_at, updated_at) VALUES ('sub_1', ?, 'Slack', 'webhook', 'https://hooks.example.org/x', 'whsec_x', ?, 0, 0)",
      )
      .run(organizationId, JSON.stringify(events));
  }
  const queued = () =>
    sqlite.all("SELECT type, version, actor, data, app_row_id FROM events ORDER BY rowid").map((row) => ({
      type: row["type"],
      actor: JSON.parse(String(row["actor"])),
      data: JSON.parse(String(row["data"])),
      appRowId: row["app_row_id"],
    }));
  const deliveries = () => sqlite.all("SELECT subscription_id, status FROM event_deliveries");

  it("says nothing on registration: an app is installed once its first upload is recorded, from this machine or a release", async () => {
    const { plan } = await registerApp("todo", { name: "Todo" });
    subscribe(["app.*"]);
    expect(queued()).toEqual([]);

    await markDeployed(db(), plan.app.id, { versionId: "v1", manifest: { id: "todo" }, actor: DEPLOYER.actor, email: DEPLOYER.email });
    expect(queued()).toEqual([
      {
        type: "app.installed",
        actor: { kind: "operator", id: "dev@example.com", email: "dev@example.com" },
        data: { app: { id: "todo", rowId: plan.app.id, name: "Todo" }, version: "v1", hostname: `todo.${BASE}`, scope: "org", source: "cli" },
        appRowId: plan.app.id,
      },
    ]);
    expect(deliveries()).toEqual([{ subscription_id: "sub_1", status: "pending" }]);

    const second = await registerApp("crm");
    await markDeployed(db(), second.plan.app.id, { versionId: "c1", manifest: { id: "crm" }, actor: "api-token:acct", source: "release" });
    expect(queued()[1]).toMatchObject({ type: "app.installed", actor: { kind: "operator", id: "api-token:acct" }, data: { source: "release" } });
  });

  it("queues app.updated for a new version of an uploaded app, with the one before, and nothing for the same version", async () => {
    const { plan } = await registerApp("todo");
    await markDeployed(db(), plan.app.id, { versionId: "v1", manifest: { id: "todo" }, actor: "x" });
    sqlite.sqlite.exec("UPDATE apps SET status = 'active'");
    await markDeployed(db(), plan.app.id, { versionId: "v2", manifest: { id: "todo" }, actor: "x" });
    await markDeployed(db(), plan.app.id, { versionId: "v2", manifest: { id: "todo" }, actor: "x" });

    expect(queued().map((event) => [event.type, event.data])).toEqual([
      ["app.installed", expect.objectContaining({ version: "v1" })],
      ["app.updated", { app: { id: "todo", rowId: plan.app.id, name: "todo" }, version: "v2", previousVersion: "v1" }],
    ]);
  });

  it("queues app.removed with the tombstone, saying whether the delete purges, and nothing for one deleted already", async () => {
    const { plan } = await registerApp("todo");
    await deleteApp(db(), "todo", DEPLOYER, 1_000, { purge: true });
    await deleteApp(db(), "todo", DEPLOYER, 2_000);
    expect(queued()).toEqual([
      expect.objectContaining({ type: "app.removed", data: { app: { id: "todo", rowId: plan.app.id, name: "todo" }, purged: true } }),
    ]);
  });

  it("queues nothing for an upload whose record didn't land, nor on a Gateway from before the event tables", async () => {
    const { plan } = await registerApp("todo");
    // An admin switches the app off between each read and its write: the
    // record is refused (APP_CHANGING), and so is its event.
    const run = db().run;
    const database = {
      run: async (statements: Parameters<typeof run>[0]) => {
        if (statements.some((statement) => statement.sql.startsWith("UPDATE apps SET manifest"))) {
          sqlite.sqlite.exec("UPDATE apps SET status = CASE status WHEN 'disabled' THEN 'pending' ELSE 'disabled' END");
        }
        return run(statements);
      },
    };
    await expect(
      markDeployed(database, plan.app.id, { versionId: "v1", manifest: { id: "todo" }, actor: "x" }),
    ).rejects.toMatchObject({ code: "APP_CHANGING" });
    expect(queued()).toEqual([]);

    sqlite.sqlite.exec("DROP TABLE event_deliveries; DROP TABLE events; DROP TABLE event_subscriptions");
    sqlite.sqlite.exec("UPDATE apps SET status = 'pending'");
    await expect(markDeployed(db(), plan.app.id, { versionId: "v1", manifest: { id: "todo" }, actor: "x" })).resolves.toBe("binding");
    await expect(deleteApp(db(), "todo", DEPLOYER)).resolves.toMatchObject({ status: "deleted" });
  });
});
