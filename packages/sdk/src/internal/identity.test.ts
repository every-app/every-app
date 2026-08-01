import { describe, it, expect, beforeAll } from "vitest";
import {
  SignJWT,
  generateKeyPair,
  exportPKCS8,
  exportSPKI,
  importPKCS8,
} from "jose";
import {
  verifyIdentityJwt,
  getIdentityFromRequest,
  parsePublicKeys,
  ConfigurationError,
  IdentityError,
  IDENTITY_ALG,
  IDENTITY_KEY_ID,
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  PUBLIC_HEADER,
  PUBLIC_MARKER_SUB,
  DEV_ENV,
  ISSUER_ENV,
} from "./identity";

let privatePem: string;
let publicPem: string;
let otherPublicPem: string;
const issuer = "https://home.example.com";

async function mint(
  claims: Record<string, unknown>,
  opts: {
    alg?: string;
    kid?: string | null;
    aud?: string;
    exp?: string | number | null;
    iss?: string;
    key?: CryptoKey | Uint8Array;
  } = {},
): Promise<string> {
  const key = opts.key ?? (await importPKCS8(privatePem, IDENTITY_ALG));
  const header: Record<string, unknown> = { alg: opts.alg ?? IDENTITY_ALG };
  if (opts.kid !== null) header.kid = opts.kid ?? IDENTITY_KEY_ID;
  let jwt = new SignJWT({
    email: "a@b.com",
    org_id: "org_1",
    org_role: "member",
    chan: "web",
    act: { sub: "user_1" },
    jti: "j1",
    typ: "user",
    ...claims,
  })
    .setProtectedHeader(header as never)
    .setSubject((claims.sub as string) ?? "user_1")
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? "todo")
    .setIssuedAt();
  if (opts.exp !== null) jwt = jwt.setExpirationTime(opts.exp ?? "120s");
  return jwt.sign(key as never);
}

beforeAll(async () => {
  const a = await generateKeyPair("RS256", { extractable: true });
  privatePem = await exportPKCS8(a.privateKey);
  publicPem = await exportSPKI(a.publicKey);
  const b = await generateKeyPair("RS256", { extractable: true });
  otherPublicPem = await exportSPKI(b.publicKey);
});

describe("verifyIdentityJwt — happy path", () => {
  it("verifies a valid token and maps claims to a user", async () => {
    const token = await mint({});
    const user = await verifyIdentityJwt(token, {
      publicKeys: [publicPem],
      audience: "todo",
      issuer,
    });
    expect(user).toMatchObject({
      id: "user_1",
      email: "a@b.com",
      orgId: "org_1",
      orgRole: "member",
      channel: "web",
      actor: { sub: "user_1" },
      scopes: ["*"],
    });
  });

  it("surfaces explicit scopes from the identity token", async () => {
    const token = await mint({ scopes: ["mcp:read", "api:write"] });
    const user = await verifyIdentityJwt(token, {
      publicKeys: [publicPem],
      audience: "todo",
      issuer,
    });
    expect(user.scopes).toEqual(["mcp:read", "api:write"]);
  });

  it("accepts the token under a rotated (next) key in the set", async () => {
    const token = await mint({});
    const user = await verifyIdentityJwt(token, {
      publicKeys: [otherPublicPem, publicPem], // current is the 2nd key
      audience: "todo",
      issuer,
    });
    expect(user.id).toBe("user_1");
  });
});

