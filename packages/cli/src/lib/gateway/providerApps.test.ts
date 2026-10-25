/**
 * Built-in provider apps in the Gateway's registry on SQLite through `cf
 * d1 query` as the CLI sends it: on (new, again, after off, revived), the
 * initial access, off (status `disabled`, everything kept), remove (a
 * tombstone like a delete's), the refusals, and the list.
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
import { turnProviderAppOn } from "./providerApps";
import { register, type Deployer } from "./registry";
import { listMcpApps, removeMcpApp, resolveMcpApp, setMcpAppStatus } from "./remoteMcpApps";

const DB_ID = "0123456789abcdef0123456789abcdef";
const BEN: Deployer = { actor: "ben@example.com", email: "ben@example.com" };
const NOW = Date.parse("2026-10-24T12:00:00Z");

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

const row = (appSlug: string) =>
  sqlite.all(
    "SELECT id, organization_id, hostname, worker_name, tier, scope, status, manifest, deployed_at, deployed_by_actor, is_default FROM apps WHERE app_slug = ?",
    appSlug,
  )[0];
const grantees = (appSlug: string) =>
  sqlite
    .all(
      "SELECT user_id FROM user_app_access WHERE app_row_id = (SELECT id FROM apps WHERE app_slug = ?) ORDER BY user_id",
      appSlug,
    )
    .map((r) => r["user_id"]);

function addUser(
  id: string,
  { organization, role = "member" }: { organization?: string; role?: string } = {},
): void {
  sqlite.sqlite
    .prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)",
    )
    .run(id, id, `${id}@example.com`);
  if (organization) {
    sqlite.sqlite
      .prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, 0)",
      )
      .run(`m-${id}`, organization, id, role);
  }
}

const on = (id = "dataforseo", deployer = BEN, now = NOW) =>
  turnProviderAppOn(db(), { id, deployer, organizationName: "Acme", now });

describe("turnProviderAppOn", () => {
  it("creates the install organization when there is none, and the row active with no Worker", async () => {
    const result = await on();
    expect(result.plan.kind).toBe("new");
    expect(result.hasOwner).toBe(false);
    expect(result.actorGranted).toBe(false);
    expect(result.organization.name).toBe("Acme");
    expect(row("dataforseo")).toMatchObject({
      organization_id: result.organization.id,
      hostname: null,
      worker_name: null,
      tier: "provider",
      scope: "org",
      status: "active",
      deployed_at: NOW,
      deployed_by_actor: "ben@example.com",
      is_default: 0,
    });
    expect(JSON.parse(String(row("dataforseo")!["manifest"]))).toMatchObject({
      id: "dataforseo",
      capabilities: { dataforseo: { access: "read" } },
    });
    expect(grantees("dataforseo")).toEqual([]);
  });

  it("grants the person turning it on, the owners and the admins, nobody else", async () => {
    const { organization } = await on();
    addUser("ben", { organization: organization.id, role: "member" });
    addUser("owner", { organization: organization.id, role: "owner" });
    addUser("admin", { organization: organization.id, role: "admin" });
    addUser("member", { organization: organization.id, role: "member" });
    await remove("dataforseo", NOW + 1);

    const result = await on("dataforseo", BEN, NOW + 2);
    expect(result.plan.kind).toBe("revived");
    expect(result.was).toBe("revived");
    expect(result.hasOwner).toBe(true);
    expect(result.actorGranted).toBe(true);
    expect(grantees("dataforseo")).toEqual(["admin", "ben", "owner"]);
    expect(row("dataforseo")).toMatchObject({ status: "active", deployed_at: NOW + 2 });
  });

  it("is safe to repeat: an app that is on keeps its access and gets the registry's name", async () => {
    const { organization, plan } = await on();
    addUser("ben", { organization: organization.id });
    sqlite.sqlite
      .prepare(
        "INSERT INTO user_app_access (id, user_id, app_row_id, organization_id) VALUES ('g1', 'ben', ?, ?)",
      )
      .run(plan.app.id, organization.id);
    sqlite.sqlite.prepare("UPDATE apps SET name = 'Renamed' WHERE id = ?").run(plan.app.id);

    const again = await on("dataforseo", BEN, NOW + 5);
    expect(again.plan.kind).toBe("existing");
    expect(again.was).toBe("existing");
    expect(again.actorGranted).toBe(true);
    expect(again.plan.app.id).toBe(plan.app.id);
    expect(grantees("dataforseo")).toEqual(["ben"]);
    expect(sqlite.all("SELECT name FROM apps WHERE id = ?", plan.app.id)[0]!["name"]).toBe("DataForSEO");
  });

  it("refuses an unknown provider, naming the ones there are", async () => {
    await expect(on("ahrefs")).rejects.toMatchObject({
      code: "PROVIDER_APP_UNKNOWN",
      message: '"ahrefs" is not an MCP app. The Gateway offers: dataforseo.',
    });
    expect(row("ahrefs")).toBeUndefined();
  });

  it("refuses the id of a deployed app", async () => {
    await register(db(), {
      appSlug: "dataforseo",
      name: "dataforseo",
      description: "an app",
      manifest: { id: "dataforseo" },
      appBaseDomain: "apps.example.com",
      deployer: BEN,
      organizationName: "Acme",
    });
    await expect(on()).rejects.toMatchObject({ code: "APP_TIER_MISMATCH" });
    expect(row("dataforseo")).toMatchObject({ tier: "service_binding" });
  });
});

/** `mcp off` on the built-in's row, as the command runs it. */
async function off(id = "dataforseo", now = NOW) {
  const ref = await resolveMcpApp(db(), id);
  return ref.app ? setMcpAppStatus(db(), ref.app, "disabled", now) : { changed: false };
}

