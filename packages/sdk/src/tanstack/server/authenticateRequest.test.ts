import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SignJWT, generateKeyPair, exportJWK } from "jose";

// Mock the cloudflare:workers module
vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_URL: "https://gateway.example.com",
    EVERY_APP_GATEWAY: null,
  },
}));

// Mock @tanstack/react-start/server
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: vi.fn(),
}));

import { authenticateRequest } from "./authenticateRequest";
import type { AuthConfig } from "./types";

describe("authenticateRequest", () => {
  let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwks: { keys: object[] };

  const authConfig: AuthConfig = {
    issuer: "https://gateway.example.com",
    audience: "test-app",
  };

  beforeEach(async () => {
    // Generate a fresh key pair for each test
    keyPair = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(keyPair.publicKey);

    jwks = {
      keys: [
        {
          ...publicJwk,
          kid: "test-key-1",
          use: "sig",
          alg: "RS256",
        },
      ],
    };

    // Mock global fetch for JWKS endpoint
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/embedded/jwks")) {
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createValidToken(overrides: Record<string, unknown> = {}) {
    // Token now only contains minimal claims: sub, email, iss, aud, exp, iat
    // appId is represented by aud claim, permissions and embeddedApp were removed
    const jwt = await new SignJWT({
      email: "user@example.com",
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user-123")
      .setIssuer(authConfig.issuer)
      .setAudience(authConfig.audience)
      .setExpirationTime("1h")
      .setIssuedAt()
      .sign(keyPair.privateKey);

    return jwt;
  }

  function createRequest(authHeader?: string): Request {
    const headers = new Headers();
    if (authHeader) {
      headers.set("authorization", authHeader);
    }
    return new Request("https://app.example.com/api/test", { headers });
  }

  describe("missing or invalid authorization header", () => {
    it("returns null when no authorization header is present", async () => {
      const request = createRequest();
      const result = await authenticateRequest(authConfig, request);
      expect(result).toBeNull();
    });

    it("returns null for empty authorization header", async () => {
      const request = createRequest("");
      const result = await authenticateRequest(authConfig, request);
      expect(result).toBeNull();
    });

    it("returns null for non-Bearer authorization", async () => {
      const request = createRequest("Basic dXNlcjpwYXNz");
      const result = await authenticateRequest(authConfig, request);
      expect(result).toBeNull();
    });

    it("returns null for malformed Bearer token (no space)", async () => {
      const request = createRequest("BearereyJhbGciOiJSUzI1NiJ9");
      const result = await authenticateRequest(authConfig, request);
      expect(result).toBeNull();
    });

    it("returns null for lowercase bearer prefix", async () => {
      const token = await createValidToken();
      const request = createRequest(`bearer ${token}`);
      const result = await authenticateRequest(authConfig, request);
      expect(result).toBeNull();
    });
  });

  describe("valid token verification", () => {
    it("returns payload for valid token with correct issuer and audience", async () => {
      const token = await createValidToken();
      const request = createRequest(`Bearer ${token}`);

      const result = await authenticateRequest(authConfig, request);

      expect(result).not.toBeNull();
      expect(result!.sub).toBe("user-123");
      expect(result!.email).toBe("user@example.com");
      expect(result!.iss).toBe(authConfig.issuer);
      // audience contains the appId
      expect(result!.aud).toBe(authConfig.audience);
    });

    it("includes iat and exp claims in returned payload", async () => {
      const token = await createValidToken();
      const request = createRequest(`Bearer ${token}`);

      const result = await authenticateRequest(authConfig, request);

      expect(result).not.toBeNull();
      expect(typeof result!.iat).toBe("number");
      expect(typeof result!.exp).toBe("number");
      expect(result!.exp).toBeGreaterThan(result!.iat);
    });
  });

  describe("token expiration", () => {
    it("returns null for expired token", async () => {
      const jwt = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user-123")
        .setIssuer(authConfig.issuer)
        .setAudience(authConfig.audience)
        .setExpirationTime("-1h") // Expired 1 hour ago
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200) // Issued 2 hours ago
        .sign(keyPair.privateKey);

      const request = createRequest(`Bearer ${jwt}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });
  });

  describe("issuer validation", () => {
    it("returns null for token with wrong issuer", async () => {
      const jwt = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user-123")
        .setIssuer("https://malicious.example.com") // Wrong issuer
        .setAudience(authConfig.audience)
        .setExpirationTime("1h")
        .setIssuedAt()
        .sign(keyPair.privateKey);

      const request = createRequest(`Bearer ${jwt}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });

    it("returns null for token with missing issuer", async () => {
      const jwt = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user-123")
        // No issuer set
        .setAudience(authConfig.audience)
        .setExpirationTime("1h")
        .setIssuedAt()
        .sign(keyPair.privateKey);

      const request = createRequest(`Bearer ${jwt}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });
  });

  describe("audience validation", () => {
    it("returns null for token with wrong audience", async () => {
      const jwt = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user-123")
        .setIssuer(authConfig.issuer)
        .setAudience("wrong-app") // Wrong audience
        .setExpirationTime("1h")
        .setIssuedAt()
        .sign(keyPair.privateKey);

      const request = createRequest(`Bearer ${jwt}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });

    it("returns null for token with missing audience", async () => {
      const jwt = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user-123")
        .setIssuer(authConfig.issuer)
        // No audience set
        .setExpirationTime("1h")
        .setIssuedAt()
        .sign(keyPair.privateKey);

      const request = createRequest(`Bearer ${jwt}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });
  });

  describe("signature validation", () => {
    it("returns null for token signed with different key", async () => {
      // Generate a different key pair
      const differentKeyPair = await generateKeyPair("RS256");

      const jwt = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user-123")
        .setIssuer(authConfig.issuer)
        .setAudience(authConfig.audience)
        .setExpirationTime("1h")
        .setIssuedAt()
        .sign(differentKeyPair.privateKey); // Different key!

      const request = createRequest(`Bearer ${jwt}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });

    it("returns null for tampered token payload", async () => {
      const token = await createValidToken();
      // Tamper with the payload by modifying the base64
      const [header, _payload, signature] = token.split(".");
      const tamperedPayload = btoa(
        JSON.stringify({ sub: "attacker-id", email: "attacker@evil.com" }),
      )
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

      const request = createRequest(`Bearer ${tamperedToken}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });

    it("returns null for malformed JWT structure", async () => {
      const malformedTokens = [
        "not.a.valid.jwt.structure",
        "only-one-part",
        "two.parts",
        "",
        "header.payload.", // Missing signature
        ".payload.signature", // Missing header
      ];

      for (const token of malformedTokens) {
        const request = createRequest(`Bearer ${token}`);
        const result = await authenticateRequest(authConfig, request);
        expect(result).toBeNull();
      }
    });
  });

  describe("algorithm restrictions", () => {
    it("returns null for HS256-signed token against RSA JWKS", async () => {
      // Create HS256 token using a symmetric secret
      const secret = new TextEncoder().encode("super-secret-key");
      const jwt = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("user-123")
        .setIssuer(authConfig.issuer)
        .setAudience(authConfig.audience)
        .setExpirationTime("1h")
        .setIssuedAt()
        .sign(secret);

      const request = createRequest(`Bearer ${jwt}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });

    it("returns null for unsecured 'none' algorithm token", async () => {
      // Craft a JWT with alg: none and no signature
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

      const payload = Buffer.from(
        JSON.stringify({
          sub: "user-123",
          iss: authConfig.issuer,
          aud: authConfig.audience,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: "user@example.com",
        }),
      )
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

      // Note the trailing dot for empty signature
      const unsecuredToken = `${header}.${payload}.`;

      const request = createRequest(`Bearer ${unsecuredToken}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });
  });

  describe("JWKS fetch failures", () => {
    it("returns null when JWKS endpoint returns 404", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response("Not Found", { status: 404 }));

      const token = await createValidToken();
      const request = createRequest(`Bearer ${token}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });

    it("returns null when JWKS endpoint returns 500", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response("Internal Server Error", { status: 500 }),
        );

      const token = await createValidToken();
      const request = createRequest(`Bearer ${token}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });

    it("returns null when JWKS fetch throws network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const token = await createValidToken();
      const request = createRequest(`Bearer ${token}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });

    it("returns null when JWKS returns invalid JSON", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response("not valid json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const token = await createValidToken();
      const request = createRequest(`Bearer ${token}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });

    it("returns null when JWKS has no matching key", async () => {
      // Return JWKS with a different key
      const differentKeyPair = await generateKeyPair("RS256");
      const differentJwk = await exportJWK(differentKeyPair.publicKey);

      global.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            keys: [{ ...differentJwk, kid: "different-key", alg: "RS256" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const token = await createValidToken();
      const request = createRequest(`Bearer ${token}`);
      const result = await authenticateRequest(authConfig, request);

      expect(result).toBeNull();
    });
  });
});
