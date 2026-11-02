/**
 * The deploy's half of the `app` event sink: `markDeployed` keeps the
 * app's own subscription in step with `events` in its manifest, in its own
 * organization only, against the Gateway's schema on SQLite. Made on the
 * first deploy that subscribes, its patterns replaced on the next (a pause
 * kept), removed when the manifest stops subscribing or the app is
 * deleted; a pattern outside the allowlist is refused, writing nothing.
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
import { queueEventFromCli, operatorActor } from "./events";
import { deleteApp, markDeployed, register, type Deployer } from "./registry";

const DB_ID = "0123456789abcdef0123456789abcdef";
const DEPLOYER: Deployer = { actor: "dev@example.com", email: "dev@example.com" };
const WHY = "Stops a leaver's Agents at once.";

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

async function deployed(manifest: Record<string, unknown>, versionId = "v1") {
  const { plan } = await register(db(), {
    appSlug: "birds",
    name: "Birds",
    description: "Agents",
    manifest,
    appBaseDomain: "apps.example.com",
    deployer: DEPLOYER,
    organizationName: "Acme",
  });
  await markDeployed(db(), plan.app.id, {
    versionId,
    manifest,
    actor: DEPLOYER.actor,
  });
  return plan.app;
}

const subscriptions = () =>
  sqlite.all(
    "SELECT organization_id, name, sink, url, secret, app_row_id, events, enabled, description, created_by FROM event_subscriptions",
  );

describe("the app's event subscription at deploy", () => {
  it("is made for the app's own organization, with no URL or secret, and follows the manifest", async () => {
    const app = await deployed({
      id: "birds",
      events: { subscribe: ["member.removed", "app.tools_changed"], why: WHY },
    });
    expect(subscriptions()).toEqual([
      {
        organization_id: app.organizationId,
        name: "Birds",
        sink: "app",
        url: null,
        secret: null,
        app_row_id: app.id,
        events: JSON.stringify(["member.removed", "app.tools_changed"]),
        enabled: 1,
        description: WHY,
        created_by: "operator:dev@example.com",
      },
    ]);

    // Paused by an admin: the next deploy replaces the patterns, keeps the pause.
    sqlite.sqlite.exec("UPDATE event_subscriptions SET enabled = 0");
    await deployed({ id: "birds", events: { subscribe: ["member.*"], why: WHY } }, "v2");
    expect(subscriptions()).toEqual([
      expect.objectContaining({ events: JSON.stringify(["member.*"]), enabled: 0 }),
    ]);

    // Dropped from the manifest: gone.
    await deployed({ id: "birds" }, "v3");
    expect(subscriptions()).toEqual([]);
  });

  it("refuses a family outside the allowlist, writing nothing", async () => {
    for (const pattern of ["*", "token.*", "cap.reached", "member.password_reset", "provider.*"]) {
      await expect(
        deployed({ id: "birds", events: { subscribe: [pattern], why: WHY } }),
        pattern,
      ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    }
    expect(subscriptions()).toEqual([]);
  });

  it("goes with the app when it is deleted", async () => {
    await deployed({ id: "birds", events: { subscribe: ["member.*"], why: WHY } });
    await deleteApp(db(), "birds", DEPLOYER);
    expect(subscriptions()).toEqual([]);
  });

  it("gets nothing from the CLI's outbox outside the allowlist", async () => {
    const app = await deployed({ id: "birds", events: { subscribe: ["app.*"], why: WHY } });
    // Even a row widened by hand.
    sqlite.sqlite.exec(`UPDATE event_subscriptions SET events = '["*"]'`);
    const actor = operatorActor(DEPLOYER);
    const queued = await queueEventFromCli(db(), {
      organizationId: app.organizationId,
      type: "cap.changed",
      actor,
      data: {},
      now: 1,
    });
    expect(queued).toHaveLength(1); // the event row, no delivery
    const allowed = await queueEventFromCli(db(), {
      organizationId: app.organizationId,
      type: "app.removed",
      actor,
      data: { app: { id: "birds", rowId: app.id, name: "Birds" }, purged: false },
      now: 2,
    });
    expect(allowed).toHaveLength(2);
  });
});
