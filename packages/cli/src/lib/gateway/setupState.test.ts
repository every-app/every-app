/**
 * An app's setup state on its row and the events of its transitions
 * (lib/gateway/setupState.ts), against the Gateway's schema on SQLite: the
 * first evaluation, a change each way, a setup that isn't sure, the
 * Gateway changing the state between the read and the write, and the
 * refresh after a change of settings, which only looks at the apps the
 * change can move and never fails the command.
 */
import { appSettings, type SettingsManifestLike } from "@every-app/sdk/internal";
import { beforeEach, describe, expect, it } from "vitest";
import { appSetupFrom } from "@/lib/app/settings";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createNdjsonSink } from "@/lib/output/events";
import { createSqliteD1, GATEWAY_MIGRATIONS_DIR, sqliteD1Script, type SqliteD1 } from "@/test/sqliteD1";
import { markDeployed, register, type Deployer } from "./registry";
import { recordSetupState, refreshSetupStates, setupStateOf, unmetNames } from "./setupState";

const DB_ID = "0123456789abcdef0123456789abcdef";
const BEN: Deployer = { actor: "ben@example.com", email: "ben@example.com" };
const CRM = {
  id: "crm",
  providers: [{ id: "openai" as const, anyOf: "AI model" }, { id: "openrouter" as const, anyOf: "AI model" }],
  secrets: [{ name: "TOKEN_ENCRYPTION_KEY" }, { name: "GITHUB_TOKEN", optional: true }],
};

let sqlite: SqliteD1;
let cf: FakeCf;
/** The Gateway Worker's setting names, as `cf workers secrets list` answers them. */
let gatewayNames: string[];
let lines: Array<Record<string, any>>;

beforeEach(async () => {
  sqlite = createSqliteD1();
  gatewayNames = [];
  lines = [];
  cf = new FakeCf()
    .on(["d1"], sqliteD1Script({ [DB_ID]: sqlite }))
    .on(["workers", "secrets", "list"], async () => ({
      stdout: JSON.stringify(gatewayNames.map((name) => ({ name, type: "secret_text" }))),
    }));
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["d1", "migrations", "apply", DB_ID, "--dir", GATEWAY_MIGRATIONS_DIR],
  });
});

const db = () => cfD1Database(cf, DB_ID);
const out = () => createNdjsonSink((line) => lines.push(JSON.parse(line)));
const setupOf = (manifest: SettingsManifestLike, gateway: string[] | null, own: string[] | null) =>
  appSetupFrom({ manifest, appId: "crm", gatewayNames: gateway, secretNames: own }).setup;
const state = () => sqlite.all("SELECT setup_state FROM apps WHERE app_slug = 'crm'")[0]?.["setup_state"];
const queued = () =>
  sqlite.all("SELECT type, data FROM events ORDER BY rowid").map((row) => ({
    type: row["type"],
    data: JSON.parse(String(row["data"])),
  }));

/** The CRM registered and uploaded, with its own secrets recorded as `own`. */
async function deployed(own: string[] | null = []): Promise<string> {
  const { plan } = await register(db(), {
    appSlug: "crm",
    name: "CRM",
    description: "crm",
    manifest: CRM,
    appBaseDomain: "example.com",
    deployer: BEN,
    organizationName: "Acme",
  });
  await markDeployed(db(), plan.app.id, { versionId: "v1", manifest: CRM, actor: BEN.actor, ...(own ? { secretNames: own } : {}) });
  sqlite.sqlite.exec("DELETE FROM events");
  return plan.app.id;
}

describe("setupStateOf and unmetNames", () => {
  it("reads needs_setup from what is unset, ready only when every setting the app needs is known", () => {
    expect(setupStateOf(setupOf(CRM, [], []))).toBe("needs_setup");
    expect(setupStateOf(setupOf(CRM, ["OPENAI_API_KEY"], ["TOKEN_ENCRYPTION_KEY"]))).toBe("ready");
    // Its own names never recorded: ready only because they read unknown.
    expect(setupStateOf(setupOf(CRM, ["OPENAI_API_KEY"], null))).toBeNull();
    expect(unmetNames(setupOf(CRM, [], []))).toEqual(["OPENAI_API_KEY", "OPENROUTER_API_KEY", "TOKEN_ENCRYPTION_KEY"]);
    expect(appSettings(CRM).length).toBeGreaterThan(0);
  });
});

