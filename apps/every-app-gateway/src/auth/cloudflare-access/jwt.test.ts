import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SignJWT,
  base64url,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";
import {
  JwksClient,
  readAccessAssertion,
  verifyAccessJwt,
  type VerifyAccessJwtOptions,
} from "./jwt";

const TEAM = "https://acme.cloudflareaccess.com";
const CERTS = `${TEAM}/cdn-cgi/access/certs`;
const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey; jwk: JWK };

async function keyPair(kid: string): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  return {
    privateKey,
    publicKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}

let current: KeyPair;
let next: KeyPair;
let attacker: KeyPair;

beforeAll(async () => {
  current = await keyPair("kid-current");
  next = await keyPair("kid-next");
  attacker = await keyPair("kid-current");
});

function sign(
  claims: JWTPayload,
  options: { key?: KeyPair; kid?: string; expiresIn?: string | number } = {},
): Promise<string> {
  const key = options.key ?? current;
  const jwt = new SignJWT({
    email: "Alice@Example.com",
    name: "Alice",
    type: "app",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? key.jwk.kid! })
    .setIssuer(TEAM)
    .setAudience([AUD])
    .setSubject("7335d417-61da-459d-899c-0a01c76a2f94")
    .setIssuedAt();
  if (options.expiresIn !== undefined) jwt.setExpirationTime(options.expiresIn);
  else jwt.setExpirationTime("10m");
  return jwt.sign(key.privateKey);
}

/** A JWKS endpoint whose keys and failures a test controls. */
function jwksEndpoint(initial: JWK[] = []) {
  const state = {
    keys: initial,
    fail: false as false | "network" | "status",
    calls: 0,
  };
  const fetchImpl = vi.fn(async (url: string) => {
    state.calls += 1;
    expect(url).toBe(CERTS);
    if (state.fail === "network") throw new TypeError("network down");
    if (state.fail === "status") return new Response("nope", { status: 503 });
    return Response.json({ keys: state.keys, public_cert: {} });
  });
  return { state, fetchImpl };
}

let clock = 1_800_000_000_000;
const now = () => clock;

function client(endpoint: ReturnType<typeof jwksEndpoint>) {
  return new JwksClient(CERTS, { fetch: endpoint.fetchImpl, now });
}

function options(jwks: JwksClient): VerifyAccessJwtOptions {
  return { jwks, issuer: TEAM, audience: [AUD], now: new Date(clock) };
}

