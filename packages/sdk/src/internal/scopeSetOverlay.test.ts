/**
 * Scope-set overlays on built-in OAuth clients: an operator's set parses
 * by the rules a built-in set does, with routes on the client's API hosts
 * alone and an explicit access; the registry adds it to the client's
 * policy and authorize scopes, never replacing a built-in set, never on
 * anything but a catalog OAuth client with scope sets.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./capabilities";
import { parseScopeSetOverlay, withScopeSets } from "./oauthSpec";
import { providerRegistry, resolveScopeSetRow } from "./providerRegistry";

const GOOGLE = CAPABILITIES["google-workspace"];
const client = { id: "google-workspace", capability: GOOGLE };

const GMAIL_SEND = {
  name: "gmail.send",
  label: "Gmail (send)",
  access: "write",
  scopes: ["https://www.googleapis.com/auth/gmail.send"],
  routes: [
    {
      host: "gmail.googleapis.com",
      paths: ["/gmail/v1/users/"],
      posts: ["^/gmail/v1/users/[^/]+/messages/send$"],
    },
  ],
};

function problems(input: unknown): string[] {
  const parsed = parseScopeSetOverlay(input, client);
  return parsed.ok ? [] : parsed.problems.map((p) => `${p.path}: ${p.message}`);
}

describe("parseScopeSetOverlay", () => {
  it("parses a set with routes on the client's hosts, posts as anchored patterns", () => {
    const parsed = parseScopeSetOverlay(GMAIL_SEND, client);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.name).toBe("gmail.send");
    expect(parsed.set.access).toBe("write");
    expect(parsed.set.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    expect(parsed.set.routes).toHaveLength(1);
    expect(
      parsed.set.routes[0]!.posts![0]!.test("/gmail/v1/users/me/messages/send"),
    ).toBe(true);
  });

  it("refuses what a built-in set is refused, and what an overlay adds", () => {
    expect(problems({ ...GMAIL_SEND, name: "gmail.read" })).toEqual([
      "name: gmail.read is one of google-workspace's own sets; an overlay adds a set, never replaces one",
    ]);
    expect(problems({ ...GMAIL_SEND, name: "Gmail Send" })).toEqual([
      "name: required: identity, or <area>.<access> in lowercase (gmail.send)",
    ]);
    expect(problems({ ...GMAIL_SEND, access: undefined })).toEqual([
      "(set).access: must be read or write",
    ]);
    expect(problems({ ...GMAIL_SEND, routes: [] })).toEqual([
      "(set).routes: required: at least one { host, paths } the set unlocks, on one of the client's API hosts",
    ]);
    expect(
      problems({
        ...GMAIL_SEND,
        routes: [{ host: "evil.example", paths: ["/"] }],
      }),
    ).toEqual(["(set).routes.0.host: must be one of hosts"]);
    expect(problems({ ...GMAIL_SEND, scopes: [] })).toEqual([
      "(set).scopes: must list a scope",
    ]);
    expect(problems({ ...GMAIL_SEND, provider: "slack" })).toEqual([
      "provider: is slack, not google-workspace",
    ]);
    expect(problems({ ...GMAIL_SEND, extra: 1 })).toEqual([
      "extra: unknown field",
    ]);
    expect(problems("x")).toEqual(["(root): must be a JSON object"]);
  });

  it("refuses a client without scope sets", () => {
    // No catalog client lacks scope sets now: one made without them.
    const { scopePolicy: _policy, ...plain } = CAPABILITIES.slack;
    const parsed = parseScopeSetOverlay(GMAIL_SEND, {
      id: "plain",
      capability: plain,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems[0]!.message).toMatch(/has no scope sets/);
  });
});

describe("withScopeSets", () => {
  it("adds the set after the client's own and its scopes to the authorize list, once", () => {
    const parsed = parseScopeSetOverlay(GMAIL_SEND, client);
    if (!parsed.ok) throw new Error("parse");
    const merged = withScopeSets(GOOGLE, {
      "gmail.send": parsed.set,
      "gmail.read": parsed.set,
    });
    expect(Object.keys(merged.scopePolicy!.sets)).toEqual([
      ...Object.keys(GOOGLE.scopePolicy!.sets),
      "gmail.send",
    ]);
    // The built-in gmail.read stays the client's own.
    expect(merged.scopePolicy!.sets["gmail.read"]).toBe(
      GOOGLE.scopePolicy!.sets["gmail.read"],
    );
    expect(merged.authorize.scopes).toEqual([
      ...GOOGLE.authorize.scopes,
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    // The catalog entry is untouched.
    expect(GOOGLE.authorize.scopes).not.toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
  });
});

describe("the registry with scope-set overlays", () => {
  it("serves the overlay on the built-in client, with where each set comes from", () => {
    const registry = providerRegistry([], {
      scopeSets: [
        {
          providerId: "google-workspace",
          name: "gmail.send",
          spec: JSON.stringify(GMAIL_SEND),
          addedBy: "ops@example.com",
          addedAt: 1,
        },
      ],
    });
    const google = registry.get("google-workspace");
    expect(google?.mode).toBe("oauth_client");
    if (google?.mode !== "oauth_client") return;
    expect(Object.keys(google.scopePolicy!.sets)).toContain("gmail.send");
    expect(google.authorize.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
    expect(
      registry
        .scopeSets()
        .map((set) => [set.providerId, set.name, set.addedBy]),
    ).toEqual([["google-workspace", "gmail.send", "ops@example.com"]]);
    expect(registry.scopeSetSource("google-workspace", "gmail.send")).toBe(
      "row",
    );
    expect(registry.scopeSetSource("google-workspace", "gmail.read")).toBe(
      "catalog",
    );
    expect(
      registry.scopeSetSource("google-workspace", "nothing"),
    ).toBeUndefined();
    expect(registry.rejectedScopeSets).toEqual([]);
    // Nothing else moved: the catalog order, the client's binding key.
    expect(registry.sourceOf("google-workspace")).toBe("catalog");
  });

  it("refuses a built-in name, an unknown or non-OAuth client, a bad spec and a duplicate, naming why", () => {
    const registry = providerRegistry([], {
      scopeSets: [
        {
          providerId: "google-workspace",
          name: "gmail.read",
          spec: GMAIL_SEND,
        },
        { providerId: "dataforseo", name: "x.read", spec: GMAIL_SEND },
        { providerId: "nothing", name: "x.read", spec: GMAIL_SEND },
        { providerId: "google-workspace", name: "gmail.send", spec: "{" },
        {
          providerId: "google-workspace",
          name: "gmail.write",
          spec: GMAIL_SEND,
        },
        {
          providerId: "google-workspace",
          name: "gmail.write",
          spec: GMAIL_SEND,
        },
      ],
    });
    expect(
      registry.rejectedScopeSets.map((r) => [r.providerId, r.name, r.code]),
    ).toEqual([
      ["google-workspace", "gmail.read", "SCOPE_SET_BUILTIN"],
      ["dataforseo", "x.read", "SCOPE_SET_PROVIDER_UNKNOWN"],
      ["nothing", "x.read", "SCOPE_SET_PROVIDER_UNKNOWN"],
      ["google-workspace", "gmail.send", "SCOPE_SET_INVALID"],
      ["google-workspace", "gmail.write", "SCOPE_SET_INVALID"],
    ]);
    expect(registry.rejectedScopeSets[4]!.message).toBe("listed twice");
    expect(registry.scopeSets().map((set) => set.name)).toEqual([
      "gmail.write",
    ]);
    const google = registry.get("google-workspace");
    if (google?.mode !== "oauth_client") throw new Error("google");
    expect(google.scopePolicy!.sets["gmail.read"]).toBe(
      GOOGLE.scopePolicy!.sets["gmail.read"],
    );
    expect(
      resolveScopeSetRow({
        providerId: "slack",
        name: "x.read",
        spec: {
          ...GMAIL_SEND,
          routes: [{ host: "slack.com", paths: ["/api/"] }],
        },
      }).ok,
    ).toBe(true);
  });
});
