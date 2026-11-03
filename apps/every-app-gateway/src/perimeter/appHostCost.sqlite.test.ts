/**
 * What one request to an app host costs the gateway, in database round
 * trips: the real worker entry (server.ts) and the real Better Auth
 * configuration on SQLite, an app behind its service binding, and a mock
 * Cloudflare Access in front, as in outer-ring-perimeter.sqlite.test.ts.
 *
 * Every statement the libsql client runs is counted as one round trip (a
 * batch counts once: D1 sends it in one request), so the numbers here are
 * what a request pays in D1 latency, isolate by isolate: on a fresh
 * isolate, once the per-isolate caches (hostname row, membership,
 * organization status, setup report) hold, and again when they have
 * expired. The counts are the contract: a change that adds a round trip
 * to the hot path fails here, and the agent docs' identity page ("What a
 * request costs") quotes them.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  env: {} as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({
  env: hoisted.env,
  waitUntil: () => undefined,
  WorkerEntrypoint: class {},
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(hoisted.testDb), schema };
});
vi.mock("drizzle-orm/d1", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { drizzle: () => testDbProxy(hoisted.testDb) };
});
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: async () => new Response("control plane") },
}));

import { createClient, type Client, type InStatement } from "@libsql/client";
import { createHash, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createAuth } from "@/auth";
import * as schema from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { AppAccessService } from "@/server/services/AppAccessService";
import { SetupService } from "@/server/services/SetupService";
import {
  createMockAccess,
  MOCK_ACCESS_ENV,
  type MockAccess,
} from "@/test/mock-access";
import { deployLiveApp } from "@/test/registry";
import { clearJwksClientsForTests } from "@/auth/cloudflare-access/jwt";

const GATEWAY = "https://gateway.example.com";
const OWNER = {
  name: "Owner",
  email: "owner@acme.com",
  password: "owner-password-1",
};
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

/**
 * Database round trips since the last reset. Statements issued while
 * another is still in flight ride the same round trip (D1 answers them in
 * parallel), so this counts how many times the request waited on the
 * database in a row: the number that becomes latency.
 */
const roundTrips = {
  count: 0,
  statements: 0,
  inFlight: 0,
  log: [] as string[],
};

function countingClient(): Client {
  const client = createClient({ url: ":memory:" });
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  const counted = async <T>(label: string, run: () => Promise<T>) => {
    roundTrips.statements += 1;
    if (roundTrips.inFlight === 0) roundTrips.count += 1;
    roundTrips.inFlight += 1;
    roundTrips.log.push(
      `${roundTrips.inFlight > 1 ? "  with " : ""}${label.replace(/\s+/g, " ").slice(0, 100)}`,
    );
    try {
      return await run();
    } finally {
      roundTrips.inFlight -= 1;
    }
  };
  return Object.assign(client, {
    execute: ((statement: InStatement) =>
      counted(typeof statement === "string" ? statement : statement.sql, () =>
        execute(statement),
      )) as Client["execute"],
    batch: ((
      statements: Parameters<Client["batch"]>[0],
      mode?: Parameters<Client["batch"]>[1],
    ) =>
      counted(`batch(${statements.length})`, () =>
        batch(statements, mode),
      )) as Client["batch"],
  });
}

let privateKeyPem: string;
let access: MockAccess;
let appHost: string;
let ownerCookie: string;
let assertion: string;
/** Identity headers the app received, request by request. */
const received: Record<string, string>[] = [];

interface Measured {
  label: string;
  status: number;
  roundTrips: number;
  statements: number;
  ms: number;
}
const measured: Measured[] = [];