beforeEach(() => {
  clock = Date.now();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("verifyAccessJwt", () => {
  it("accepts a token Access signed for this application", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const identity = await verifyAccessJwt(
      await sign({}),
      options(client(endpoint)),
    );
    expect(identity).toMatchObject({
      email: "alice@example.com",
      name: "Alice",
      claims: { iss: TEAM, aud: [AUD], type: "app" },
    });
  });

  it("accepts any of several configured AUD tags", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const jwks = client(endpoint);
    const token = await sign({});
    expect(
      await verifyAccessJwt(token, {
        ...options(jwks),
        audience: ["other-app-aud", AUD],
      }),
    ).not.toBeNull();
  });

  it("refuses a token for another Access application (aud)", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const token = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "kid-current" })
      .setIssuer(TEAM)
      .setAudience("someone-elses-aud")
      .setExpirationTime("10m")
      .sign(current.privateKey);
    expect(await verifyAccessJwt(token, options(client(endpoint)))).toBeNull();
  });

  it("refuses a token from another team domain (iss)", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const token = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "kid-current" })
      .setIssuer("https://evil.cloudflareaccess.com")
      .setAudience(AUD)
      .setExpirationTime("10m")
      .sign(current.privateKey);
    expect(await verifyAccessJwt(token, options(client(endpoint)))).toBeNull();
  });

  it("refuses an expired token, allowing a minute of clock skew", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const jwks = client(endpoint);
    const seconds = Math.floor(clock / 1000);

    const justExpired = await sign({}, { expiresIn: seconds - 30 });
    expect(await verifyAccessJwt(justExpired, options(jwks))).not.toBeNull();

    const expired = await sign({}, { expiresIn: seconds - 120 });
    expect(await verifyAccessJwt(expired, options(jwks))).toBeNull();
  });

  it("refuses a token that isn't valid yet (nbf) or never expires", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const jwks = client(endpoint);
    const seconds = Math.floor(clock / 1000);

    const early = await sign({ nbf: seconds + 300 });
    expect(await verifyAccessJwt(early, options(jwks))).toBeNull();

    const noExpiry = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "kid-current" })
      .setIssuer(TEAM)
      .setAudience(AUD)
      .sign(current.privateKey);
    expect(await verifyAccessJwt(noExpiry, options(jwks))).toBeNull();
  });

  it("refuses an unsigned token (alg: none)", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const encode = (value: object) =>
      base64url.encode(new TextEncoder().encode(JSON.stringify(value)));
    const token = `${encode({ alg: "none", kid: "kid-current" })}.${encode({
      email: "alice@example.com",
      iss: TEAM,
      aud: [AUD],
      exp: Math.floor(clock / 1000) + 600,
    })}.`;
    expect(await verifyAccessJwt(token, options(client(endpoint)))).toBeNull();
    expect(endpoint.state.calls).toBe(0);
  });

  it("refuses an HS256 token keyed with the public key (algorithm confusion)", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const publicPem = await exportSPKI(current.publicKey);
    const token = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "HS256", kid: "kid-current" })
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(publicPem));
    expect(await verifyAccessJwt(token, options(client(endpoint)))).toBeNull();
  });

  it("refuses a token signed by another key under a known key id", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const forged = await sign({}, { key: attacker });
    expect(await verifyAccessJwt(forged, options(client(endpoint)))).toBeNull();
  });

  it("refuses a service token, which has no email", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const token = await sign({
      email: undefined,
      sub: "",
      common_name: "8c1a0f.access",
    });
    expect(await verifyAccessJwt(token, options(client(endpoint)))).toBeNull();
  });

  it("refuses a token that says its email isn't verified", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const token = await sign({ email_verified: false });
    expect(await verifyAccessJwt(token, options(client(endpoint)))).toBeNull();
  });

  it("returns null for garbage instead of throwing", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const jwks = client(endpoint);
    for (const token of ["", "not-a-jwt", "a.b.c", "....", "e30.e30.e30"]) {
      expect(await verifyAccessJwt(token, options(jwks))).toBeNull();
    }
  });
});

