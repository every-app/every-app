/**
 * The app registry the CLI writes in the gateway's D1, against the
 * gateway's real schema on SQLite, through `cf d1 query` as a deploy sends
 * it: registering before and after the gateway has an owner, the takeover
 * checks, the actor, tombstones and their revival, and the live wait.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { waitForLive } from "@/commands/deploy/steps/waitForLive";
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
  register,
  type Deployer,
  type RegisterInput,
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
    "SELECT organization_id, app_slug, hostname, worker_name, status, manifest, version_id, deployed_at, deployed_by_actor, is_default FROM apps WHERE app_slug = ?",
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
  /** An owner, a member with access and a token, its tools and an AI connection. */
  function withAppData(appRowId: string, organizationId: string): void {
    addUser("member", { organization: organizationId });
    sqlite.sqlite.exec(`
      INSERT INTO user_app_access (id, user_id, app_row_id, organization_id) VALUES ('access-member', 'member', '${appRowId}', '${organizationId}');
      INSERT INTO user_access_tokens (id, user_id, organization_id, app_row_id, name, token_hash, token_prefix, expires_at)
        VALUES ('token-1', 'member', '${organizationId}', '${appRowId}', 'cli', 'hash', 'epat_', 9999999999999);
      INSERT INTO app_tool_catalogs (app_row_id, organization_id, status, fetched_at) VALUES ('${appRowId}', '${organizationId}', 'ok', 0);
      INSERT INTO app_tools (app_row_id, organization_id, name, description, risk, input_schema, catalog_hash)
        VALUES ('${appRowId}', '${organizationId}', 'list', 'List', 'read', '{}', 'h');
      INSERT INTO mcp_connections (id, user_id, organization_id, client_id, client_name, redirect_uri, redirect_host, app_scope, access, created_at)
        VALUES ('conn-1', 'member', '${organizationId}', 'c', 'Claude', 'https://claude.ai/cb', 'claude.ai', 'selected', 'read', 0);
      INSERT INTO mcp_connection_apps (connection_id, app_row_id) VALUES ('conn-1', '${appRowId}');
    `);
  }
  const appData = () => ({
    access: sqlite.all("SELECT id FROM user_app_access"),
    liveTokens: sqlite.all("SELECT id FROM user_access_tokens WHERE revoked_at IS NULL"),
    catalogs: sqlite.all("SELECT app_row_id FROM app_tool_catalogs"),
    tools: sqlite.all("SELECT name FROM app_tools"),
    connections: sqlite.all("SELECT connection_id FROM mcp_connection_apps"),
  });
  const nothing = { access: [], liveTokens: [], catalogs: [], tools: [], connections: [] };

  it("leaves a tombstone, with nothing of the app's access, tokens, tools or connections", async () => {
    const { plan, organization } = await registerApp("todo");
    withAppData(plan.app.id, organization.id);

    const deleted = await deleteApp(db(), "todo", DEPLOYER);

    expect(deleted).toMatchObject({
      status: "deleted",
      workerName: "every-acme-todo",
      hostname: `todo.${BASE}`,
      resources: { d1: {}, kv: {} },
    });
    expect(app("todo")).toMatchObject({ status: "deleted", is_default: 0 });
    expect(appData()).toEqual(nothing);
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

    const revived = await registerApp("todo");

    expect(revived.plan).toMatchObject({
      kind: "revived",
      app: { id: plan.app.id, workerName: "every-acme-todo", hostname: `todo.${BASE}` },
      previousManifest: { id: "todo", resources: { d1: ["DB"] } },
    });
    expect(app("todo")).toMatchObject({ status: "pending", worker_name: "every-acme-todo" });
    expect({ ...appData(), access: [] }).toEqual(nothing);
    // Its initial access, granted again: the owner, and nobody from before.
    expect(grantees("todo")).toEqual(["owner"]);
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

    await expect(wait(id, { fetch: live.fetch })).resolves.toBe("live");

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
    ).resolves.toBe("live");
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
    ).resolves.toBe("live");
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
    ).resolves.toBe("live");
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

    await expect(wait(id, { fetch: behindAccess.fetch })).resolves.toBe("first_visit");

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
    ).resolves.toBe("first_visit");
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

    await expect(wait(id, { fetch: live.fetch })).resolves.toBe("live");
    expect(live.requests).toEqual([]);
  });
});
