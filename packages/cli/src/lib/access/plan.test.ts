/**
 * The pure rules of the outer ring: manifest globs as Access path patterns,
 * the destinations the registry calls for, how a found application is read,
 * and how the policy's rules merge.
 */
import { describe, expect, it } from "vitest";
import type { AccessApplication } from "@/lib/cf/access";
import {
  accessDrift,
  accessPathPattern,
  allowedIdpsFor,
  allowedSignInProviders,
  appDestination,
  appsDestinations,
  describeSignInMethods,
  desiredSignIn,
  durationSeconds,
  emailDomainRule,
  emailRule,
  findAccessApplications,
  gatewayDestination,
  isOwnedUri,
  PROTECTED_RESOURCE_METADATA_PATH,
  mergeRules,
  missingSignInProviders,
  ruleDomains,
  ruleEmails,
  sameDestinations,
  signInInSync,
  splitDestinations,
  unrestrictedCloudflareProviders,
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
  it("is the routes once each, methods ignored, and no MCP path unless the manifest sets mcp", () => {
    const { destination, dropped } = appDestination(
      { appId: "crm", hostname: "CRM.apps.acme.com", publicPaths: ["/t/*", "/t/e", "/health", "/health"], bearerPaths: [], mcp: false },
      { managedOAuth: false },
    );
    expect(destination.uri).toBe("crm.apps.acme.com");
    expect(destination.overrides.map((o) => o.path_pattern)).toEqual(["/t/*", "/t/e", "/health"]);
    expect(dropped).toEqual([]);
  });

  it("starts with the MCP paths where the manifest sets mcp, and leaves them out under Managed OAuth", () => {
    const app = { appId: "crm", hostname: "crm.apps.acme.com", publicPaths: ["/health"], bearerPaths: [], mcp: true };
    expect(appDestination(app, { managedOAuth: false }).destination.overrides.map((o) => o.path_pattern)).toEqual([
      "/mcp",
      "/mcp/*",
      "/health",
    ]);
    expect(appDestination(app, { managedOAuth: true }).destination.overrides.map((o) => o.path_pattern)).toEqual([
      "/health",
    ]);
  });

  it("drops what Access can't take, saying why: inexpressible first, then the 26th", () => {
    const many = Array.from({ length: 30 }, (_, i) => `/r${i}`);
    const { destination, dropped } = appDestination(
      { appId: "big", hostname: "big.apps.acme.com", publicPaths: ["/a*b*", ...many], bearerPaths: [], mcp: true },
      { managedOAuth: false },
    );
    expect(destination.overrides).toHaveLength(25);
    expect(dropped).toEqual([
      { appId: "big", path: "/a*b*", reason: "not_expressible" },
      ...many.slice(23).map((path) => ({ appId: "big", path, reason: "too_many" })),
    ]);
  });
});

