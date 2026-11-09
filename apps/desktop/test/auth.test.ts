import { describe, expect, it } from "vitest";
import { challengeFor, createPkce, isValidVerifier } from "../src/main/auth/pkce";
import { parseRedirect, parseRedirectHead } from "../src/main/auth/redirect";
import { authorizationServerMetadataUrl, normalized, originOf, typedAppUrl } from "../src/main/auth/url";
import { OAuthClient, formEncode } from "../src/main/auth/oauth";

describe("PKCE", () => {
  it("matches RFC 7636 appendix B", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("makes fresh, valid, unique verifiers", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).toHaveLength(43);
    expect(isValidVerifier(a.verifier)).toBe(true);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.method).toBe("S256");
    expect(a.challenge).toBe(challengeFor(a.verifier));
  });
  it("validates verifiers", () => {
    expect(isValidVerifier("a".repeat(42))).toBe(false);
    expect(isValidVerifier("a".repeat(129))).toBe(false);
    expect(isValidVerifier(`${"a".repeat(42)}+`)).toBe(false);
    expect(isValidVerifier("A-._~".repeat(9))).toBe(true);
  });
});

describe("loopback redirect parser", () => {
  const ex = { state: "s1", issuer: "https://gw.example.com", issRequired: false };
  it("takes a code with the right state", () => {
    expect(parseRedirect("GET", "/callback?code=abc&state=s1", ex)).toEqual({ kind: "code", code: "abc" });
  });
  it("reports a denial", () => {
    expect(parseRedirect("GET", "/callback?error=access_denied&state=s1", ex)).toEqual({ kind: "denied", error: "access_denied", description: undefined });
  });
  it("refuses a wrong or missing state, even on a denial", () => {
    expect(parseRedirect("GET", "/callback?code=abc&state=nope", ex).kind).toBe("invalid");
    expect(parseRedirect("GET", "/callback?code=abc", ex).kind).toBe("invalid");
    expect(parseRedirect("GET", "/callback?error=access_denied&state=x", ex).kind).toBe("invalid");
  });
  it("refuses a missing code", () => {
    expect(parseRedirect("GET", "/callback?state=s1", ex)).toEqual({ kind: "invalid", reason: "The sign-in response had no code." });
  });
  it("ignores other requests", () => {
    expect(parseRedirect("GET", "/favicon.ico", ex).kind).toBe("ignore");
    expect(parseRedirect("POST", "/callback?code=a&state=s1", ex).kind).toBe("ignore");
    expect(parseRedirectHead("garbage", ex).kind).toBe("ignore");
  });
  it("takes the first of repeated parameters", () => {
    expect(parseRedirect("GET", "/callback?code=one&code=two&state=s1", ex)).toEqual({ kind: "code", code: "one" });
  });
  it("checks iss (RFC 9207)", () => {
    expect(parseRedirect("GET", "/callback?code=a&state=s1&iss=https%3A%2F%2Fgw.example.com%2F", ex).kind).toBe("code");
    expect(parseRedirect("GET", "/callback?code=a&state=s1&iss=https%3A%2F%2Fevil.example.com", ex)).toEqual({
      kind: "invalid",
      reason: "The sign-in response came from a different server.",
    });
    expect(parseRedirect("GET", "/callback?code=a&state=s1", { ...ex, issRequired: true }).kind).toBe("invalid");
    expect(parseRedirect("GET", "/callback?code=a&state=s1", ex).kind).toBe("code");
  });
  it("reads a raw head", () => {
    expect(parseRedirectHead("GET /callback?code=c&state=s1 HTTP/1.1\r\nHost: x\r\n\r\n", ex)).toEqual({ kind: "code", code: "c" });
  });
});

describe("URLs", () => {
  it("normalizes origins and issuers", () => {
    expect(normalized("HTTPS://Talk.Example.com:443/")).toBe("https://talk.example.com");
    expect(normalized("http://localhost:80")).toBe("http://localhost");
    expect(normalized("https://gw.example.com/tenant/")).toBe("https://gw.example.com/tenant");
  });
  it("puts the well-known segment before the issuer's path (RFC 8414)", () => {
    expect(authorizationServerMetadataUrl("https://gw.example.com")).toBe("https://gw.example.com/.well-known/oauth-authorization-server");
    expect(authorizationServerMetadataUrl("https://gw.example.com/t/x/")).toBe("https://gw.example.com/.well-known/oauth-authorization-server/t/x");
  });
  it("reads what a person types", () => {
    expect(typedAppUrl(" talk.example.com/meetings ")).toBe("https://talk.example.com");
    expect(typedAppUrl("http://talk.localhost:8787")).toBe("http://talk.localhost:8787");
    expect(typedAppUrl("http://talk.example.com")).toBeUndefined();
    expect(typedAppUrl("ftp://x")).toBeUndefined();
    expect(typedAppUrl("")).toBeUndefined();
    expect(originOf("https://a.example.com/x?y")).toBe("https://a.example.com");
  });
  it("builds an authorization URL with PKCE, state and resource but no scope", () => {
    const pkce = createPkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    const url = new URL(
      OAuthClient.authorizationUrl({
        metadata: { issuer: "https://gw", authorizationEndpoint: "https://gw.example.com/authorize?x=1", tokenEndpoint: "https://gw/token" },
        clientId: "c+1",
        redirectUri: "http://127.0.0.1:5000/callback",
        pkce,
        state: "st",
        resource: "https://talk.example.com",
      }),
    );
    const q = url.searchParams;
    expect(q.get("x")).toBe("1");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("c+1");
    expect(url.search).toContain("client_id=c%2B1");
    expect(q.get("code_challenge")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toBe("st");
    expect(q.get("resource")).toBe("https://talk.example.com");
    expect(q.has("scope")).toBe(false);
  });
  it("form-encodes per RFC 6749 appendix B", () => {
    expect(formEncode([["a b", "c+d/e*"]])).toBe("a%20b=c%2Bd%2Fe%2A");
  });
});