/** `mcp remove` on the built-in's row, as the command runs it. */
async function remove(id = "dataforseo", now = NOW) {
  return removeMcpApp(db(), (await resolveMcpApp(db(), id)).app, now);
}

describe("off and on again", () => {
  it("stops serving with everything kept, and on serves it again with the same access", async () => {
    const { organization, plan } = await on();
    addUser("ben", { organization: organization.id });
    sqlite.sqlite
      .prepare(
        "INSERT INTO user_app_access (id, user_id, app_row_id, organization_id) VALUES ('g1', 'ben', ?, ?)",
      )
      .run(plan.app.id, organization.id);

    expect(await off("dataforseo", NOW + 1)).toEqual({ changed: true });
    expect(row("dataforseo")).toMatchObject({ status: "disabled", tier: "provider" });
    expect(grantees("dataforseo")).toEqual(["ben"]);
    expect(await off("dataforseo", NOW + 2)).toEqual({ changed: false });

    const back = await on("dataforseo", BEN, NOW + 3);
    expect(back.plan.kind).toBe("existing");
    expect(back.was).toBe("off");
    expect(back.plan.app.id).toBe(plan.app.id);
    expect(row("dataforseo")).toMatchObject({ status: "active" });
    expect(grantees("dataforseo")).toEqual(["ben"]);
  });
});

describe("remove", () => {
  it("leaves a tombstone with nothing of its access, and says when it was removed already", async () => {
    const { organization, plan } = await on();
    addUser("ben", { organization: organization.id });
    sqlite.sqlite
      .prepare(
        "INSERT INTO user_app_access (id, user_id, app_row_id, organization_id) VALUES ('g1', 'ben', ?, ?)",
      )
      .run(plan.app.id, organization.id);

    expect(await remove("dataforseo", NOW + 1)).toEqual({ removed: true });
    expect(row("dataforseo")).toMatchObject({ status: "deleted", tier: "provider" });
    expect(grantees("dataforseo")).toEqual([]);
    expect(await remove("dataforseo", NOW + 2)).toEqual({ removed: false });
  });

  it("never touches a deployed app's row, and is a no-op before any organization exists", async () => {
    expect(await remove()).toEqual({ removed: false });
    await register(db(), {
      appSlug: "dataforseo",
      name: "dataforseo",
      description: "an app",
      manifest: { id: "dataforseo" },
      appBaseDomain: "apps.example.com",
      deployer: BEN,
      organizationName: "Acme",
    });
    expect(await remove()).toEqual({ removed: false });
    expect(row("dataforseo")).toMatchObject({ status: "pending" });
  });
});

describe("listMcpApps", () => {
  it("lists every built-in MCP app with its row, if it has one", async () => {
    expect(await listMcpApps(db())).toEqual([
      expect.objectContaining({ id: "dataforseo", name: "DataForSEO", kind: "builtin", app: null, keyName: "DATAFORSEO_API_KEY" }),
    ]);
    await on();
    expect((await listMcpApps(db()))[0]!.app).toMatchObject({ status: "active" });
    await off();
    expect((await listMcpApps(db()))[0]!.app).toMatchObject({ status: "disabled" });
    await remove();
    expect((await listMcpApps(db()))[0]!.app).toBeNull();
  });
});
