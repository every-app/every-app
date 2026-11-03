/**
 * The pure rules of the outer ring: manifest globs as Access path patterns,
 * the destinations the registry calls for, how a found application is read,
 * and the policy's one rule.
 */
import { describe, expect, it } from "vitest";
import type { AccessApplication } from "@/lib/cf/access";
import {
  accessPathPattern,
  allowedSignInProviders,
  appDestination,
  appsDestinations,
  describeSignInMethods,
  externalEvaluationRule,
  findAccessApplications,
  gatewayDestination,
  isOwnedUri,
  PROTECTED_RESOURCE_METADATA_PATH,
  missingSignInProviders,
  sameDestinations,
  sameRules,
  splitDestinations,
} from "./plan";

const SCOPE = { gatewayHost: "apps.acme.com", appBaseDomain: "apps.acme.com" };

const application = (
  id: string,
  destinations: Array<{ uri: string; overrides?: string[] }>,
  extra: Partial<AccessApplication> = {},
): AccessApplication => ({
  id,
  aud: `aud-${id}`,
  type: "self_hosted",
  destinations: destinations.map((d) => ({
    type: "public",
    uri: d.uri,
    overrides: (d.overrides ?? []).map((path_pattern) => ({ path_pattern, behavior: "public" })),
  })),
  ...extra,
});

describe("accessPathPattern", () => {
  it("keeps exact paths and the single-segment wildcard", () => {
    expect(accessPathPattern("/health")).toBe("/health");
    expect(accessPathPattern("/t/*")).toBe("/t/*");
    expect(accessPathPattern("/foo*/bar")).toBe("/foo*/bar");
  });

  it("collapses ** to * (Access's * already spans segments)", () => {
    expect(accessPathPattern("/uploads/**")).toBe("/uploads/*");
    expect(accessPathPattern("/a/**/b")).toBe("/a/*/b");
  });

  it("turns a :param segment into *, but leaves a colon inside a segment alone", () => {
    expect(accessPathPattern("/:locale/share/**")).toBe("/*/share/*");
    expect(accessPathPattern("/files/:id")).toBe("/files/*");
    expect(accessPathPattern("/time/12:30")).toBe("/time/12:30");
  });

  it("gives up on a segment Access can't express: two wildcards in it, or no leading slash", () => {
    expect(accessPathPattern("/a*b*c")).toBeNull();
    expect(accessPathPattern("/x/*y*")).toBeNull();
    expect(accessPathPattern("health")).toBeNull();
    expect(accessPathPattern(`/${"a".repeat(600)}`)).toBeNull();
  });
});

describe("appDestination", () => {
  it("is the routes once each, methods ignored", () => {
    const { destination, dropped } = appDestination(
      { appId: "crm", hostname: "CRM.apps.acme.com", publicPaths: ["/t/*", "/t/e", "/health", "/health"], bearerPaths: [] }
    );
    expect(destination.uri).toBe("crm.apps.acme.com");
    expect(destination.overrides.map((o) => o.path_pattern)).toEqual(["/t/*", "/t/e", "/health"]);
    expect(dropped).toEqual([]);
  });

  it("drops what Access can't take, saying why: inexpressible first, then the 26th", () => {
    const many = Array.from({ length: 30 }, (_, i) => `/r${i}`);
    const { destination, dropped } = appDestination(
      { appId: "big", hostname: "big.apps.acme.com", publicPaths: ["/a*b*", ...many], bearerPaths: [] }
    );
    expect(destination.overrides).toHaveLength(25);
    expect(dropped).toEqual([
      { appId: "big", path: "/a*b*", reason: "not_expressible" },
      ...many.slice(25).map((path) => ({ appId: "big", path, reason: "too_many" })),
    ]);
  });
});

describe("bearer routes", () => {
  const zen = { appId: "openzen", hostname: "openzen.apps.acme.com", publicPaths: ["/hooks/*"], bearerPaths: ["/api/**", "/v1/:id"] };

  it("become path bypasses with the discovery document, before the public routes", () => {
    expect(appDestination(zen).destination.overrides.map((o) => o.path_pattern)).toEqual([
      PROTECTED_RESOURCE_METADATA_PATH,
      "/api/*",
      "/v1/*",
      "/hooks/*",
    ]);
  });

  it("give an app with nothing else a destination of its own", () => {
    const plan = appsDestinations("apps.acme.com", [{ ...zen, publicPaths: [] }]);
    expect(plan.destinations.map((d) => [d.uri, d.overrides.map((o) => o.path_pattern)])).toEqual([
      ["*.apps.acme.com", []],
      ["openzen.apps.acme.com", [PROTECTED_RESOURCE_METADATA_PATH, "/api/*", "/v1/*"]],
    ]);
  });

  it("are dropped like public routes, marked as bearer", () => {
    const { dropped } = appDestination(
      { ...zen, bearerPaths: ["/a*b*"], publicPaths: [] }
    );
    expect(dropped).toEqual([{ appId: "openzen", path: "/a*b*", reason: "not_expressible", bearer: true }]);
  });
});