describe("JwksClient", () => {
  it("caches the key set, and fetches it again after ten minutes", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const jwks = client(endpoint);
    const token = await sign({});

    expect(await verifyAccessJwt(token, options(jwks))).not.toBeNull();
    expect(await verifyAccessJwt(token, options(jwks))).not.toBeNull();
    expect(endpoint.state.calls).toBe(1);

    clock += 10 * 60 * 1000 + 1;
    expect(await verifyAccessJwt(await sign({}), options(jwks))).not.toBeNull();
    expect(endpoint.state.calls).toBe(2);
  });

  it("shares one fetch between concurrent verifications", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const jwks = client(endpoint);
    const token = await sign({});
    const results = await Promise.all(
      [1, 2, 3].map(() => verifyAccessJwt(token, options(jwks))),
    );
    expect(results.every((identity) => identity !== null)).toBe(true);
    expect(endpoint.state.calls).toBe(1);
  });

  it("refetches for an unknown key id (a rotation), at most every 30 seconds", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const jwks = client(endpoint);
    expect(await verifyAccessJwt(await sign({}), options(jwks))).not.toBeNull();

    // Access rotated in a new key.
    endpoint.state.keys = [current.jwk, next.jwk];
    const rotated = await sign({}, { key: next });
    expect(await verifyAccessJwt(rotated, options(jwks))).not.toBeNull();
    expect(endpoint.state.calls).toBe(2);

    // Random key ids don't turn every request into a fetch: one refetch
    // per 30 seconds at most (the rotation above was one).
    const unknown = await sign({}, { kid: "kid-unknown" });
    expect(await verifyAccessJwt(unknown, options(jwks))).toBeNull();
    expect(endpoint.state.calls).toBe(2);

    clock += 31 * 1000;
    expect(await verifyAccessJwt(unknown, options(jwks))).toBeNull();
    expect(await verifyAccessJwt(unknown, options(jwks))).toBeNull();
    expect(
      await verifyAccessJwt(
        await sign({}, { kid: "kid-other" }),
        options(jwks),
      ),
    ).toBeNull();
    expect(endpoint.state.calls).toBe(3);

    clock += 31 * 1000;
    expect(await verifyAccessJwt(unknown, options(jwks))).toBeNull();
    expect(endpoint.state.calls).toBe(4);
  });

  it("never waits on a fetch that doesn't settle, and replaces it after the timeout", async () => {
    // In Workers a fetch belongs to the request that started it: when that
    // request is cancelled (its client went away), the fetch and its
    // timeout die with it and never settle.
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      if (fetchImpl.mock.calls.length === 1) return new Promise(() => {});
      return Response.json({ keys: [current.jwk] });
    });
    const jwks = new JwksClient(CERTS, {
      fetch: fetchImpl,
      now,
      fetchTimeoutMs: 50,
    });
    const token = await sign({});

    // Request A starts the fetch, then goes away.
    void verifyAccessJwt(token, options(jwks));

    // Request B joins that fetch, and gives up on it after the timeout:
    // nobody is signed in by Access, but nothing hangs.
    const started = performance.now();
    expect(await verifyAccessJwt(token, options(jwks))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Once the stuck fetch is older than the timeout, the next request
    // fetches the keys itself.
    clock += 50;
    expect(await verifyAccessJwt(token, options(jwks))).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await verifyAccessJwt(token, options(jwks))).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the key set can't be fetched", async () => {
    for (const failure of ["network", "status"] as const) {
      const endpoint = jwksEndpoint([current.jwk]);
      endpoint.state.fail = failure;
      expect(
        await verifyAccessJwt(await sign({}), options(client(endpoint))),
      ).toBeNull();
    }
  });

  it("never uses keys past their lifetime when a refresh fails", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const jwks = client(endpoint);
    expect(await verifyAccessJwt(await sign({}), options(jwks))).not.toBeNull();

    endpoint.state.fail = "network";
    clock += 10 * 60 * 1000 + 1;
    expect(await verifyAccessJwt(await sign({}), options(jwks))).toBeNull();

    // Back once Access answers again.
    endpoint.state.fail = false;
    expect(await verifyAccessJwt(await sign({}), options(jwks))).not.toBeNull();
  });

  it("keeps a fresh key set when a refetch for an unknown key fails", async () => {
    const endpoint = jwksEndpoint([current.jwk]);
    const jwks = client(endpoint);
    expect(await verifyAccessJwt(await sign({}), options(jwks))).not.toBeNull();

    endpoint.state.fail = "status";
    expect(
      await verifyAccessJwt(await sign({}, { key: next }), options(jwks)),
    ).toBeNull();
    expect(await verifyAccessJwt(await sign({}), options(jwks))).not.toBeNull();
  });

  it("ignores keys that aren't RS256 signing keys", async () => {
    const endpoint = jwksEndpoint([
      { ...current.jwk, use: "enc" },
      { ...next.jwk, alg: "RS512" },
    ]);
    const jwks = client(endpoint);
    expect(await verifyAccessJwt(await sign({}), options(jwks))).toBeNull();
    expect(
      await verifyAccessJwt(await sign({}, { key: next }), options(jwks)),
    ).toBeNull();
  });
});

describe("readAccessAssertion", () => {
  it("reads the Cf-Access-Jwt-Assertion header first, then the CF_Authorization cookie", () => {
    expect(
      readAccessAssertion(
        new Headers({
          "cf-access-jwt-assertion": "header.jwt.value",
          cookie: "CF_Authorization=cookie.jwt.value",
        }),
      ),
    ).toBe("header.jwt.value");
    expect(
      readAccessAssertion(
        new Headers({
          cookie:
            "better-auth.session_token=abc; CF_Authorization=cookie.jwt.value",
        }),
      ),
    ).toBe("cookie.jwt.value");
    expect(readAccessAssertion(new Headers({ cookie: "other=1" }))).toBeNull();
    expect(readAccessAssertion(new Headers())).toBeNull();
  });
});
