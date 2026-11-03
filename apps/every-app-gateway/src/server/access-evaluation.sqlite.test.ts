/**
 * Cloudflare Access asking the Gateway who is a member (External
 * Evaluation, server/access-evaluation.ts), against a mock Access and a
 * migrated SQLite database: members and invitees get `success: true`,
 * everyone else `false`; the answer is signed with the key the keys URL
 * publishes, carries Access's nonce and expires within a minute; a token
 * Access didn't sign gets no answer; and nothing answers while the outer
 * ring isn't configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const workerEnv = vi.hoisted(
  () =>
    ({
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      GATEWAY_URL: "https://gateway.example.com",
      BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
      DB: {},
    }) as Record<string, unknown>,
);

vi.mock("cloudflare:workers", () => ({
  env: workerEnv,
  waitUntil: () => undefined,
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(testDb), schema };
});

import { createLocalJWKSet, jwtVerify, SignJWT, generateKeyPair } from "jose";
import { accessEvaluationKey, invitations } from "@/db/schema";
import { clearJwksClientsForTests } from "@/auth/cloudflare-access/jwt";
import {
  createMockAccess,
  MOCK_ACCESS_ENV,
  type MockAccess,
} from "@/test/mock-access";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import {
  resetAccessEvaluationKeyForTests,
  serveAccessEvaluation,
} from "./access-evaluation";

const ORIGIN = "https://gateway.example.com";
const BASE_ENV = { ...workerEnv };

let db: TestDb;
let access: MockAccess;
let organizationId: string;
let ownerId: string;

function useEnv(settings: Record<string, string>) {
  for (const key of Object.keys(workerEnv)) delete workerEnv[key];
  Object.assign(workerEnv, BASE_ENV, settings);
}

/** Access's call: POST the token to the evaluate URL. */
async function evaluate(token: string): Promise<Response | null> {
  return serveAccessEvaluation(
    new Request(`${ORIGIN}/access-evaluation/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
}

async function keys() {
  const response = await serveAccessEvaluation(
    new Request(`${ORIGIN}/access-evaluation/keys`),
  );
  expect(response?.status).toBe(200);
  return (await response!.json()) as { keys: Array<Record<string, unknown>> };
}

/** The answer's claims, verified as Access verifies them: against the keys URL. */
async function answerOf(response: Response | null) {
  expect(response?.status).toBe(200);
  const { token } = (await response!.json()) as { token: string };
  const { payload, protectedHeader } = await jwtVerify(
    token,
    createLocalJWKSet((await keys()) as never),
    { algorithms: ["RS256"] },
  );
  return { payload, protectedHeader };
}

beforeEach(async () => {
  db = await createTestDb();
  testDb.current = db;
  clearJwksClientsForTests();
  resetAccessEvaluationKeyForTests();
  access = await createMockAccess();
  vi.stubGlobal("fetch", access.fetch);
  useEnv({ ...MOCK_ACCESS_ENV.outerRing });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  organizationId = await seedOrganization(db, "acme");
  ownerId = await seedMember(db, {
    organizationId,
    role: "owner",
    email: "owner@acme.com",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useEnv({});
});

describe("Access's External Evaluation rule", () => {
  it("says yes for a member, echoing Access's nonce, signed with the published key, for a minute", async () => {
    await seedMember(db, { organizationId, email: "Alice@Acme.com" });
    const before = Math.floor(Date.now() / 1000);

    const { payload, protectedHeader } = await answerOf(
      await evaluate(
        await access.evaluationRequest({ email: "alice@acme.com" }, "n-1"),
      ),
    );

    expect(payload).toMatchObject({ success: true, nonce: "n-1" });
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    const published = (await keys()).keys;
    expect(published).toEqual([
      expect.objectContaining({
        kty: "RSA",
        alg: "RS256",
        use: "sig",
        kid: protectedHeader.kid,
      }),
    ]);
    // Only the public half is published.
    expect(published[0]).not.toHaveProperty("d");
  });

  it("says yes for someone with a pending invitation, so an invite needs no change in Access", async () => {
    await db.insert(invitations).values({
      id: "inv-bob",
      organizationId,
      email: "bob@partner.example",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: ownerId,
    });
    const { payload } = await answerOf(
      await evaluate(
        await access.evaluationRequest({ email: "bob@partner.example" }),
      ),
    );
    expect(payload).toMatchObject({ success: true });
  });

  it("says no for a stranger, a deactivated member, and an expired or accepted invitation", async () => {
    await seedMember(db, {
      organizationId,
      email: "gone@acme.com",
      banned: true,
    });
    await db.insert(invitations).values([
      {
        id: "inv-old",
        organizationId,
        email: "old@partner.example",
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() - 1),
        inviterId: ownerId,
      },
      {
        id: "inv-done",
        organizationId,
        email: "done@partner.example",
        role: "member",
        status: "canceled",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: ownerId,
      },
    ]);
    for (const email of [
      "mallory@evil.example",
      "gone@acme.com",
      "old@partner.example",
      "done@partner.example",
    ]) {
      const { payload } = await answerOf(
        await evaluate(await access.evaluationRequest({ email })),
      );
      expect(payload, email).toMatchObject({ success: false });
    }
  });

  it("says no for everyone before the Gateway has an owner", async () => {
    db = await createTestDb();
    testDb.current = db;
    const { payload } = await answerOf(
      await evaluate(
        await access.evaluationRequest({ email: "owner@acme.com" }),
      ),
    );
    expect(payload).toMatchObject({ success: false });
  });

  it("answers nothing to a token Access didn't sign, or one without a nonce", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({
      identity: { email: "owner@acme.com" },
      nonce: "n",
    })
      .setProtectedHeader({ alg: "RS256", kid: "team-key-1" })
      .setExpirationTime("1m")
      .sign(privateKey);
    for (const token of [
      forged,
      "not-a-token",
      await access.evaluationRequest({
        email: "owner@acme.com",
        claims: { nonce: undefined },
      }),
      await access.evaluationRequest({
        email: "owner@acme.com",
        claims: { exp: Math.floor(Date.now() / 1000) - 3600 },
      }),
    ]) {
      const response = await evaluate(token);
      expect(response?.status).toBe(400);
      await expect(response!.json()).resolves.toEqual({
        error: "invalid_token",
      });
    }
    const get = await serveAccessEvaluation(
      new Request(`${ORIGIN}/access-evaluation/evaluate`),
    );
    expect(get?.status).toBe(405);
  });

  it("keeps one key: made once, sealed at rest, the same after an isolate restarts", async () => {
    const first = (await keys()).keys[0]!["kid"];
    resetAccessEvaluationKeyForTests();
    expect((await keys()).keys[0]!["kid"]).toBe(first);
    const rows = await db.select().from(accessEvaluationKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.privateJwkSealed.startsWith("v1.")).toBe(true);
    expect(rows[0]!.privateJwkSealed).not.toContain('"d"');
  });

  it("replaces a key sealed under an earlier BETTER_AUTH_SECRET, and answers under the new one", async () => {
    const first = (await keys()).keys[0]!["kid"];
    useEnv({
      ...MOCK_ACCESS_ENV.outerRing,
      BETTER_AUTH_SECRET: "rotated-secret-0123456789abcdefghijklmnopq",
    });
    resetAccessEvaluationKeyForTests();

    const { payload, protectedHeader } = await answerOf(
      await evaluate(
        await access.evaluationRequest({ email: "owner@acme.com" }, "n-r"),
      ),
    );
    expect(payload).toMatchObject({ success: true, nonce: "n-r" });
    expect(protectedHeader.kid).not.toBe(first);
    expect((await keys()).keys.map((key) => key["kid"])).toEqual([
      protectedHeader.kid,
    ]);
    expect(await db.select().from(accessEvaluationKey)).toHaveLength(1);
  });

  it("is not there while the outer ring isn't configured, nor at any other path", async () => {
    useEnv({});
    expect(
      await evaluate(
        await access.evaluationRequest({ email: "owner@acme.com" }),
      ),
    ).toBeNull();
    useEnv({ ...MOCK_ACCESS_ENV.outerRing });
    expect(
      await serveAccessEvaluation(
        new Request(`${ORIGIN}/access-evaluation/other`),
      ),
    ).toBeNull();
  });
});