describe("appsDestinations", () => {
  it("is the wildcard with nothing let through, then one destination per app with public routes under the base, by host", () => {
    const plan = appsDestinations("apps.acme.com", [
      { appId: "todo", hostname: "todo.apps.acme.com", publicPaths: [], bearerPaths: [] },
      { appId: "crm", hostname: "crm.apps.acme.com", publicPaths: ["/t/*"], bearerPaths: [] },
      { appId: "analytics", hostname: "analytics.apps.acme.com", publicPaths: ["/collect"], bearerPaths: [] },
      { appId: "far", hostname: "far.elsewhere.com", publicPaths: ["/x"], bearerPaths: [] },
      { appId: "deep", hostname: "a.b.apps.acme.com", publicPaths: ["/x"], bearerPaths: [] },
    ]);
    expect(plan.destinations.map((d) => [d.uri, d.overrides.map((o) => o.path_pattern)])).toEqual([
      ["*.apps.acme.com", []],
      ["analytics.apps.acme.com", ["/collect"]],
      ["crm.apps.acme.com", ["/t/*"]],
    ]);
    expect(plan.outsideBase).toEqual(["deep", "far"]);
    expect(plan.dropped).toEqual([]);
  });
});

describe("gatewayDestination", () => {
  it("lets the machine endpoints, /health, Apple's sign-in POST and Access's membership question through", () => {
    expect(gatewayDestination("Apps.Acme.com").overrides.map((o) => o.path_pattern)).toEqual([
      "/mcp",
      "/mcp/*",
      "/oauth/token",
      "/oauth/register",
      "/linked-dev/*",
      "/.well-known/*",
      "/health",
      "/api/auth/callback/apple",
      "/access-evaluation/*",
    ]);
    expect(gatewayDestination("Apps.Acme.com").uri).toBe("apps.acme.com");
  });

  it("bypasses only Apple's callback among the sign-in providers: the others return with a GET Access checks", () => {
    const patterns = gatewayDestination("apps.acme.com").overrides.map((o) => o.path_pattern);
    expect(patterns.filter((pattern) => pattern.startsWith("/api/"))).toEqual(["/api/auth/callback/apple"]);
    expect(patterns.some((pattern) => pattern.includes("*") && pattern.startsWith("/api"))).toBe(false);
  });
});

describe("sameDestinations", () => {
  it("ignores case, trailing slashes, a missing type, and order", () => {
    expect(
      sameDestinations(
        [
          { uri: "Crm.apps.acme.com/", overrides: [{ path_pattern: "/mcp/*", behavior: "public" }, { path_pattern: "/mcp", behavior: "public" }] },
          { type: "public", uri: "*.apps.acme.com", overrides: null },
        ],
        [
          { type: "public", uri: "*.apps.acme.com", overrides: [] },
          { type: "public", uri: "crm.apps.acme.com", overrides: [{ path_pattern: "/mcp", behavior: "public" }, { path_pattern: "/mcp/*", behavior: "public" }] },
        ],
      ),
    ).toBe(true);
  });

  it("sees a path added or removed", () => {
    expect(
      sameDestinations(
        [{ type: "public", uri: "crm.apps.acme.com", overrides: [{ path_pattern: "/mcp", behavior: "public" }] }],
        [{ type: "public", uri: "crm.apps.acme.com", overrides: [{ path_pattern: "/mcp", behavior: "public" }, { path_pattern: "/t/*", behavior: "public" }] }],
      ),
    ).toBe(false);
  });
});

