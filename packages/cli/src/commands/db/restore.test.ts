import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { GATEWAY_RESTORE_TARGET, readRestorePoint, recordRestorePoint } from "@/lib/gateway/restorePoints";
import { GATEWAY_SCHEMA } from "@/lib/gateway/schema";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { restoreDatabase } from "./restore";

let account: FakeCloudflare;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;
let databaseId: string;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const db = () => cfD1Database(account.cf, databaseId);

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  release = await openRelease(await buildGatewayRelease());
  const resources = await ensureGatewayResources(account.cf);
  databaseId = resources.d1Id;
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
    db: db(),
    interactive: false,
    cliVersion: "0.3.0",
    sleep: async () => undefined,
    leaseWaitMs: 0,
  });
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("db restore --gateway", () => {
  it("restores a Gateway whose newest migration failed, though its database is behind this everyapp", async () => {
    // As `update` leaves it when GATEWAY_SCHEMA's migration fails: the restore
    // point saved, no d1_migrations row for the failed one.
    await recordRestorePoint(db(), {
      target: GATEWAY_RESTORE_TARGET,
      databaseId,
      bookmark: "bookmark-before",
      migrations: [`${GATEWAY_SCHEMA}.sql`],
      createdAt: Date.now(),
      createdBy: "dev@example.com",
    });
    await db().run([{ sql: "DELETE FROM d1_migrations WHERE name = ?", params: [`${GATEWAY_SCHEMA}.sql`] }]);

    await restoreDatabase({
      cwd: home,
      gateway: true,
      yes: true,
      json: true,
      interactive: false,
      out: out(),
      createCf: () => account.cf,
    });

    expect(account.restores).toEqual([{ databaseId, bookmark: "bookmark-before" }]);
    expect(await readRestorePoint(db(), GATEWAY_RESTORE_TARGET)).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: "done", data: { appId: null, bookmark: "bookmark-before" } });
  });
});
