import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateKeyPair,
  exportPKCS8,
  exportSPKI,
  jwtVerify,
  createLocalJWKSet,
} from "jose";

// Store the key pair and PEM strings at module level so they can be used by the mock
let testPrivateKeyPem: string;
let testPublicKeyPem: string;

// We need to mock the modules before importing the code under test
vi.mock("cloudflare:workers", () => ({
  get env() {
    return {
      JWT_PRIVATE_KEY: testPrivateKeyPem,
      JWT_PUBLIC_KEY: testPublicKeyPem,
      GATEWAY_URL: "https://gateway.example.com",
    };
  },
}));

vi.mock("../auth", () => ({
  auth: {
    $Infer: {
      Session: {
        user: {},
      },
    },
  },
}));

describe("jwt-utils", () => {
  beforeEach(async () => {
    vi.resetModules();

    // Generate a test key pair with extractable: true
    const testKeyPair = await generateKeyPair("RS256", { extractable: true });

    // Export keys to PEM format
    testPrivateKeyPem = await exportPKCS8(testKeyPair.privateKey);
    testPublicKeyPem = await exportSPKI(testKeyPair.publicKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("issueEmbeddedAppToken", () => {
    const mockUser = {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "active",
      banned: false,
    };

    // Minimal additional claims - the token now only contains essential fields
    const additionalClaims = { orgId: "org-test-123" };

    it("issues a valid JWT token with correct structure", async () => {
      const { issueEmbeddedAppToken } = await import("./jwt-utils");

      const token = await issueEmbeddedAppToken(
        mockUser,
        "test-audience",
        additionalClaims,
      );

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");

      // JWT should have 3 parts
      const parts = token.split(".");
      expect(parts).toHaveLength(3);
    });

    it("includes correct standard claims", async () => {
      const { issueEmbeddedAppToken, getPublicJWKS } = await import(
        "./jwt-utils"
      );

      const token = await issueEmbeddedAppToken(
        mockUser,
        "test-audience",
        additionalClaims,
      );

      // Verify the token using the public key
      const jwks = await getPublicJWKS();
      const localJWKS = createLocalJWKSet(jwks);
      const { payload } = await jwtVerify(token, localJWKS, {
        issuer: "https://gateway.example.com",
        audience: "test-audience",
      });

      // Check standard claims
      expect(payload.sub).toBe("user-123");
      expect(payload.iss).toBe("https://gateway.example.com");
      expect(payload.aud).toBe("test-audience");
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
    });

    it("includes user email in claims (name excluded for minimal payload)", async () => {
      const { issueEmbeddedAppToken, getPublicJWKS } = await import(
        "./jwt-utils"
      );

      const token = await issueEmbeddedAppToken(
        mockUser,
        "test-audience",
        additionalClaims,
      );

      const jwks = await getPublicJWKS();
      const localJWKS = createLocalJWKSet(jwks);
      const { payload } = await jwtVerify(token, localJWKS, {
        issuer: "https://gateway.example.com",
        audience: "test-audience",
      });

      expect(payload.email).toBe("test@example.com");
      expect(payload.orgId).toBe("org-test-123");
      // name is intentionally excluded to minimize token payload
      expect(payload.name).toBeUndefined();
    });

    it("does not include deprecated claims (appId, permissions, embeddedApp)", async () => {
      const { issueEmbeddedAppToken, getPublicJWKS } = await import(
        "./jwt-utils"
      );

      const token = await issueEmbeddedAppToken(
        mockUser,
        "test-audience",
        additionalClaims,
      );

      const jwks = await getPublicJWKS();
      const localJWKS = createLocalJWKSet(jwks);
      const { payload } = await jwtVerify(token, localJWKS, {
        issuer: "https://gateway.example.com",
        audience: "test-audience",
      });

      // These claims were removed to minimize the token payload
      // appId is redundant with aud, permissions was always empty, embeddedApp was always true
      expect(payload.appId).toBeUndefined();
      expect(payload.permissions).toBeUndefined();
      expect(payload.embeddedApp).toBeUndefined();
    });

    it("sets correct expiration time", async () => {
      const { issueEmbeddedAppToken, getPublicJWKS } = await import(
        "./jwt-utils"
      );
      const { EMBEDDED_APP_TOKEN_EXPIRY_SECONDS } = await import("./constants");

      const beforeIssue = Math.floor(Date.now() / 1000);

      const token = await issueEmbeddedAppToken(
        mockUser,
        "test-audience",
        additionalClaims,
      );

      const afterIssue = Math.floor(Date.now() / 1000);

      const jwks = await getPublicJWKS();
      const localJWKS = createLocalJWKSet(jwks);
      const { payload } = await jwtVerify(token, localJWKS, {
        issuer: "https://gateway.example.com",
        audience: "test-audience",
      });

      // Expiration should be EMBEDDED_APP_TOKEN_EXPIRY_SECONDS from now
      const expectedMinExp = beforeIssue + EMBEDDED_APP_TOKEN_EXPIRY_SECONDS;
      const expectedMaxExp = afterIssue + EMBEDDED_APP_TOKEN_EXPIRY_SECONDS + 1;

      expect(payload.exp).toBeGreaterThanOrEqual(expectedMinExp);
      expect(payload.exp).toBeLessThanOrEqual(expectedMaxExp);
    });

    it("uses RS256 algorithm with kid in header (RFC 7515 compliance)", async () => {
      const { issueEmbeddedAppToken } = await import("./jwt-utils");

      const token = await issueEmbeddedAppToken(
        mockUser,
        "test-audience",
        additionalClaims,
      );

      // Decode header to check algorithm and kid
      const [headerB64] = token.split(".");
      const header = JSON.parse(atob(headerB64));

      expect(header.alg).toBe("RS256");
      // kid must be present for JWKS key selection during verification
      expect(header.kid).toBe("embedded-app-key-1");
    });

    it("sets different audiences correctly", async () => {
      const { issueEmbeddedAppToken, getPublicJWKS } = await import(
        "./jwt-utils"
      );

      const token1 = await issueEmbeddedAppToken(
        mockUser,
        "app-1",
        additionalClaims,
      );
      const token2 = await issueEmbeddedAppToken(
        mockUser,
        "app-2",
        additionalClaims,
      );

      const jwks = await getPublicJWKS();
      const localJWKS = createLocalJWKSet(jwks);

      const { payload: payload1 } = await jwtVerify(token1, localJWKS, {
        issuer: "https://gateway.example.com",
        audience: "app-1",
      });
      const { payload: payload2 } = await jwtVerify(token2, localJWKS, {
        issuer: "https://gateway.example.com",
        audience: "app-2",
      });

      expect(payload1.aud).toBe("app-1");
      expect(payload2.aud).toBe("app-2");
    });

    it("handles different users correctly", async () => {
      const { issueEmbeddedAppToken, getPublicJWKS } = await import(
        "./jwt-utils"
      );

      const user1 = {
        ...mockUser,
        id: "user-1" as const,
        email: "user1@example.com",
      };
      const user2 = {
        ...mockUser,
        id: "user-2" as const,
        email: "user2@example.com",
      };

      const token1 = await issueEmbeddedAppToken(
        user1,
        "test-audience",
        additionalClaims,
      );
      const token2 = await issueEmbeddedAppToken(
        user2,
        "test-audience",
        additionalClaims,
      );

      const jwks = await getPublicJWKS();
      const localJWKS = createLocalJWKSet(jwks);

      const { payload: payload1 } = await jwtVerify(token1, localJWKS, {
        issuer: "https://gateway.example.com",
        audience: "test-audience",
      });
      const { payload: payload2 } = await jwtVerify(token2, localJWKS, {
        issuer: "https://gateway.example.com",
        audience: "test-audience",
      });

      expect(payload1.sub).toBe("user-1");
      expect(payload1.email).toBe("user1@example.com");
      expect(payload2.sub).toBe("user-2");
      expect(payload2.email).toBe("user2@example.com");
    });
  });

  describe("getPublicJWKS", () => {
    it("returns a valid JWKS structure", async () => {
      const { getPublicJWKS } = await import("./jwt-utils");

      const jwks = await getPublicJWKS();

      expect(jwks).toHaveProperty("keys");
      expect(Array.isArray(jwks.keys)).toBe(true);
      expect(jwks.keys).toHaveLength(1);
    });

    it("includes required JWK properties", async () => {
      const { getPublicJWKS } = await import("./jwt-utils");

      const jwks = await getPublicJWKS();
      const key = jwks.keys[0];

      expect(key).toHaveProperty("kid", "embedded-app-key-1");
      expect(key).toHaveProperty("use", "sig");
      expect(key).toHaveProperty("alg", "RS256");
      expect(key).toHaveProperty("kty", "RSA");
      expect(key).toHaveProperty("n"); // RSA modulus
      expect(key).toHaveProperty("e"); // RSA exponent
    });

    it("does not expose private key material", async () => {
      const { getPublicJWKS } = await import("./jwt-utils");

      const jwks = await getPublicJWKS();
      const key = jwks.keys[0] as Record<string, unknown>;

      // These are private key components that should NOT be present
      expect(key).not.toHaveProperty("d");
      expect(key).not.toHaveProperty("p");
      expect(key).not.toHaveProperty("q");
      expect(key).not.toHaveProperty("dp");
      expect(key).not.toHaveProperty("dq");
      expect(key).not.toHaveProperty("qi");
    });

    it("returns consistent key across multiple calls", async () => {
      const { getPublicJWKS } = await import("./jwt-utils");

      const jwks1 = await getPublicJWKS();
      const jwks2 = await getPublicJWKS();

      expect(jwks1.keys[0]).toEqual(jwks2.keys[0]);
    });
  });

  describe("token verification roundtrip", () => {
    it("tokens issued can be verified with the public JWKS", async () => {
      const { issueEmbeddedAppToken, getPublicJWKS } = await import(
        "./jwt-utils"
      );

      const mockUser = {
        id: "user-123",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: "active",
        banned: false,
      };

      const token = await issueEmbeddedAppToken(mockUser, "test-audience", {
        orgId: "org-test-123",
      });

      const jwks = await getPublicJWKS();
      const localJWKS = createLocalJWKSet(jwks);

      // This should not throw
      const { payload } = await jwtVerify(token, localJWKS, {
        issuer: "https://gateway.example.com",
        audience: "test-audience",
      });

      expect(payload.sub).toBe("user-123");
    });

    it("tokens fail verification with wrong audience", async () => {
      const { issueEmbeddedAppToken, getPublicJWKS } = await import(
        "./jwt-utils"
      );

      const mockUser = {
        id: "user-123",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: "active",
        banned: false,
      };

      const token = await issueEmbeddedAppToken(mockUser, "correct-audience", {
        orgId: "org-test-123",
      });

      const jwks = await getPublicJWKS();
      const localJWKS = createLocalJWKSet(jwks);

      await expect(
        jwtVerify(token, localJWKS, {
          issuer: "https://gateway.example.com",
          audience: "wrong-audience",
        }),
      ).rejects.toThrow();
    });

    it("tokens fail verification with wrong issuer", async () => {
      const { issueEmbeddedAppToken, getPublicJWKS } = await import(
        "./jwt-utils"
      );

      const mockUser = {
        id: "user-123",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: "active",
        banned: false,
      };

      const token = await issueEmbeddedAppToken(mockUser, "test-audience", {
        orgId: "org-test-123",
      });

      const jwks = await getPublicJWKS();
      const localJWKS = createLocalJWKSet(jwks);

      await expect(
        jwtVerify(token, localJWKS, {
          issuer: "https://wrong-issuer.example.com",
          audience: "test-audience",
        }),
      ).rejects.toThrow();
    });
  });
});