describe("finding the applications", () => {
  it("picks the Gateway's host and the apps' wildcard by destination, not by name, self-hosted only", () => {
    const gateway = application("g", [{ uri: "apps.acme.com" }], { name: "whatever" });
    const apps = application("a", [{ uri: "*.apps.acme.com" }]);
    const saas = { ...application("s", [{ uri: "apps.acme.com" }]), type: "saas" };
    const other = application("o", [{ uri: "wiki.acme.com" }]);
    expect(findAccessApplications([saas, other, apps, gateway], SCOPE)).toEqual({ gateway, apps });
    expect(findAccessApplications([other], SCOPE)).toEqual({ gateway: null, apps: null });
  });

  it("never takes another Gateway's own application, whatever stray destination it holds", () => {
    // A named Gateway's apps application that once got a per-app destination equal to this Gateway's host.
    const demoApps = application("d", [{ uri: "*.demo.acme.com" }, { uri: "apps.acme.com" }], {
      name: "Every App apps (demo)",
      domain: "*.demo.acme.com",
    });
    const gateway = application("g", [{ uri: "apps.acme.com" }], { name: "Every App gateway", domain: "apps.acme.com" });
    expect(findAccessApplications([demoApps, gateway], SCOPE)).toEqual({ gateway, apps: null });
    // And the default's never counts as a named Gateway's.
    const defaultApps = application("a", [{ uri: "*.apps.acme.com" }, { uri: "demo.acme.com" }], {
      name: "Every App apps",
      domain: "*.apps.acme.com",
    });
    expect(
      findAccessApplications([defaultApps], { gatewayHost: "demo.acme.com", appBaseDomain: "demo.acme.com" }),
    ).toEqual({ gateway: null, apps: null });
  });

  it("returns one application covering both as both", () => {
    const both = application("b", [{ uri: "apps.acme.com" }, { uri: "*.apps.acme.com" }]);
    expect(findAccessApplications([both], SCOPE)).toEqual({ gateway: both, apps: both });
  });

  it("owns the Gateway host, the wildcard and hosts one label below the base, nothing else", () => {
    expect(isOwnedUri("apps.acme.com", SCOPE)).toBe(true);
    expect(isOwnedUri("*.apps.acme.com", SCOPE)).toBe(true);
    expect(isOwnedUri("crm.apps.acme.com", SCOPE)).toBe(true);
    expect(isOwnedUri("wiki.acme.com", SCOPE)).toBe(false);
    expect(isOwnedUri("a.b.apps.acme.com", SCOPE)).toBe(false);
    expect(isOwnedUri("apps.acme.com/admin", SCOPE)).toBe(false);
    expect(isOwnedUri(null, SCOPE)).toBe(false);
    const split = splitDestinations(
      [{ uri: "wiki.acme.com" }, { uri: "*.apps.acme.com" }, { uri: "crm.apps.acme.com" }],
      SCOPE,
    );
    expect(split.owned.map((d) => d.uri)).toEqual(["*.apps.acme.com", "crm.apps.acme.com"]);
    expect(split.foreign.map((d) => d.uri)).toEqual(["wiki.acme.com"]);
  });
});

describe("the policy", () => {
  it("is one External Evaluation rule asking the Gateway, on its own host", () => {
    expect(externalEvaluationRule("Team.Acme.com")).toEqual({
      external_evaluation: {
        evaluate_url: "https://team.acme.com/access-evaluation/evaluate",
        keys_url: "https://team.acme.com/access-evaluation/keys",
      },
    });
  });

  it("compares include lists whatever the order and case, and sees an email rule left over", () => {
    const rule = externalEvaluationRule("team.acme.com");
    expect(sameRules([rule], [externalEvaluationRule("TEAM.acme.com")])).toBe(true);
    expect(sameRules([rule, { email: { email: "ben@acme.com" } }], [rule])).toBe(false);
    expect(sameRules([], [rule])).toBe(false);
  });
});

describe("identity providers", () => {
  it("says which of the two sign-in methods a team lacks", () => {
    expect(missingSignInProviders([])).toEqual({ cloudflare: true, pin: true });
    expect(missingSignInProviders([{ id: "c", type: "cloudflare" }])).toEqual({ cloudflare: false, pin: true });
    expect(
      missingSignInProviders([
        { id: "c", type: "cloudflare" },
        { id: "p", type: "onetimepin" },
        { id: "g", type: "google-apps" },
      ]),
    ).toEqual({ cloudflare: false, pin: false });
  });

  it("describes the methods as a person reads them: Cloudflare first, the PIN last, others by name", () => {
    expect(describeSignInMethods([{ id: "p", type: "onetimepin", name: "One-time PIN" }])).toBe("a one-time PIN");
    expect(
      describeSignInMethods([
        { id: "p", type: "onetimepin" },
        { id: "c", type: "cloudflare", name: "Cloudflare" },
      ]),
    ).toBe("a Cloudflare account or a one-time PIN");
    expect(
      describeSignInMethods([
        { id: "p", type: "onetimepin" },
        { id: "g", type: "okta", name: "Okta" },
        { id: "c", type: "cloudflare" },
      ]),
    ).toBe("a Cloudflare account, Okta or a one-time PIN");
    expect(describeSignInMethods([])).toBe("no sign-in method");
  });

  it("allows only the PIN and a Cloudflare provider restricted to the account's members; the team's others are the operator's", () => {
    const restricted = { id: "c", type: "cloudflare", config: { restrict_to_account_members: true } };
    const open = { id: "o", type: "cloudflare", config: { restrict_to_account_members: false } };
    const pin = { id: "p", type: "onetimepin" };
    const okta = { id: "k", type: "okta", name: "Okta" };
    const oidc = { id: "g", type: "oidc", name: "Generic" };
    expect(allowedSignInProviders([okta, open, pin, oidc, restricted])).toEqual([pin, restricted]);
    expect(allowedSignInProviders([open, okta])).toEqual([]);
  });
});
