import { describe, it, expect } from "vitest";
import {
  hasBearerCredential,
  hasEveryAppBearer,
  isGatewayOauthToken,
  stripInboundHeaders,
  withSecurityHeaders,
  IDENTITY_HEADER,
} from "./headers";

describe("stripInboundHeaders", () => {
  it("removes Cookie, Authorization and all x-everyapp-* headers", () => {
    const inbound = new Headers({
      cookie: "session=abc",
      authorization: "Bearer leak",
      [IDENTITY_HEADER]: "spoofed.jwt.here",
      "x-everyapp-public": "1",
      "x-everyapp-anything": "evil",
      "content-type": "application/json",
      accept: "text/html",
    });
    const out = stripInboundHeaders(inbound);
    expect(out.get("cookie")).toBeNull();
    expect(out.get("authorization")).toBeNull();
    expect(out.get(IDENTITY_HEADER)).toBeNull();
    expect(out.get("x-everyapp-public")).toBeNull();
    expect(out.get("x-everyapp-anything")).toBeNull();
    // non-trust headers preserved
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("accept")).toBe("text/html");
  });

  it("removes Cloudflare Access's assertion, email and service-token headers", () => {
    const out = stripInboundHeaders(
      new Headers({
        "Cf-Access-Jwt-Assertion": "header.payload.signature",
        "Cf-Access-Authenticated-User-Email": "ceo@example.com",
        "CF-Access-Client-Id": "id.access",
        "CF-Access-Client-Secret": "cfast_secret",
        cookie: "CF_Authorization=header.payload.signature",
        "cf-connecting-ip": "203.0.113.7",
      }),
    );
    expect([...out.keys()]).toEqual(["cf-connecting-ip"]);
  });

  it("removes the Worker version-override header", () => {
    const out = stripInboundHeaders(
      new Headers({
        "Cloudflare-Workers-Version-Overrides": 'every-todo="old-version"',
      }),
    );
    expect(out.get("cloudflare-workers-version-overrides")).toBeNull();
  });

  it("does not mutate the original headers", () => {
    const inbound = new Headers({ cookie: "x=1" });
    stripInboundHeaders(inbound);
    expect(inbound.get("cookie")).toBe("x=1");
  });
});

describe("hasEveryAppBearer", () => {
  const withAuthorization = (value: string) =>
    new Headers({ authorization: value });

  it("detects reserved bearers regardless of scheme case", () => {
    expect(hasEveryAppBearer(withAuthorization("Bearer epat_abc"))).toBe(true);
    expect(hasEveryAppBearer(withAuthorization("bearer epat_abc"))).toBe(true);
  });

  it("detects every whitespace separator the authenticator's parser accepts", () => {
    expect(hasEveryAppBearer(withAuthorization("Bearer\tepat_abc"))).toBe(true);
    expect(hasEveryAppBearer(withAuthorization("Bearer  epat_abc"))).toBe(true);
  });

  it("ignores non-reserved credentials", () => {
    expect(hasEveryAppBearer(withAuthorization("Bearer some-app-token"))).toBe(
      false,
    );
    expect(hasEveryAppBearer(withAuthorization("Basic epat_abc"))).toBe(false);
    expect(hasEveryAppBearer(withAuthorization("epat_abc"))).toBe(false);
    expect(hasEveryAppBearer(new Headers())).toBe(false);
  });

  it("treats the epat_ prefix as case-sensitive, matching the authenticator", () => {
    expect(hasEveryAppBearer(withAuthorization("Bearer EPAT_abc"))).toBe(false);
    expect(hasEveryAppBearer(withAuthorization("Bearer Epat_abc"))).toBe(false);
  });

  it("reserves the gateway OAuth server's tokens", () => {
    const grantId = "AbCdEfGhIjKlMn_-";
    const secret = "0123456789abcdefghijklmnopqrstuv";
    for (const token of [
      `user-1:${grantId}:${secret}`,
      // A user id may itself hold ":".
      `org:user:${grantId}:${secret}`,
    ]) {
      expect(isGatewayOauthToken(token), token).toBe(true);
      expect(hasEveryAppBearer(withAuthorization(`Bearer ${token}`))).toBe(
        true,
      );
    }
    for (const token of [
      `${grantId}:${secret}`,
      `:${grantId}:${secret}`,
      `user-1:${grantId}x:${secret}`,
      `user-1:${grantId}:${secret}x`,
      `user-1:${grantId}:${secret.slice(1)}=`,
      "eyJhbGciOiJIUzI1NiJ9.e30.sig",
    ]) {
      expect(isGatewayOauthToken(token), token).toBe(false);
    }
  });
});

