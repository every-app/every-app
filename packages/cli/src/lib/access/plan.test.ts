/**
 * The pure rules of the outer ring: manifest globs as Access path patterns,
 * the destinations the registry calls for, how a found application is read,
 * and how the policy's rules merge.
 */
import { describe, expect, it } from "vitest";
import type { AccessApplication } from "@/lib/cf/access";
import {
  accessPathPattern,
  appDestination,
  appsDestinations,
  durationSeconds,
  emailDomainRule,
  emailRule,
  findAccessApplications,
  gatewayDestination,
  isOwnedUri,
  mergeRules,
  peopleIdentityProviders,
  ruleDomains,
  ruleEmails,
  sameDestinations,
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
  it("starts with the MCP paths, then the routes once each, methods ignored", () => {
    const { destination, dropped } = appDestination(
      { appId: "crm", hostname: "CRM.apps.acme.com", publicPaths: ["/t/*", "/t/e", "/health", "/health"] },
      { mcp: true },
    );
    expect(destination.uri).toBe("crm.apps.acme.com");
    expect(destination.overrides.map((o) => o.path_pattern)).toEqual(["/mcp", "/mcp/*", "/t/*", "/t/e", "/health"]);
    expect(dropped).toEqual([]);
  });

  it("leaves out the MCP paths under Managed OAuth", () => {
    const { destination } = appDestination({ appId: "crm", hostname: "crm.apps.acme.com", publicPaths: ["/health"] }, { mcp: false });
    expect(destination.overrides.map((o) => o.path_pattern)).toEqual(["/health"]);
  });

  it("drops what Access can't take, saying why: inexpressible first, then the 26th", () => {
    const many = Array.from({ length: 30 }, (_, i) => `/r${i}`);
    const { destination, dropped } = appDestination(
      { appId: "big", hostname: "big.apps.acme.com", publicPaths: ["/a*b*", ...many] },
      { mcp: true },
    );
    expect(destination.overrides).toHaveLength(25);
    expect(dropped).toEqual([
      { appId: "big", path: "/a*b*", reason: "not_expressible" },
      ...many.slice(23).map((path) => ({ appId: "big", path, reason: "too_many" })),
    ]);
  });
});

describe("appsDestinations", () => {
  it("is the wildcard, then one destination per app with public routes under the base, by host", () => {
    const plan = appsDestinations("apps.acme.com", [
      { appId: "todo", hostname: "todo.apps.acme.com", publicPaths: [] },
      { appId: "crm", hostname: "crm.apps.acme.com", publicPaths: ["/health"] },
      { appId: "analytics", hostname: "analytics.apps.acme.com", publicPaths: ["/collect"] },
      { appId: "far", hostname: "far.elsewhere.com", publicPaths: ["/x"] },
      { appId: "deep", hostname: "a.b.apps.acme.com", publicPaths: ["/x"] },
    ]);
    expect(plan.destinations.map((d) => d.uri)).toEqual([
      "*.apps.acme.com",
      "analytics.apps.acme.com",
      "crm.apps.acme.com",
    ]);
    expect(plan.destinations[0]!.overrides.map((o) => o.path_pattern)).toEqual(["/mcp", "/mcp/*"]);
    expect(plan.outsideBase).toEqual(["deep", "far"]);
    expect(plan.dropped).toEqual([]);
  });

  it("bypasses nothing on the wildcard under Managed OAuth", () => {
    const plan = appsDestinations("apps.acme.com", [], { mcp: false });
    expect(plan.destinations).toEqual([{ type: "public", uri: "*.apps.acme.com", overrides: [] }]);
  });
});

describe("gatewayDestination", () => {
  it("lets the machine endpoints through, or nothing under Managed OAuth", () => {
    expect(gatewayDestination("Apps.Acme.com", false).overrides.map((o) => o.path_pattern)).toEqual([
      "/mcp",
      "/mcp/*",
      "/oauth/token",
      "/oauth/register",
      "/.well-known/*",
    ]);
    expect(gatewayDestination("apps.acme.com", true)).toEqual({ type: "public", uri: "apps.acme.com", overrides: [] });
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
  it("leaves the Cloudflare account-members provider out of what people sign in with", () => {
    expect(
      peopleIdentityProviders([
        { id: "c", type: "cloudflare" },
        { id: "p", type: "onetimepin" },
        { id: "g", type: "google-apps" },
      ]).map((p) => p.id),
    ).toEqual(["p", "g"]);
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