describe("bearer routes", () => {
  const zen = { appId: "openzen", hostname: "openzen.apps.acme.com", publicPaths: ["/hooks/*"], bearerPaths: ["/api/**", "/v1/:id"], mcp: true };

  it("become path bypasses after the MCP paths, with the discovery document, before the public routes", () => {
    expect(appDestination(zen, { managedOAuth: false }).destination.overrides.map((o) => o.path_pattern)).toEqual([
      "/mcp",
      "/mcp/*",
      PROTECTED_RESOURCE_METADATA_PATH,
      "/api/*",
      "/v1/*",
      "/hooks/*",
    ]);
  });

  it("stay bypassed under Managed OAuth, and give an app with nothing else a destination of its own", () => {
    const plan = appsDestinations(
      "apps.acme.com",
      [{ ...zen, publicPaths: [], mcp: false }],
      { managedOAuth: true },
    );
    expect(plan.destinations.map((d) => [d.uri, d.overrides.map((o) => o.path_pattern)])).toEqual([
      ["*.apps.acme.com", []],
      ["openzen.apps.acme.com", [PROTECTED_RESOURCE_METADATA_PATH, "/api/*", "/v1/*"]],
    ]);
  });

  it("are dropped like public routes, marked as bearer", () => {
    const { dropped } = appDestination(
      { ...zen, bearerPaths: ["/a*b*"], publicPaths: [] },
      { managedOAuth: false },
    );
    expect(dropped).toEqual([{ appId: "openzen", path: "/a*b*", reason: "not_expressible", bearer: true }]);
  });

  it("show as path drift on the apps' application until it lets them through", () => {
    const scope = { gatewayHost: "team.acme.com", appBaseDomain: "apps.acme.com" };
    const signIn = { allowed_idps: ["pin"], auto_redirect_to_identity: true };
    const gateway = application(
      "g",
      [{ uri: "team.acme.com", overrides: gatewayDestination("team.acme.com", false).overrides.map((o) => o.path_pattern) }],
      signIn,
    );
    const surfaces = [{ ...zen, publicPaths: [], mcp: false }];
    const appsWith = (overrides: string[]) =>
      application("a", [{ uri: "*.apps.acme.com" }, { uri: "openzen.apps.acme.com", overrides }], signIn);
    const drift = (apps: AccessApplication) =>
      accessDrift({ scope, found: { gateway, apps }, surfaces, providerIds: ["pin"] });
    expect(drift(appsWith([])).paths).toEqual(["*.apps.acme.com"]);
    expect(drift(appsWith([PROTECTED_RESOURCE_METADATA_PATH, "/api/*"])).paths).toEqual(["*.apps.acme.com"]);
    expect(drift(appsWith([PROTECTED_RESOURCE_METADATA_PATH, "/api/*", "/v1/*"]))).toEqual({
      paths: [],
      signIn: [],
      missing: [],
    });
  });
});

describe("appsDestinations", () => {
  it("is the wildcard with nothing let through, then one destination per app with public routes or mcp under the base, by host", () => {
    const plan = appsDestinations("apps.acme.com", [
      { appId: "todo", hostname: "todo.apps.acme.com", publicPaths: [], bearerPaths: [], mcp: false },
      { appId: "crm", hostname: "crm.apps.acme.com", publicPaths: ["/t/*"], bearerPaths: [], mcp: false },
      { appId: "analytics", hostname: "analytics.apps.acme.com", publicPaths: ["/collect"], bearerPaths: [], mcp: true },
      { appId: "inbox", hostname: "inbox.apps.acme.com", publicPaths: [], bearerPaths: [], mcp: true },
      { appId: "far", hostname: "far.elsewhere.com", publicPaths: ["/x"], bearerPaths: [], mcp: false },
      { appId: "deep", hostname: "a.b.apps.acme.com", publicPaths: ["/x"], bearerPaths: [], mcp: false },
    ]);
    expect(plan.destinations.map((d) => [d.uri, d.overrides.map((o) => o.path_pattern)])).toEqual([
      ["*.apps.acme.com", []],
      ["analytics.apps.acme.com", ["/mcp", "/mcp/*", "/collect"]],
      ["crm.apps.acme.com", ["/t/*"]],
      ["inbox.apps.acme.com", ["/mcp", "/mcp/*"]],
    ]);
    expect(plan.outsideBase).toEqual(["deep", "far"]);
    expect(plan.dropped).toEqual([]);
  });

  it("bypasses no MCP path under Managed OAuth, keeps the public routes, and makes no destination that lets nothing through", () => {
    const plan = appsDestinations(
      "apps.acme.com",
      [
        { appId: "inbox", hostname: "inbox.apps.acme.com", publicPaths: ["/hooks/*"], bearerPaths: [], mcp: true },
        // mcp alone: nothing would be let through on its host, so no destination.
        { appId: "openseo", hostname: "openseo.apps.acme.com", publicPaths: [], bearerPaths: [], mcp: true },
      ],
      { managedOAuth: true },
    );
    expect(plan.destinations.map((d) => [d.uri, d.overrides.map((o) => o.path_pattern)])).toEqual([
      ["*.apps.acme.com", []],
      ["inbox.apps.acme.com", ["/hooks/*"]],
    ]);
  });
});