describe("hasBearerCredential", () => {
  const withAuthorization = (value: string) =>
    new Headers({ authorization: value });

  it("detects any syntactically valid bearer credential", () => {
    expect(hasBearerCredential(withAuthorization("Bearer epat_abc"))).toBe(
      true,
    );
    expect(hasBearerCredential(withAuthorization("Bearer oauth-token"))).toBe(
      true,
    );
    expect(hasBearerCredential(withAuthorization("bearer token"))).toBe(true);
  });

  it("ignores non-bearer or empty credentials", () => {
    expect(hasBearerCredential(withAuthorization("Basic token"))).toBe(false);
    expect(hasBearerCredential(withAuthorization("Bearer "))).toBe(false);
    expect(hasBearerCredential(new Headers())).toBe(false);
  });
});

describe("withSecurityHeaders", () => {
  it("stamps HSTS, nosniff, frame denial on HTML responses", () => {
    const res = withSecurityHeaders(
      new Response("<html></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("does not add an HTML CSP to JSON responses", () => {
    const res = withSecurityHeaders(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps an app's own tighter CSP directives, adding the floor", () => {
    const res = withSecurityHeaders(
      new Response("<html></html>", {
        headers: {
          "content-type": "text/html",
          "content-security-policy": "default-src 'none'",
        },
      }),
    );
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it("overrides an app CSP that tries to weaken the floor", () => {
    const res = withSecurityHeaders(
      new Response("<html></html>", {
        headers: {
          "content-type": "text/html",
          "content-security-policy":
            "default-src 'self'; frame-ancestors *; object-src *",
        },
      }),
    );
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("frame-ancestors *");
  });

  it("lets an app frame its own pages or keep a stricter base-uri", () => {
    const res = withSecurityHeaders(
      new Response("<html></html>", {
        headers: {
          "content-type": "text/html",
          "content-security-policy":
            "default-src 'none'; frame-ancestors 'self'; base-uri 'none'",
        },
      }),
    );
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("preserves status and body", async () => {
    const res = withSecurityHeaders(
      new Response("hello", {
        status: 201,
        headers: { "content-type": "text/html" },
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hello");
  });

  it("makes multiple app cookies host-only without changing other attributes", () => {
    const headers = new Headers({ "content-type": "text/plain" });
    headers.append(
      "set-cookie",
      "session=app; Domain=example.com; Path=/; HttpOnly; Secure",
    );
    headers.append(
      "set-cookie",
      "theme=dark; domain=.example.com; SameSite=Lax",
    );
    headers.append("set-cookie", "host=only; Path=/app");

    const res = withSecurityHeaders(new Response("ok", { headers }));

    expect(res.headers.getSetCookie()).toEqual([
      "session=app; Path=/; HttpOnly; Secure",
      "theme=dark; SameSite=Lax",
      "host=only; Path=/app",
    ]);
  });
});

describe("withSecurityHeaders options (control plane)", () => {
  it("can send HSTS for the host alone", () => {
    const res = withSecurityHeaders(new Response("ok"), {
      hsts: "max-age=63072000",
    });
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=63072000",
    );
  });

  it("keeps cookie domains, sets the referrer policy and no-store", () => {
    const headers = new Headers({ "content-type": "text/html" });
    headers.append("set-cookie", "session=abc; Domain=example.com; Path=/");
    const res = withSecurityHeaders(
      new Response("<html></html>", { headers }),
      {
        referrerPolicy: "no-referrer",
        stripCookieDomains: false,
        noStore: true,
      },
    );
    expect(res.headers.getSetCookie()).toEqual([
      "session=abc; Domain=example.com; Path=/",
    ]);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
});