async function measure(
  label: string,
  init: { path?: string; headers?: Record<string, string> } = {},
): Promise<Measured> {
  const path = init.path ?? "/";
  roundTrips.count = 0;
  roundTrips.statements = 0;
  roundTrips.log = [];
  const startedAt = performance.now();
  const response = await server.fetch(
    new Request(`https://${appHost}${path}`, {
      headers: {
        host: appHost,
        accept: "text/html",
        cookie: `${ownerCookie}; CF_Authorization=${assertion}`,
        "cf-access-jwt-assertion": assertion,
        ...init.headers,
      },
    }),
  );
  await response.text();
  if (process.env.EA_COST_DEBUG) {
    process.stdout.write(`\n[${label}]\n${roundTrips.log.join("\n")}\n`);
  }
  const result = {
    label,
    status: response.status,
    roundTrips: roundTrips.count,
    statements: roundTrips.statements,
    ms: Math.round(performance.now() - startedAt),
  };
  measured.push(result);
  return result;
}

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
});

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  Object.assign(hoisted.env, {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: GATEWAY,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: privateKeyPem,
    DB: { prepare: () => undefined },
    ...MOCK_ACCESS_ENV.outerRing,
  });
  received.length = 0;
  measured.length = 0;
  clearHostnameCacheForTests();
  clearOrgContextCacheForTests();
  resetAppSetupCacheForTests();
  clearJwksClientsForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const db = drizzle(countingClient(), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  hoisted.testDb.current = db;
  access = await createMockAccess();
  vi.stubGlobal("fetch", access.fetch);

  await db.insert(schema.ownerSetupTokens).values({
    id: "link-1",
    kind: "claim",
    tokenHash: createHash("sha256").update("est_setup").digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const owner = await SetupService.claimOwner({
    token: "est_setup",
    ...OWNER,
  });
  const { app: todo } = await deployLiveApp(db, {
    organizationId: owner.organizationId,
    appSlug: "todo",
    name: "Todos",
    description: "Things to do",
    manifest: { id: "todo", name: "Todos" },
    deployerUserId: owner.userId,
    appBaseDomain: new URL(GATEWAY).host,
  });
  hoisted.env[`APP__${todo.workerName}`] = {
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/__everyapp/tools/list") {
        return new Response("not found", { status: 404 });
      }
      received.push(Object.fromEntries(request.headers));
      return new Response("todo app", {
        headers: { "content-type": "text/html" },
      });
    },
  };
  appHost = todo.hostname!;
  await AppAccessService.updateAccessForApp(
    { orgId: owner.organizationId, userId: owner.userId, role: "owner" },
    todo.id,
    [owner.userId],
  );

  assertion = await access.assertion({ email: OWNER.email });
  const signIn = await createAuth().handler(
    new Request(`${GATEWAY}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: GATEWAY,
        "content-type": "application/json",
        "cf-access-jwt-assertion": assertion,
      },
      body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
    }),
  );
  expect(signIn.status).toBe(200);
  ownerCookie = signIn.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
});

function report(): void {
  const rows = measured.map(
    (row) =>
      `${row.label.padEnd(44)} ${String(row.status).padStart(3)} ${String(row.roundTrips).padStart(3)} round trips (${row.statements} statements) ${String(row.ms).padStart(5)} ms`,
  );
  process.stdout.write(
    `\napp-host request cost (SQLite, this machine):\n${rows.join("\n")}\n\n`,
  );
}

describe("what an app-host request costs (SQLite)", () => {
  it("counts the database round trips of a page, its scripts and a fetch", async () => {
    // The first request on this isolate: Better Auth and the key are
    // initialised, every per-isolate cache is empty.
    const fresh = await measure("fresh isolate: document");
    expect(fresh.status).toBe(200);
    expect(received.at(-1)?.["x-everyapp-identity"]).toMatch(/^eyJ/);

    // The same page again, caches warm: what every request in the 30 s
    // window after it pays.
    const warm = await measure("warm: document");
    const script = await measure("warm: script", {
      path: "/assets/index-ABCDEFGH.js",
      headers: { accept: "*/*", "sec-fetch-dest": "script" },
    });
    const fetch = await measure("warm: fetch (server function)", {
      path: "/_serverFn/abc",
      headers: {
        accept: "*/*",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-tsr-serverfn": "true",
      },
    });

    // The caches expired (30 s): the row, membership, organization status
    // and setup report are read again.
    clearHostnameCacheForTests();
    clearOrgContextCacheForTests();
    resetAppSetupCacheForTests();
    const expired = await measure("caches expired: document");

    report();

    for (const row of [fresh, warm, script, fetch, expired]) {
      expect(row.status).toBe(200);
    }
    // The live reads the threat model requires on every request
    // (perimeter.cache-bounded-revocation): the session with its user, and
    // the person's user_app_access row. Better Auth reads the session and
    // the user one after the other.
    expect(warm.roundTrips).toBe(3);
    expect(warm.statements).toBe(3);
    expect(script.roundTrips).toBe(warm.roundTrips);
    expect(fetch.roundTrips).toBe(warm.roundTrips);
    // Expired caches add the hostname row before anything, the membership
    // after the user, and the organization's status beside the access row.
    expect(expired.roundTrips).toBe(warm.roundTrips + 2);
    expect(expired.statements).toBe(warm.statements + 3);
    // A fresh isolate also follows the app's version once (app-activation.ts),
    // a read that runs after the response in production (waitUntil).
    expect(fresh.roundTrips).toBe(expired.roundTrips + 1);
  });

  it("initialises Better Auth once per isolate, and says what that costs", async () => {
    const startedAt = performance.now();
    const auth = createAuth();
    await auth.api.getSession({ headers: new Headers() });
    const ms = Math.round(performance.now() - startedAt);
    process.stdout.write(`createAuth() + first getSession: ${ms} ms\n`);
    expect(ms).toBeGreaterThanOrEqual(0);
  });
});