describe("verifyIdentityJwt — fail closed", () => {
  it("rejects a wrong audience", async () => {
    const token = await mint({}, { aud: "chef" });
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects an expired token", async () => {
    const token = await mint({}, { exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a token without an exp claim", async () => {
    const token = await mint({}, { exp: null });
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a token signed by an unknown key", async () => {
    const token = await mint({});
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [otherPublicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects alg:none", async () => {
    // Unsecured JWT (alg none, no signature).
    const header = Buffer.from(
      JSON.stringify({ alg: "none", kid: IDENTITY_KEY_ID }),
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        sub: "user_1",
        email: "a@b.com",
        org_id: "o",
        org_role: "member",
        aud: "todo",
        exp: Math.floor(Date.now() / 1000) + 120,
      }),
    ).toString("base64url");
    const token = `${header}.${body}.`;
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects algorithm confusion (HS256 signed with the public key as secret)", async () => {
    const secret = new TextEncoder().encode(publicPem);
    const token = await mint({}, { alg: "HS256", key: secret });
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a mismatched kid", async () => {
    const token = await mint({}, { kid: "attacker-key" });
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a token missing required claims", async () => {
    const token = await mint({ org_id: undefined, org_role: undefined });
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a malformed token", async () => {
    await expect(
      verifyIdentityJwt("not.a.jwt", {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a user token with a clear error when issuer is not configured", async () => {
    const token = await mint({});
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
      }),
    ).rejects.toMatchObject({
      name: "IdentityError",
      message: expect.stringContaining(
        "EVERYAPP_IDENTITY_ISSUER not configured",
      ),
    });
  });

  it("rejects a user token from the wrong issuer", async () => {
    const token = await mint({}, { iss: "https://evil.example.com" });
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });
});

describe("dev identity kid — the dev/prod signer firewall", () => {
  it("REJECTS a dev-kid token by default (production), even with the right key", async () => {
    // The exploit: a leaked dev key whose public half landed in a prod key set.
    // It must be rejected at the header pin, before any signature check.
    const token = await mint({}, { kid: IDENTITY_DEV_KEY_ID });
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [publicPem],
        audience: "todo",
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("accepts a dev-kid token ONLY when allowDevIdentities is set", async () => {
    const token = await mint({}, { kid: IDENTITY_DEV_KEY_ID });
    const user = await verifyIdentityJwt(token, {
      publicKeys: [publicPem],
      audience: "todo",
      issuer,
      allowDevIdentities: true,
    });
    expect(user.id).toBe("user_1");
  });

  it("still rejects the prod kid signed by the wrong key, dev mode or not", async () => {
    const token = await mint({}, { kid: IDENTITY_KEY_ID });
    await expect(
      verifyIdentityJwt(token, {
        publicKeys: [otherPublicPem],
        audience: "todo",
        issuer,
        allowDevIdentities: true,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("getIdentityFromRequest accepts the dev kid only for strict EVERYAPP_DEV values", async () => {
    const token = await mint({}, { kid: IDENTITY_DEV_KEY_ID });
    const req = () =>
      new Request("https://todo.localhost/tasks", {
        headers: { [IDENTITY_HEADER]: token },
      });

    // No EVERYAPP_DEV → rejected (production behavior).
    await expect(
      getIdentityFromRequest(req(), {
        audience: "todo",
        env: {
          EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicPem]),
          [ISSUER_ENV]: issuer,
        },
      }),
    ).rejects.toBeInstanceOf(IdentityError);

    // A non-empty but disabled value must not opt in.
    await expect(
      getIdentityFromRequest(req(), {
        audience: "todo",
        env: {
          EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicPem]),
          [ISSUER_ENV]: issuer,
          [DEV_ENV]: "0",
        },
      }),
    ).rejects.toBeInstanceOf(IdentityError);

    // EVERYAPP_DEV=1 → accepted (local dev behavior).
    const { user } = await getIdentityFromRequest(req(), {
      audience: "todo",
      env: {
        EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicPem]),
        [ISSUER_ENV]: issuer,
        [DEV_ENV]: "1",
      },
    });
    expect(user?.id).toBe("user_1");

    const { user: trueUser } = await getIdentityFromRequest(req(), {
      audience: "todo",
      env: {
        EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicPem]),
        [ISSUER_ENV]: issuer,
        [DEV_ENV]: "TRUE",
      },
    });
    expect(trueUser?.id).toBe("user_1");
  });
});

