/**
 * The outer ring's verified-assertion memo: one verification per token per
 * isolate for a minute at most, never past the token's expiry, shared by
 * the requests in flight, and nothing kept for a token that fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({ env: hoisted.env }));
vi.mock("./jwt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jwt")>();
  return { ...actual, verifyAccessJwt: vi.fn(actual.verifyAccessJwt) };
});

import { decodeJwt } from "jose";
import { clearJwksClientsForTests, verifyAccessJwt } from "./jwt";
import type { AccessOuterRingConfig } from "./config";
import {
  prewarmOuterRingAssertion,
  resetOuterRingPrewarmForTests,
} from "./index";
import {
  clearOuterRingVouchesForTests,
  verifyOuterRingAssertion,
} from "./outer-ring";
import {
  createMockAccess,
  MOCK_ACCESS_ENV,
  type MockAccess,
} from "@/test/mock-access";

const TEAM = `https://${MOCK_ACCESS_ENV.outerRing.CLOUDFLARE_ACCESS_TEAM_DOMAIN}`;
const AUD = MOCK_ACCESS_ENV.outerRing.CLOUDFLARE_ACCESS_AUD;

const outerRing: AccessOuterRingConfig = {
  issuer: TEAM,
  signInAudiences: [AUD],
  audiences: [AUD],
  certsUrl: `${TEAM}/cdn-cgi/access/certs`,
  autoJoinEveryone: false,
};

const verifications = vi.mocked(verifyAccessJwt);
let access: MockAccess;
let certsFetches: ReturnType<typeof vi.fn>;

function headersWith(assertion: string): Headers {
  return new Headers({ "cf-access-jwt-assertion": assertion });
}

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  clearOuterRingVouchesForTests();
  resetOuterRingPrewarmForTests();
  // Each mock Access signs with keys of its own.
  clearJwksClientsForTests();
  verifications.mockClear();
  access = await createMockAccess();
  certsFetches = vi.fn(access.fetch);
  vi.stubGlobal("fetch", certsFetches);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("verifyOuterRingAssertion", () => {
  it("verifies a token once and answers the same identity from memory after", async () => {
    const assertion = await access.assertion({ email: "owner@acme.com" });
    const first = await verifyOuterRingAssertion(
      headersWith(assertion),
      outerRing,
    );
    expect(first?.email).toBe("owner@acme.com");
    expect(first?.maySignIn).toBe(true);
    expect(verifications).toHaveBeenCalledTimes(1);

    const again = await verifyOuterRingAssertion(
      headersWith(assertion),
      outerRing,
    );
    expect(again).toEqual(first);
    // The cookie form of the same token is the same token.
    const fromCookie = await verifyOuterRingAssertion(
      new Headers({ cookie: `CF_Authorization=${assertion}` }),
      outerRing,
    );
    expect(fromCookie).toEqual(first);
    expect(verifications).toHaveBeenCalledTimes(1);
  });

  it("lets requests verifying the same token at once each run the check, over one JWKS fetch", async () => {
    // Nobody waits on another request's promise (in Workers it dies with
    // that request); the JWKS client shares the one fetch between them.
    const assertion = await access.assertion({ email: "owner@acme.com" });
    const [a, b, c] = await Promise.all([
      verifyOuterRingAssertion(headersWith(assertion), outerRing),
      verifyOuterRingAssertion(headersWith(assertion), outerRing),
      verifyOuterRingAssertion(headersWith(assertion), outerRing),
    ]);
    expect(a?.email).toBe("owner@acme.com");
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(verifications).toHaveBeenCalledTimes(3);
    expect(
      certsFetches.mock.calls.filter(([input]) =>
        String(input).endsWith("/cdn-cgi/access/certs"),
      ),
    ).toHaveLength(1);
    // Once settled, the next request reads the result.
    await verifyOuterRingAssertion(headersWith(assertion), outerRing);
    expect(verifications).toHaveBeenCalledTimes(3);
  });

  it("keeps nothing for a check that throws, and checks again next time", async () => {
    const assertion = await access.assertion({ email: "owner@acme.com" });
    verifications.mockRejectedValueOnce(new Error("keys unreadable"));
    await expect(
      verifyOuterRingAssertion(headersWith(assertion), outerRing),
    ).rejects.toThrow("keys unreadable");
    expect(
      (await verifyOuterRingAssertion(headersWith(assertion), outerRing))
        ?.email,
    ).toBe("owner@acme.com");
    expect(verifications).toHaveBeenCalledTimes(2);
  });

  it("verifies each token, and each configuration, on its own", async () => {
    const owner = await access.assertion({ email: "owner@acme.com" });
    const alice = await access.assertion({ email: "alice@acme.com" });
    expect(
      (await verifyOuterRingAssertion(headersWith(owner), outerRing))?.email,
    ).toBe("owner@acme.com");
    expect(
      (await verifyOuterRingAssertion(headersWith(alice), outerRing))?.email,
    ).toBe("alice@acme.com");
    expect(verifications).toHaveBeenCalledTimes(2);

    // Another application's audiences: the token is checked against them.
    const other = { ...outerRing, audiences: ["another-aud"] };
    expect(
      await verifyOuterRingAssertion(headersWith(owner), other),
    ).toBeNull();
    expect(verifications).toHaveBeenCalledTimes(3);
  });

  it("keeps nothing for a token that fails", async () => {
    const forged = `${await access.assertion({ email: "owner@acme.com" })}x`;
    expect(
      await verifyOuterRingAssertion(headersWith(forged), outerRing),
    ).toBeNull();
    expect(
      await verifyOuterRingAssertion(headersWith(forged), outerRing),
    ).toBeNull();
    expect(verifications).toHaveBeenCalledTimes(2);
    expect(await verifyOuterRingAssertion(new Headers(), outerRing)).toBeNull();
    expect(verifications).toHaveBeenCalledTimes(2);
  });

  it("forgets a verified token after a minute, and at its own expiry before that", async () => {
    const assertion = await access.assertion({ email: "owner@acme.com" });
    const now = Date.now();
    await verifyOuterRingAssertion(headersWith(assertion), outerRing, now);
    await verifyOuterRingAssertion(
      headersWith(assertion),
      outerRing,
      now + 59_000,
    );
    expect(verifications).toHaveBeenCalledTimes(1);
    await verifyOuterRingAssertion(
      headersWith(assertion),
      outerRing,
      now + 61_000,
    );
    expect(verifications).toHaveBeenCalledTimes(2);

    // A token about to expire is kept only until it does.
    const soon = Math.floor(now / 1000) + 10;
    const expiring = await access.assertion({
      email: "owner@acme.com",
      claims: { exp: soon },
    });
    expect(decodeJwt(expiring).exp).toBe(soon);
    expect(
      (await verifyOuterRingAssertion(headersWith(expiring), outerRing, now))
        ?.email,
    ).toBe("owner@acme.com");
    expect(verifications).toHaveBeenCalledTimes(3);
    await verifyOuterRingAssertion(
      headersWith(expiring),
      outerRing,
      now + 9_000,
    );
    expect(verifications).toHaveBeenCalledTimes(3);
    // Past exp the memo is gone; verification itself still allows 60 s of
    // clock skew, so it runs again rather than answering from memory.
    await verifyOuterRingAssertion(
      headersWith(expiring),
      outerRing,
      now + 11_000,
    );
    expect(verifications).toHaveBeenCalledTimes(4);
  });
});

describe("prewarmOuterRingAssertion", () => {
  it("starts the verification the session check reuses", async () => {
    Object.assign(hoisted.env, {
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      GATEWAY_URL: "https://gateway.example.com",
      ...MOCK_ACCESS_ENV.outerRing,
    });
    const assertion = await access.assertion({ email: "owner@acme.com" });
    prewarmOuterRingAssertion(headersWith(assertion));
    expect(verifications).toHaveBeenCalledTimes(1);
    // The session check, a moment later, finds the result.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const identity = await verifyOuterRingAssertion(
      headersWith(assertion),
      outerRing,
    );
    expect(identity?.email).toBe("owner@acme.com");
    expect(verifications).toHaveBeenCalledTimes(1);
  });

  it("does nothing without the outer ring, or without an assertion", async () => {
    Object.assign(hoisted.env, {
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      GATEWAY_URL: "https://gateway.example.com",
    });
    const assertion = await access.assertion({ email: "owner@acme.com" });
    prewarmOuterRingAssertion(headersWith(assertion));
    expect(verifications).not.toHaveBeenCalled();

    resetOuterRingPrewarmForTests();
    Object.assign(hoisted.env, MOCK_ACCESS_ENV.outerRing);
    prewarmOuterRingAssertion(new Headers());
    expect(verifications).not.toHaveBeenCalled();
  });
});
