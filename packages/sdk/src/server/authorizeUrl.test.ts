import { describe, expect, it } from "vitest";
import { CAPABILITIES, ConfigurationError } from "../internal/index";
import { authorizeUrl } from "./authorizeUrl";
import type { OAuthClientIntegrationStatus } from "./integrationFetch";

const READY: OAuthClientIntegrationStatus = {
  requested: true,
  configured: true,
  ready: true,
  clientId: "client-123",
};

const GOOGLE: OAuthClientIntegrationStatus = {
  ...READY,
  scopeSets: ["identity", "search-console.read"],
  scopes: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/webmasters.readonly",
  ],
};

const CALLBACK = "https://crm.example.com/integrations/google/callback";

/** The query as the provider reads it, in the order it was written. */
function query(url: URL): [string, string][] {
  return [...url.searchParams.entries()];
}

describe("authorizeUrl", () => {
  it("builds Google's from the status's scopes, offline, with PKCE as S256", () => {
    const url = authorizeUrl({
      provider: "google-workspace",
      status: GOOGLE,
      redirectUri: CALLBACK,
      state: "st-1",
      codeChallenge: "ch-1",
      params: { prompt: "consent", login_hint: "a@example.com" },
    });
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(query(url)).toEqual([
      ["client_id", "client-123"],
      ["response_type", "code"],
      ["redirect_uri", CALLBACK],
      ["state", "st-1"],
      [
        "scope",
        "openid email profile https://www.googleapis.com/auth/webmasters.readonly",
      ],
      ["code_challenge", "ch-1"],
      ["code_challenge_method", "S256"],
      ["access_type", "offline"],
      ["prompt", "consent"],
      ["login_hint", "a@example.com"],
    ]);
  });

  it("builds Microsoft's with response_mode=query, and no PKCE unless asked", () => {
    const url = authorizeUrl({
      provider: "microsoft-365",
      status: {
        ...READY,
        scopeSets: ["identity", "mail.read"],
        scopes: ["User.Read", "Mail.Read", "offline_access"],
      },
      redirectUri: CALLBACK,
      state: "st-2",
    });
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("scope")).toBe(
      "User.Read Mail.Read offline_access",
    );
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("access_type")).toBe(false);
  });

  it("builds Slack's with comma-joined scope and user_scope, and nothing else of its own", () => {
    const url = authorizeUrl({
      provider: "slack",
      status: {
        ...READY,
        scopeSets: ["channels.read", "user-channels.manage"],
        scopes: ["channels:read", "groups:read"],
        userScopes: [
          "channels:read",
          "channels:write",
          "groups:read",
          "groups:write",
        ],
      },
      redirectUri: CALLBACK,
      state: "st-3",
    });
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(query(url)).toEqual([
      ["client_id", "client-123"],
      ["response_type", "code"],
      ["redirect_uri", CALLBACK],
      ["state", "st-3"],
      ["scope", "channels:read,groups:read"],
      ["user_scope", "channels:read,channels:write,groups:read,groups:write"],
    ]);
  });

  it("leaves user_scope off Slack's URL when the sets ask for no user scopes", () => {
    const url = authorizeUrl({
      provider: "slack",
      status: {
        ...READY,
        scopeSets: ["channels.read"],
        scopes: ["channels:read", "groups:read"],
        userScopes: [],
      },
      redirectUri: CALLBACK,
      state: "st-4",
    });
    expect(url.searchParams.get("scope")).toBe("channels:read,groups:read");
    expect(url.searchParams.has("user_scope")).toBe(false);
  });

  // Mastodon and LinkedIn have no scope sets, so the helper refuses them.
  it.each([
    ["mastodon", { ...READY, origin: "https://fosstodon.org" }],
    ["linkedin", READY],
  ] as const)(
    "refuses %s, a client without scope sets, naming the ones it builds for",
    (provider, status) => {
      const build = () =>
        authorizeUrl({ provider, status, redirectUri: CALLBACK, state: "st" });
      expect(build).toThrow(TypeError);
      expect(build).toThrow(
        `clients with scope sets (slack, google-workspace, microsoft-365); build ${CAPABILITIES[provider].label}'s authorize URL yourself from the status's clientId`,
      );
    },
  );

  it.each([
    ["not ready", { ...GOOGLE, ready: false }, /needs a ready status/],
    ["without a clientId", { ...GOOGLE, clientId: undefined }, /clientId/],
    [
      "without scopes",
      { ...READY, scopeSets: ["identity"] },
      /integrationStatus\(\)\.scopes, which this status lacks/,
    ],
  ] as const)(
    "refuses to build from a status %s, naming the fix",
    (_, status, message) => {
      expect(() =>
        authorizeUrl({
          provider: "google-workspace",
          status,
          redirectUri: CALLBACK,
          state: "st",
        }),
      ).toThrow(message);
      expect(() =>
        authorizeUrl({
          provider: "google-workspace",
          status,
          redirectUri: CALLBACK,
          state: "st",
        }),
      ).toThrow(TypeError);
    },
  );

  it.each([
    "scope",
    "user_scope",
    "client_id",
    "redirect_uri",
    "state",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "access_type",
    "response_mode",
    "include_granted_scopes",
  ])("refuses params that set %s, which it decides itself", (name) => {
    const build = () =>
      authorizeUrl({
        provider: "google-workspace",
        status: GOOGLE,
        redirectUri: CALLBACK,
        state: "st",
        params: { [name]: "x" },
      });
    expect(build).toThrow(TypeError);
    expect(build).toThrow(
      name === "include_granted_scopes"
        ? /integration_scope_exceeded/
        : new RegExp(`sets ${name} itself`),
    );
  });

  it("refuses a provider that isn't an OAuth client", () => {
    expect(() =>
      authorizeUrl({
        provider: "dataforseo" as "linkedin",
        status: READY,
        redirectUri: CALLBACK,
        state: "st",
      }),
    ).toThrow(ConfigurationError);
  });
});
