/**
 * The `oauth2-user` spec kind (docs/design/2026-11-oauth-simplify.md): a
 * preset parses into an OAuthClientCapability with a `flow`, round-trips
 * through `providerSpecOf`, and every field is held to its rule.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_IDS, type OAuthFlow } from "./capabilities";
import { isSettableGatewaySetting } from "./gatewaySettings";
import { REMOVED_OAUTH_FIELDS } from "./oauthSpec";
import {
  OAUTH_PRESETS,
  isOAuthProvider,
  oauthPreset,
  oauthPresetIds,
} from "./oauthPresets";
import {
  checkProviderRow,
  providerBindingKey,
  providerRegistry,
  registrableHosts,
} from "./providerRegistry";
import { parseProviderSpec, providerSpecOf } from "./providerSpec";

const GITHUB = OAUTH_PRESETS["github-oauth"]!;

function problems(input: unknown): string[] {
  const parsed = parseProviderSpec(input);
  return parsed.ok ? [] : parsed.problems.map((p) => `${p.path}: ${p.message}`);
}

function withAuth(extra: Record<string, unknown>): Record<string, unknown> {
  return { ...GITHUB, auth: { ...(GITHUB["auth"] as object), ...extra } };
}

describe("parseProviderSpec with auth.kind oauth2-user", () => {
  it("parses the GitHub preset into an OAuth provider with a flow, and round-trips it", () => {
    const parsed = parseProviderSpec(GITHUB);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    const capability = parsed.capability;
    expect(capability.mode).toBe("oauth_client");
    if (capability.mode !== "oauth_client") return;
    expect(capability.secrets).toEqual({
      clientId: "GITHUB_OAUTH_CLIENT_ID",
      clientSecret: "GITHUB_OAUTH_CLIENT_SECRET",
    });
    expect(capability.api).toEqual(["api.github.com"]);
    expect(capability.console).toBe("https://github.com/settings/developers");
    expect(capability.flow).toEqual({
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      revokeUrl: "https://api.github.com/applications/{client_id}/grant",
      revokeMethod: "DELETE",
      inject: "form",
      pkce: true,
      scopeSeparator: "comma",
      tokenHeaders: { Accept: "application/json" },
      identity: {
        url: "https://api.github.com/user",
        label: "login",
        id: "id",
      },
      identityScopes: [],
      tolerated: [],
    });
    // Which scopes a connection holds is each app's config, never the spec.
    for (const field of ["access", "token", "authorize", "scopePolicy"]) {
      expect(capability, field).not.toHaveProperty(field);
    }
    expect(isOAuthProvider(capability)).toBe(true);
    expect(
      parseProviderSpec(providerSpecOf("github-oauth", capability)),
    ).toEqual(parsed);
  });

  it("fills the defaults: form injection, PKCE on, space-separated, no identity", () => {
    const parsed = parseProviderSpec({
      id: "acme",
      name: "Acme",
      docs: "https://acme.example/apps",
      hosts: ["api.acme.example"],
      auth: {
        kind: "oauth2-user",
        authorizeUrl: "https://acme.example/oauth/authorize",
        tokenUrl: "https://acme.example/oauth/token",
        clientId: "ACME_CLIENT_ID",
      },
    });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok || parsed.capability.mode !== "oauth_client") return;
    const { flow } = parsed.capability;
    expect(flow.inject).toBe("form");
    expect(flow.pkce).toBe(true);
    expect(flow.scopeSeparator).toBe("space");
    expect(flow.scopePrefix).toBeUndefined();
    expect(flow.identity).toBeUndefined();
    expect(flow.identityScopes).toEqual([]);
    expect(flow.tolerated).toEqual([]);
    // A public client: no secret setting.
    expect(parsed.capability.secrets.clientSecret).toBeUndefined();
  });

  it("reads the scope prefix, identity scopes and tolerated scopes", () => {
    const parsed = parseProviderSpec(
      withAuth({
        scopeSeparator: "space",
        scopePrefix: "https://api.github.com/scopes/",
        identity: {
          url: "https://api.github.com/user",
          label: "login",
          scopes: ["read:user"],
        },
        tolerated: ["user:email"],
      }),
    );
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok || parsed.capability.mode !== "oauth_client") return;
    expect(parsed.capability.flow).toMatchObject({
      scopePrefix: "https://api.github.com/scopes/",
      identityScopes: ["read:user"],
      tolerated: ["user:email"],
    });
    expect(
      parseProviderSpec(providerSpecOf("github-oauth", parsed.capability)),
    ).toEqual(parsed);
  });

  it("refuses what the design refuses", () => {
    expect(problems(withAuth({ authorizeUrl: "http://github.com/x" }))).toEqual(
      [
        "auth.authorizeUrl: must be an https URL with no port, credentials or fragment",
      ],
    );
    expect(
      problems(withAuth({ tokenUrl: "https://github.com/t?x=1" })),
    ).toEqual(["auth.tokenUrl: may not carry a query string"]);
    expect(problems(withAuth({ clientId: "github_client_id" }))[0]).toMatch(
      /^auth\.clientId: must name a Gateway setting/,
    );
    expect(
      problems(withAuth({ clientSecret: "GITHUB_OAUTH_CLIENT_ID" })),
    ).toEqual([
      "auth.clientSecret: must be another setting than auth.clientId",
    ]);
    expect(problems(withAuth({ inject: "query" }))).toEqual([
      "auth.inject: must be form (the client in the body) or basic (HTTP Basic)",
    ]);
    expect(problems(withAuth({ pkce: "yes" }))).toEqual([
      "auth.pkce: must be true or false",
    ]);
    expect(problems(withAuth({ scopeSeparator: "semicolon" }))).toEqual([
      "auth.scopeSeparator: must be one of space, comma",
    ]);
    expect(problems(withAuth({ scopeDialect: "comma" }))).toEqual([
      "auth.scopeDialect: renamed auth.scopeSeparator: space or comma (a provider's prefix goes in auth.scopePrefix)",
    ]);
    expect(
      problems(withAuth({ scopePrefix: "https://api.github.com/scopes" })),
    ).toEqual([
      "auth.scopePrefix: must end in / (https://www.googleapis.com/auth/): an app's scope is joined onto it",
    ]);
    expect(problems(withAuth({ revokeMethod: "PUT" }))).toEqual([
      "auth.revokeMethod: must be POST or DELETE",
    ]);
    expect(problems(withAuth({ extra: 1 }))).toEqual([
      "auth.extra: not a field of auth.kind oauth2-user",
    ]);
    expect(
      problems(withAuth({ authorizeParams: { redirect_uri: "https://evil" } })),
    ).toEqual([
      "auth.authorizeParams.redirect_uri: redirect_uri is a parameter the Gateway sets itself",
    ]);
    expect(
      problems(
        withAuth({ authorizeParams: { include_granted_scopes: "true" } }),
      ),
    ).toEqual([
      "auth.authorizeParams.include_granted_scopes: include_granted_scopes would widen the token beyond the app's scopes; the Gateway never sends it",
    ]);
    expect(
      problems(withAuth({ tokenHeaders: { Authorization: "Bearer x" } })),
    ).toEqual([
      "auth.tokenHeaders.Authorization: Authorization is a header the Gateway sets itself",
    ]);
    expect(
      problems(
        withAuth({
          identity: { url: "https://elsewhere.example/me", label: "login" },
        }),
      ),
    ).toEqual([
      "auth.identity.url: must be on one of hosts (the token is sent there)",
    ]);
    expect(problems(withAuth({ tolerated: ["a b", "c,d"] }))).toEqual([
      "auth.tolerated.0: one scope, with no space or comma",
      "auth.tolerated.1: one scope, with no space or comma",
    ]);
    expect(problems(withAuth({ tolerated: ["x", "x"] }))).toEqual([
      "auth.tolerated: lists a scope twice",
    ]);
  });

  it("refuses the fields scopes used to live in, saying what to write instead", () => {
    expect(
      problems({
        ...GITHUB,
        scopeSets: {
          "repo.read": { label: "x", access: "read", scopes: ["repo"] },
        },
        alwaysRequested: ["read:user"],
        tolerated: ["user:email"],
        access: ["read", "write"],
        readMethods: ["GET"],
        writeMethods: ["POST"],
      }),
    ).toEqual(
      [
        "scopeSets",
        "alwaysRequested",
        "tolerated",
        "access",
        "readMethods",
        "writeMethods",
      ].map((field) => `${field}: ${REMOVED_OAUTH_FIELDS[field]}`),
    );
  });

  it("refuses the API-key fields on an OAuth spec, and the OAuth fields on an API-key spec", () => {
    expect(problems({ ...GITHUB, hostSetting: "GITHUB_HOST" })).toEqual([
      "hostSetting: not a field of an oauth2-user spec",
    ]);
    expect(problems({ ...GITHUB, data: "account" })).toEqual([
      "data: not a field of an oauth2-user spec",
    ]);
    expect(problems({ ...GITHUB, mode: "api_key" })).toEqual([
      "mode: an oauth2-user spec's mode is oauth_client (or left out)",
    ]);
    expect(
      problems({
        id: "stripe",
        name: "Stripe",
        docs: "https://dashboard.stripe.com/apikeys",
        hosts: ["api.stripe.com"],
        auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
        scopeSets: {},
      }),
    ).toEqual(["scopeSets: unknown field"]);
    expect(problems({ ...GITHUB, hosts: [] })).toEqual([
      "hosts: required: at least one API host the token is sent to",
      "auth.identity.url: must be on one of hosts (the token is sent there)",
    ]);
  });
});

describe("the presets", () => {
  it("every preset parses, is an OAuth provider, and takes no catalog id", () => {
    expect(oauthPresetIds()).toEqual([
      "github-oauth",
      "notion-oauth",
      "linear-oauth",
      "gitlab-oauth",
      "atlassian",
      "hubspot-oauth",
      "zoom",
      "dropbox",
      "spotify",
    ]);
    for (const id of oauthPresetIds()) {
      const spec = OAUTH_PRESETS[id]!;
      expect(spec["id"], id).toBe(id);
      const parsed = parseProviderSpec(spec);
      expect(parsed.ok, `${id}: ${JSON.stringify(parsed)}`).toBe(true);
      expect(CAPABILITY_IDS.includes(id as never), id).toBe(false);
      const capability = oauthPreset(id);
      expect(isOAuthProvider(capability ?? undefined), id).toBe(true);
      if (!parsed.ok) continue;
      // Each preset passes the row rules on a gateway with no other rows.
      expect(
        checkProviderRow(id, parsed.capability, { rowSettings: new Set() }),
        id,
      ).toBeNull();
      // The round trip is exact.
      expect(parseProviderSpec(providerSpecOf(id, parsed.capability))).toEqual(
        parsed,
      );
      // No preset widens a token past an app's scopes.
      if (parsed.capability.mode === "oauth_client") {
        expect(
          parsed.capability.flow.authorizeParams ?? {},
          id,
        ).not.toHaveProperty("include_granted_scopes");
      }
    }
    expect(oauthPreset("nope")).toBeNull();
  });

  it("the social networks are gone, and the catalog reserves none of their names", () => {
    for (const id of [
      "x-oauth",
      "linkedin",
      "facebook",
      "discord",
      "reddit",
      "youtube",
    ]) {
      expect(oauthPreset(id), id).toBeNull();
      expect(CAPABILITY_IDS.includes(id as never), id).toBe(false);
    }
    for (const name of [
      "LINKEDIN_CLIENT_ID",
      "DISCORD_CLIENT_ID",
      "MASTODON_URL",
    ]) {
      expect(isSettableGatewaySetting(name), name).toBe(false);
    }
  });

  it("the catalog's Google, Microsoft and Slack carry a flow", () => {
    for (const id of ["google-workspace", "microsoft-365", "slack"]) {
      expect(isOAuthProvider(CAPABILITIES[id as never]), id).toBe(true);
    }
    expect(CAPABILITIES["google-workspace"].flow.authorizeParams).toEqual({
      access_type: "offline",
      prompt: "consent",
    });
    expect(
      (CAPABILITIES["google-workspace"].flow as OAuthFlow).revokeUrl,
    ).toBeUndefined();
    expect(CAPABILITIES["slack"].flow.pkce).toBe(false);
  });
});

describe("an OAuth row in the registry", () => {
  const row = { id: "github-oauth", spec: GITHUB };

  it("is served as a row with every endpoint host checked by the host rules", () => {
    const registry = providerRegistry([row]);
    expect(registry.rejected).toEqual([]);
    expect(registry.sourceOf("github-oauth")).toBe("row");
    expect(registry.get("github-oauth")?.mode).toBe("oauth_client");
    expect(registry.settingNames().has("GITHUB_OAUTH_CLIENT_SECRET")).toBe(
      true,
    );
    const parsed = parseProviderSpec(GITHUB);
    if (!parsed.ok) throw new Error("parses");
    expect(registrableHosts(parsed.capability)).toEqual([
      "api.github.com",
      "github.com",
    ]);
    const refused = providerRegistry([row], {
      refuseHost: (host) =>
        host === "github.com" ? `${host} is reserved` : null,
    });
    expect(refused.rejected).toEqual([
      {
        id: "github-oauth",
        code: "PROVIDER_HOST_REFUSED",
        message: "github.com is reserved",
      },
    ]);
  });

  it("binds the client to its endpoints, hosts, injection and setting names", () => {
    const parsed = parseProviderSpec(GITHUB);
    if (!parsed.ok) throw new Error("parses");
    const key = providerBindingKey(parsed.capability);
    expect(JSON.parse(key)).toEqual({
      kind: "oauth2-user",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      revokeUrl: "https://api.github.com/applications/{client_id}/grant",
      inject: "form",
      clientId: "GITHUB_OAUTH_CLIENT_ID",
      clientSecret: "GITHUB_OAUTH_CLIENT_SECRET",
      hosts: ["api.github.com"],
    });
    const moved = parseProviderSpec(
      withAuth({ tokenUrl: "https://github.com/login/oauth/other" }),
    );
    if (!moved.ok) throw new Error("parses");
    expect(providerBindingKey(moved.capability)).not.toBe(key);
    expect(
      providerRegistry([{ ...row, boundTo: key }]).bound("github-oauth"),
    ).toBe(true);
    expect(
      providerRegistry([
        {
          ...row,
          spec:
            moved.capability &&
            withAuth({ tokenUrl: "https://github.com/login/oauth/other" }),
          boundTo: key,
        },
      ]).bound("github-oauth"),
    ).toBe(false);
  });

  it("refuses a row that names a catalog client's setting", () => {
    const registry = providerRegistry([
      {
        id: "github-oauth",
        spec: withAuth({ clientId: "GOOGLE_WORKSPACE_CLIENT_ID" }),
      },
    ]);
    expect(registry.rejected[0]?.code).toBe("PROVIDER_SECRET_TAKEN");
  });
});