describe("recordSetupState", () => {
  it("emits needs_setup on a first evaluation that finds the app short, then ready on the change, and nothing on a repeat", async () => {
    const rowId = await deployed();
    await expect(recordSetupState(db(), { appRowId: rowId, setup: setupOf(CRM, [], []), deployer: BEN })).resolves.toEqual({
      state: "needs_setup",
      previous: null,
      event: "app.needs_setup",
    });
    await recordSetupState(db(), { appRowId: rowId, setup: setupOf(CRM, ["OPENROUTER_API_KEY"], []), deployer: BEN });
    await recordSetupState(db(), { appRowId: rowId, setup: setupOf(CRM, ["OPENROUTER_API_KEY"], ["TOKEN_ENCRYPTION_KEY"]), deployer: BEN });
    await recordSetupState(db(), { appRowId: rowId, setup: setupOf(CRM, ["OPENROUTER_API_KEY"], ["TOKEN_ENCRYPTION_KEY"]), deployer: BEN });

    const app = { id: "crm", rowId, name: "CRM" };
    expect(state()).toBe("ready");
    expect(queued()).toEqual([
      { type: "app.needs_setup", data: { app, unmet: ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "TOKEN_ENCRYPTION_KEY"] } },
      { type: "app.ready", data: { app } },
    ]);
    const [event] = sqlite.all("SELECT actor, app_row_id FROM events LIMIT 1");
    expect(event).toEqual({ actor: JSON.stringify({ kind: "operator", id: "ben@example.com", email: "ben@example.com" }), app_row_id: rowId });
  });

  it("writes ready silently on a first evaluation, and leaves the row alone when the setup isn't sure", async () => {
    const rowId = await deployed();
    await expect(recordSetupState(db(), { appRowId: rowId, setup: setupOf(CRM, ["OPENAI_API_KEY"], null), deployer: BEN })).resolves.toBeNull();
    expect(state()).toBeNull();
    await recordSetupState(db(), { appRowId: rowId, setup: setupOf(CRM, ["OPENAI_API_KEY"], ["TOKEN_ENCRYPTION_KEY"]), deployer: BEN });
    expect(state()).toBe("ready");
    expect(queued()).toEqual([]);
  });

  it("announces a change only once when the Gateway records it between the read and the write", async () => {
    const rowId = await deployed();
    const database: D1Database = {
      run: async (statements) => {
        // The Gateway evaluates the app first and writes the same state.
        if (statements.some((statement) => statement.sql.startsWith("UPDATE apps SET setup_state"))) {
          sqlite.sqlite.exec("UPDATE apps SET setup_state = 'needs_setup'");
        }
        return db().run(statements);
      },
    };
    await recordSetupState(database, { appRowId: rowId, setup: setupOf(CRM, [], []), deployer: BEN });
    expect(state()).toBe("needs_setup");
    expect(queued()).toEqual([]);
  });

  it("records nothing for an app deleted since, or on a Gateway from before the column", async () => {
    const rowId = await deployed();
    sqlite.sqlite.exec("UPDATE apps SET status = 'deleted'");
    await expect(recordSetupState(db(), { appRowId: rowId, setup: setupOf(CRM, [], []), deployer: BEN })).resolves.toBeNull();
    sqlite.sqlite.exec("UPDATE apps SET status = 'active'; DROP TABLE event_deliveries; DROP TABLE events; DROP TABLE event_subscriptions");
    await expect(recordSetupState(db(), { appRowId: rowId, setup: setupOf(CRM, [], []), deployer: BEN })).resolves.toBeNull();
    expect(state()).toBeNull();
  });
});

describe("refreshSetupStates", () => {
  it("evaluates the apps that read a changed Gateway setting, from their recorded names, and no others", async () => {
    const rowId = await deployed(["TOKEN_ENCRYPTION_KEY"]);
    gatewayNames = ["OPENAI_API_KEY"];
    const listed = () => cf.calls.filter((call) => call.args.join(" ").startsWith("workers secrets list")).length;

    await refreshSetupStates({ cf, db: db(), deployer: BEN }, { gateway: ["EMAIL_FROM"], appRowId: null }, out());
    expect(listed()).toBe(0);
    expect(state()).toBeNull();

    await refreshSetupStates({ cf, db: db(), deployer: BEN }, { gateway: ["OPENAI_API_KEY"], appRowId: null }, out());
    expect(listed()).toBe(1);
    expect(state()).toBe("ready");

    gatewayNames = [];
    await refreshSetupStates({ cf, db: db(), deployer: BEN }, { gateway: [], appRowId: rowId, except: rowId }, out());
    expect(state()).toBe("ready");
    await refreshSetupStates({ cf, db: db(), deployer: BEN }, { gateway: [], appRowId: rowId }, out());
    expect(state()).toBe("needs_setup");
    expect(queued().map((event) => event.type)).toEqual(["app.needs_setup"]);
  });

  it("never fails the command: a failure is a progress line", async () => {
    await deployed(["TOKEN_ENCRYPTION_KEY"]);
    cf.override(["workers", "secrets", "list"], async () => ({ exitCode: 1, stderr: "┌ Error\n│ boom\n└\n" }));
    await refreshSetupStates({ cf, db: db(), deployer: BEN }, { gateway: ["OPENAI_API_KEY"], appRowId: null }, out());
    expect(lines).toEqual([
      expect.objectContaining({ type: "progress", step: "app.setup_state", message: expect.stringContaining("Couldn't record whether the apps are set up") }),
    ]);
  });
});
