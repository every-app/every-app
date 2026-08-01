import { describe, it, expect, beforeAll } from "vitest";
import { importSPKI, jwtVerify, decodeProtectedHeader, decodeJwt } from "jose";
import {
  mintIdentityJwt,
  mintPublicMarkerJwt,
  IDENTITY_KEY_ID,
  IDENTITY_ALG,
  IDENTITY_TTL_SECONDS,
  PUBLIC_MARKER_SUB,
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