describe("parsePublicKeys", () => {
  it("parses a JSON array of PEMs", () => {
    expect(
      parsePublicKeys(JSON.stringify([publicPem, otherPublicPem])),
    ).toEqual([publicPem, otherPublicPem]);
  });
  it("parses a single PEM string", () => {
    expect(parsePublicKeys(publicPem)).toEqual([publicPem]);
  });
  it("throws when unset", () => {
    expect(() => parsePublicKeys(undefined)).toThrow(ConfigurationError);
    expect(() => parsePublicKeys("")).toThrow(ConfigurationError);
  });
  it("throws ConfigurationError for malformed JSON key config", () => {
    expect(() => parsePublicKeys("[nope")).toThrow(ConfigurationError);
  });
});

describe("getIdentityFromRequest", () => {
  it("returns the user for a valid identity header", async () => {
    const token = await mint({});
    const req = new Request("https://todo.example.com/tasks", {
      headers: { [IDENTITY_HEADER]: token },
    });
    const { user, isPublic } = await getIdentityFromRequest(req, {
      audience: "todo",
      publicKeys: [publicPem],
      issuer,
    });
    expect(isPublic).toBe(false);
    expect(user?.id).toBe("user_1");
  });

  it("returns {user:null, isPublic:true} for a SIGNED public marker", async () => {
    const marker = await mint({
      typ: "public",
      pub: true,
      sub: PUBLIC_MARKER_SUB,
    });
    const req = new Request("https://todo.example.com/health", {
      headers: { [PUBLIC_HEADER]: marker },
    });
    const res = await getIdentityFromRequest(req, {
      audience: "todo",
      publicKeys: [publicPem],
    });
    expect(res).toEqual({ user: null, isPublic: true });
  });

  it("rejects a signed public marker without an exp claim", async () => {
    const marker = await mint(
      { typ: "public", pub: true, sub: PUBLIC_MARKER_SUB },
      { exp: null },
    );
    const req = new Request("https://todo.example.com/health", {
      headers: { [PUBLIC_HEADER]: marker },
    });
    await expect(
      getIdentityFromRequest(req, {
        audience: "todo",
        publicKeys: [publicPem],
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a bare '1' public header (spoofed on a re-exposed worker)", async () => {
    const req = new Request("https://todo.example.com/health", {
      headers: { [PUBLIC_HEADER]: "1" },
    });
    await expect(
      getIdentityFromRequest(req, {
        audience: "todo",
        publicKeys: [publicPem],
        issuer,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a public marker scoped to a different app", async () => {
    const marker = await mint(
      { typ: "public", pub: true, sub: PUBLIC_MARKER_SUB },
      { aud: "chef" },
    );
    const req = new Request("https://todo.example.com/health", {
      headers: { [PUBLIC_HEADER]: marker },
    });
    await expect(
      getIdentityFromRequest(req, {
        audience: "todo",
        publicKeys: [publicPem],
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects an identity token smuggled into the public header", async () => {
    const identityToken = await mint({});
    const req = new Request("https://todo.example.com/health", {
      headers: { [PUBLIC_HEADER]: identityToken },
    });
    await expect(
      getIdentityFromRequest(req, {
        audience: "todo",
        publicKeys: [publicPem],
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a public marker smuggled into the identity header", async () => {
    const publicMarker = await mint({
      typ: "public",
      pub: true,
      sub: PUBLIC_MARKER_SUB,
    });
    const req = new Request("https://todo.example.com/tasks", {
      headers: { [IDENTITY_HEADER]: publicMarker },
    });
    await expect(
      getIdentityFromRequest(req, {
        audience: "todo",
        publicKeys: [publicPem],
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("throws when no identity header is present (not proxied)", async () => {
    const req = new Request("https://todo.example.com/tasks");
    await expect(
      getIdentityFromRequest(req, {
        audience: "todo",
        publicKeys: [publicPem],
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("reads keys from env when publicKeys is omitted", async () => {
    const token = await mint({});
    const req = new Request("https://todo.example.com/tasks", {
      headers: { [IDENTITY_HEADER]: token },
    });
    const { user } = await getIdentityFromRequest(req, {
      audience: "todo",
      env: {
        EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicPem]),
        [ISSUER_ENV]: issuer,
      },
    });
    expect(user?.id).toBe("user_1");
  });
});
