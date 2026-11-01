import { describe, expect, it } from "vitest";
import { onPlatformDomain } from "./own-domain";

const ISSUER = "https://app.everyapp.com";

describe("onPlatformDomain", () => {
  it("covers the gateway's host and every host under it", () => {
    for (const value of [
      "https://app.everyapp.com/client.json",
      "https://APP.everyapp.com./cb",
      "https://todo.app.everyapp.com/.well-known/client",
      "https://a.b.app.everyapp.com:8443/cb",
      "http://app.everyapp.com/cb",
    ]) {
      expect(onPlatformDomain(value, ISSUER, {}), value).toBe(true);
    }
  });

  it("covers APP_BASE_DOMAIN and its subdomains when apps live apart from the gateway", () => {
    const env = { APP_BASE_DOMAIN: "Apps.Example.net." };
    for (const value of [
      "https://apps.example.net/cb",
      "https://todo.apps.example.net/client.json",
      "https://todo-acme.apps.example.net/cb",
    ]) {
      expect(onPlatformDomain(value, ISSUER, env), value).toBe(true);
    }
    // Still the gateway's own host, too.
    expect(onPlatformDomain("https://app.everyapp.com/x", ISSUER, env)).toBe(
      true,
    );
  });

  it("leaves other hosts alone, including look-alikes and parents", () => {
    const env = { APP_BASE_DOMAIN: "apps.example.net" };
    for (const value of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://everyapp.com/cb",
      "https://evilapp.everyapp.com/cb",
      "https://app.everyapp.com.evil.test/cb",
      "https://example.net/cb",
      "https://xapps.example.net/cb",
      "http://127.0.0.1:33418/callback",
      "not a url",
      "",
    ]) {
      expect(onPlatformDomain(value, ISSUER, env), value).toBe(false);
    }
  });

  it("ignores an APP_BASE_DOMAIN that isn't a DNS name", () => {
    expect(
      onPlatformDomain("https://com/cb", ISSUER, { APP_BASE_DOMAIN: "*.com" }),
    ).toBe(false);
  });

  it("exempts a loopback gateway, but not an APP_BASE_DOMAIN set beside it", () => {
    expect(
      onPlatformDomain("http://localhost:3000/cb", "http://localhost:3000", {}),
    ).toBe(false);
    expect(
      onPlatformDomain("http://127.0.0.1:5173/cb", "http://127.0.0.1:5173", {}),
    ).toBe(false);
    expect(
      onPlatformDomain(
        "https://todo.apps.example.net/cb",
        "http://localhost:3000",
        { APP_BASE_DOMAIN: "apps.example.net" },
      ),
    ).toBe(true);
  });
});