describe("gatewayDestination", () => {
  it("lets the machine endpoints, /health and Apple's sign-in POST through, or the last two alone under Managed OAuth", () => {
    expect(gatewayDestination("Apps.Acme.com", false).overrides.map((o) => o.path_pattern)).toEqual([
      "/mcp",
      "/mcp/*",
      "/oauth/token",
      "/oauth/register",
      "/linked-dev/*",
      "/.well-known/*",
      "/health",
      "/api/auth/callback/apple",
    ]);
    expect(gatewayDestination("apps.acme.com", true)).toEqual({
      type: "public",
      uri: "apps.acme.com",
      overrides: [
        { path_pattern: "/health", behavior: "public" },
        { path_pattern: "/api/auth/callback/apple", behavior: "public" },
      ],
    });
  });

  it("bypasses only Apple's callback among the sign-in providers: the others return with a GET Access checks", () => {
    const patterns = gatewayDestination("apps.acme.com", false).overrides.map((o) => o.path_pattern);
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

describe("policy rules", () => {
  it("adds what is missing, once, whatever the case, and never removes", () => {
    const existing = [emailRule("Ben@Acme.com"), { group: { id: "g1" } }];
    const { include, added } = mergeRules(existing, [
      emailRule("ben@acme.com"),
      emailRule("jo@acme.com"),
      emailRule("JO@acme.com"),
      emailDomainRule("acme.com"),
    ]);
    expect(added).toEqual([emailRule("jo@acme.com"), emailDomainRule("acme.com")]);
    expect(include).toEqual([...existing, ...added]);
    expect(ruleEmails(include)).toEqual(["ben@acme.com", "jo@acme.com"]);
    expect(ruleDomains(include)).toEqual(["acme.com"]);
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

  it("names a Cloudflare provider open to any Cloudflare user", () => {
    const restricted = { id: "c", type: "cloudflare", config: { restrict_to_account_members: true } };
    const open = { id: "o", type: "cloudflare", name: "Any Cloudflare user", config: {} };
    const unset = { id: "u", type: "cloudflare" };
    expect(unrestrictedCloudflareProviders([restricted, open, unset, { id: "p", type: "onetimepin" }])).toEqual([
      open,
      unset,
    ]);
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

  it("adds the providers `on` vouches for to an application's allowed list and keeps what was there", () => {
    expect(allowedIdpsFor(null, ["c", "p"])).toEqual(["c", "p"]);
    expect(allowedIdpsFor(["p"], ["c", "p"])).toEqual(["p", "c"]);
    expect(allowedIdpsFor(["x", "p", "c"], ["c", "p"])).toEqual(["x", "p", "c"]);
  });

  it("redirects past Access's chooser only with one provider, and sees an application that lacks one", () => {
    expect(desiredSignIn(null, ["p"])).toEqual({ allowedIdps: ["p"], autoRedirect: true });
    expect(desiredSignIn({ allowed_idps: ["p"] }, ["c", "p"])).toEqual({ allowedIdps: ["p", "c"], autoRedirect: false });
    // As `access on` left applications before Sign in with Cloudflare: the PIN alone, redirected to.
    expect(signInInSync({ allowed_idps: ["p"], auto_redirect_to_identity: true }, ["c", "p"])).toBe(false);
    expect(signInInSync({ allowed_idps: ["c", "p"], auto_redirect_to_identity: false }, ["c", "p"])).toBe(true);
    expect(signInInSync({ allowed_idps: ["p", "c"], auto_redirect_to_identity: true }, ["c", "p"])).toBe(false);
    // Every provider allowed by an empty list, to Access; `on` still writes the list.
    expect(signInInSync({ allowed_idps: [], auto_redirect_to_identity: false }, ["p"])).toBe(false);
  });
});

describe("durationSeconds", () => {
  it("reads Access durations", () => {
    expect(durationSeconds("720h")).toBe(720 * 3600);
    expect(durationSeconds("2h45m")).toBe(2 * 3600 + 45 * 60);
    expect(durationSeconds("30m")).toBe(1800);
    expect(durationSeconds("1d")).toBeNull();
    expect(durationSeconds("")).toBeNull();
  });
});
