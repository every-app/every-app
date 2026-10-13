import { describe, it, expect, beforeAll } from "vitest";
import { importSPKI, jwtVerify, decodeProtectedHeader, decodeJwt } from "jose";
import {
  identityClaimsToEveryAppUser,
  mintIdentityJwt,
  mintPublicMarkerJwt,
  mintSystemJwt,
  IDENTITY_KEY_ID,
  IDENTITY_ALG,
  IDENTITY_TTL_SECONDS,
  PUBLIC_MARKER_SUB,
  SYSTEM_TOKEN_SUB,
  SYSTEM_TOKEN_TTL_SECONDS,
} from "./protocol";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKeyPem = await exportPKCS8(keys.privateKey);
  publicKeyPem = await exportSPKI(keys.publicKey);
});

const subject = {
  sub: "user_1",
  email: "a@b.com",
  orgId: "org_1",
  orgRole: "member",
};

describe("mintIdentityJwt", () => {
  it("mints a verifiable RS256 token with the pinned kid and user typ", async () => {
    const jwt = await mintIdentityJwt(privateKeyPem, {
      subject,
      audience: "todo",
      issuer: "https://home.example.com",
    });
    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe(IDENTITY_ALG);
    expect(header.kid).toBe(IDENTITY_KEY_ID);

    const pub = await importSPKI(publicKeyPem, IDENTITY_ALG);
    const { payload } = await jwtVerify(jwt, pub, {
      audience: "todo",
      issuer: "https://home.example.com",
    });
    expect(payload.typ).toBe("user");
    expect(payload.sub).toBe("user_1");
    expect(payload.email).toBe("a@b.com");
    expect(payload.org_id).toBe("org_1");
    expect(payload.org_role).toBe("member");
    expect(payload.chan).toBe("web");
    expect(payload.act).toEqual({ sub: "user_1" });
    expect(payload.scopes).toEqual(["*"]);
    expect(typeof payload.jti).toBe("string");
  });

  it("sets a ~120s expiry", async () => {
    const now = 1_000_000_000_000;
    const jwt = await mintIdentityJwt(privateKeyPem, {
      subject,
      audience: "todo",
      issuer: "iss",
      now,
    });
    const payload = decodeJwt(jwt);
    expect(payload.exp).toBe(Math.floor(now / 1000) + IDENTITY_TTL_SECONDS);
  });

  it("scopes aud to the app and supports channel/actor overrides", async () => {
    const jwt = await mintIdentityJwt(privateKeyPem, {
      subject,
      audience: "chef",
      issuer: "iss",
      channel: "api",
      actor: { sub: "pat:token-x" },
      scopes: ["mcp:read", "api:write"],
    });
    const pub = await importSPKI(publicKeyPem, IDENTITY_ALG);
    const { payload } = await jwtVerify(jwt, pub, { audience: "chef" });
    expect(payload.aud).toBe("chef");
    expect(payload.chan).toBe("api");
    expect(payload.act).toEqual({ sub: "pat:token-x" });
    expect(payload.scopes).toEqual(["mcp:read", "api:write"]);
    await expect(jwtVerify(jwt, pub, { audience: "todo" })).rejects.toThrow();
  });
});

describe("mintPublicMarkerJwt", () => {
  it("mints a verifiable public marker with public typ", async () => {
    const jwt = await mintPublicMarkerJwt(privateKeyPem, {
      audience: "todo",
      issuer: "https://home.example.com",
    });
    const pub = await importSPKI(publicKeyPem, IDENTITY_ALG);
    const { payload } = await jwtVerify(jwt, pub, {
      audience: "todo",
      issuer: "https://home.example.com",
    });
    expect(payload.typ).toBe("public");
    expect(payload.pub).toBe(true);
    expect(payload.sub).toBe(PUBLIC_MARKER_SUB);
  });
});

describe("tool-call identities", () => {
  it("mints the tc claim and surfaces it as user.toolCall", async () => {
    const jwt = await mintIdentityJwt(privateKeyPem, {
      subject,
      audience: "todo",
      issuer: "iss",
      channel: "mcp",
      actor: { sub: "pat:token-x" },
      scopes: ["mcp:read", "mcp:write"],
      toolCall: { id: "call_1", name: "create_todo" },
    });
    const payload = decodeJwt(jwt);
    expect(payload.tc).toEqual({ id: "call_1", name: "create_todo" });
    expect(identityClaimsToEveryAppUser(payload)).toMatchObject({
      channel: "mcp",
      toolCall: { id: "call_1", name: "create_todo" },
    });
  });

  it("leaves tc off ordinary identities", async () => {
    const payload = decodeJwt(
      await mintIdentityJwt(privateKeyPem, {
        subject,
        audience: "todo",
        issuer: "iss",
      }),
    );
    expect(payload).not.toHaveProperty("tc");
    expect(identityClaimsToEveryAppUser(payload)).not.toHaveProperty(
      "toolCall",
    );
  });

  it("rejects a malformed tc claim", () => {
    const base = {
      typ: "user",
      sub: "user_1",
      email: "a@b.com",
      org_id: "org_1",
      org_role: "member",
    };
    for (const tc of [
      null,
      "create_todo",
      { id: "c" },
      { id: "", name: "x" },
    ]) {
      expect(() => identityClaimsToEveryAppUser({ ...base, tc })).toThrow(
        "malformed tc claim",
      );
    }
  });
});

describe("mintSystemJwt", () => {
  it("mints a one-purpose, app-scoped token that expires within a minute", async () => {
    const now = 1_000_000_000_000;
    const jwt = await mintSystemJwt(privateKeyPem, {
      audience: "todo",
      issuer: "https://home.example.com",
      purpose: "tools.list",
      now,
    });
    expect(decodeProtectedHeader(jwt)).toMatchObject({
      alg: IDENTITY_ALG,
      kid: IDENTITY_KEY_ID,
    });
    const payload = decodeJwt(jwt);
    expect(payload).toMatchObject({
      typ: "system",
      purpose: "tools.list",
      sub: SYSTEM_TOKEN_SUB,
      aud: "todo",
      iss: "https://home.example.com",
    });
    expect(payload).not.toHaveProperty("email");
    expect(payload.exp).toBe(Math.floor(now / 1000) + SYSTEM_TOKEN_TTL_SECONDS);
  });

  it("refuses lifetimes over a minute", async () => {
    await expect(
      mintSystemJwt(privateKeyPem, {
        audience: "todo",
        issuer: "iss",
        purpose: "tools.list",
        ttlSeconds: SYSTEM_TOKEN_TTL_SECONDS + 1,
      }),
    ).rejects.toThrow(RangeError);
  });
});
