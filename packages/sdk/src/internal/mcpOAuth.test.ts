import { describe, expect, it } from "vitest";
import type { OAuthClientCapability } from "./capabilities.js";
import {
  MCP_OAUTH_MAX_BODY,
  chooseTokenEndpointAuthMethod,
  discoverMcpOAuth,
  mcpOAuthProviderSpec,
  mcpStaticProviderSpec,
  parseWwwAuthenticate,
  registerMcpClient,
  type McpOAuthDiscovery,
  type McpOAuthFetch,
} from "./mcpOAuth.js";
import { oauthSpecOf } from "./oauthSpec.js";
import { providerBindingKey, providerRegistry } from "./providerRegistry.js";
import { parseProviderSpec } from "./providerSpec.js";

type Route =
  | Record<string, unknown>
  | { status: number; body?: string; headers?: Record<string, string> };

/** A fetch answering from `routes` (JSON for an object, else the status), 404 for anything else, recording each call. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: McpOAuthFetch = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    if (typeof route["status"] === "number") {
      const { status, body, headers } = route as {
        status: number;
        body?: string;
        headers?: Record<string, string>;
      };
      return new Response(body ?? null, {
        status,
        ...(headers ? { headers } : {}),
      });
    }
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

const MCP = "https://mcp.example.com/mcp";
const ISSUER = "https://auth.example.com";
const AS = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  revocation_endpoint: `${ISSUER}/revoke`,
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  scopes_supported: ["openid", "everything"],
};
const PRM = {
  resource: MCP,
  authorization_servers: [ISSUER],
  scopes_supported: ["mcp:read", "mcp:write"],
};

describe("parseWwwAuthenticate", () => {
  it("reads the Bearer challenge's resource_metadata, scope and error", () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="files:read files:write", error="invalid_token"',
      ),
    ).toEqual({
      resourceMetadata:
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      scope: "files:read files:write",
      error: "invalid_token",
    });
  });

  it("finds the Bearer challenge among several, in any case, with bare values", () => {
    expect(
      parseWwwAuthenticate(
        'Basic realm="x", bearer Resource_Metadata=https://a.example/prm, error=insufficient_scope',
      ),
    ).toEqual({
      resourceMetadata: "https://a.example/prm",
      error: "insufficient_scope",
    });
    expect(parseWwwAuthenticate('Bearer realm="a\\"b"')).toEqual({});
    expect(parseWwwAuthenticate("Bearer")).toEqual({});
  });

  it("is null without a Bearer challenge", () => {
    expect(parseWwwAuthenticate('Basic realm="x"')).toBeNull();
    expect(parseWwwAuthenticate("")).toBeNull();
    expect(parseWwwAuthenticate(null)).toBeNull();
  });
});

describe("discoverMcpOAuth", () => {
  it("reads the resource metadata path-inserted first, then at the root, then the issuer's metadata", async () => {
    const { fetch, calls } = fakeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": PRM,
      [`${ISSUER}/.well-known/oauth-authorization-server`]: AS,
    });
    const result = await discoverMcpOAuth({ url: MCP, fetch });
    expect(calls.map((call) => call.url)).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
      `${ISSUER}/.well-known/oauth-authorization-server`,
    ]);
    for (const call of calls) expect(call.init.redirect).toBe("manual");
    expect(result).toEqual({
      ok: true,
      discovery: {
        resource: MCP,
        issuer: ISSUER,
        authorizationEndpoint: `${ISSUER}/authorize`,
        tokenEndpoint: `${ISSUER}/token`,
        registrationEndpoint: `${ISSUER}/register`,
        revocationEndpoint: `${ISSUER}/revoke`,
        scopes: ["mcp:read", "mcp:write"],
        supportedScopes: ["mcp:read", "mcp:write"],
        tokenEndpointAuthMethods: ["client_secret_post", "none"],
        resourceMetadata: true,
      },
    });
  });

  it("takes the path-inserted metadata when it answers, a covering resource, and the challenge's scope first", async () => {
    const { fetch, calls } = fakeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        ...PRM,
        resource: "https://mcp.example.com/",
      },
      [`${ISSUER}/.well-known/oauth-authorization-server`]: AS,
    });
    const result = await discoverMcpOAuth({
      url: MCP,
      fetch,
      scope: "files:read",
    });
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      ok: true,
      discovery: {
        resource: "https://mcp.example.com/",
        scopes: ["files:read"],
      },
    });
  });

  it("uses the challenge's resource_metadata URL alone when given", async () => {
    const at = "https://mcp.example.com/meta/prm";
    const { fetch, calls } = fakeFetch({
      [at]: PRM,
      [`${ISSUER}/.well-known/oauth-authorization-server`]: AS,
    });
    expect(
      await discoverMcpOAuth({ url: MCP, fetch, resourceMetadataUrl: at }),
    ).toMatchObject({ ok: true });
    expect(calls[0]!.url).toBe(at);
    const missing = fakeFetch({});
    expect(
      await discoverMcpOAuth({
        url: MCP,
        fetch: missing.fetch,
        resourceMetadataUrl: at,
      }),
    ).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/didn't answer/),
    });
    expect(missing.calls).toHaveLength(1);
  });

  it("refuses resource metadata for another server", async () => {
    for (const resource of [
      "https://other.example.com/mcp",
      "https://mcp.example.com/mcpx",
      "https://mcp.example.com/other",
    ]) {
      const { fetch } = fakeFetch({
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
          ...PRM,
          resource,
        },
        [`${ISSUER}/.well-known/oauth-authorization-server`]: AS,
      });
      expect(
        await discoverMcpOAuth({ url: MCP, fetch }),
        resource,
      ).toMatchObject({
        ok: false,
        problem: expect.stringMatching(/refuses metadata for another server/),
      });
    }
  });

  it("refuses authorization server metadata naming another issuer", async () => {
    const { fetch } = fakeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": PRM,
      [`${ISSUER}/.well-known/oauth-authorization-server`]: {
        ...AS,
        issuer: "https://evil.example.com",
      },
    });
    expect(await discoverMcpOAuth({ url: MCP, fetch })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(
        /names the issuer https:\/\/evil\.example\.com/,
      ),
    });
  });

  it("refuses a server without PKCE S256", async () => {
    for (const methods of [["plain"], undefined]) {
      const { fetch } = fakeFetch({
        "https://mcp.example.com/.well-known/oauth-protected-resource": PRM,
        [`${ISSUER}/.well-known/oauth-authorization-server`]: {
          ...AS,
          code_challenge_methods_supported: methods,
        },
      });
      expect(await discoverMcpOAuth({ url: MCP, fetch })).toMatchObject({
        ok: false,
        problem: expect.stringMatching(/doesn't support PKCE/),
      });
    }
  });

  it("falls back to OpenID discovery, path-inserted then path-appended, for an issuer with a path", async () => {
    const issuer = "https://auth.example.com/tenant/1";
    const { fetch, calls } = fakeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": {
        ...PRM,
        authorization_servers: [issuer],
      },
      "https://auth.example.com/tenant/1/.well-known/openid-configuration": {
        ...AS,
        issuer,
      },
    });
    const result = await discoverMcpOAuth({ url: MCP, fetch });
    expect(calls.slice(2).map((call) => call.url)).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant/1",
      "https://auth.example.com/.well-known/openid-configuration/tenant/1",
      "https://auth.example.com/tenant/1/.well-known/openid-configuration",
    ]);
    expect(result).toMatchObject({ ok: true, discovery: { issuer } });
  });

  it("falls back to the authorization server at the MCP origin for a 2025-03-26 server", async () => {
    const origin = "https://mcp.example.com";
    const { fetch, calls } = fakeFetch({
      [`${origin}/.well-known/oauth-authorization-server`]: {
        ...AS,
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
      },
    });
    const result = await discoverMcpOAuth({ url: MCP, fetch });
    expect(calls.map((call) => call.url)).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
      "https://mcp.example.com/.well-known/oauth-authorization-server",
    ]);
    expect(result).toMatchObject({
      ok: true,
      discovery: {
        resource: MCP,
        issuer: origin,
        tokenEndpoint: `${origin}/token`,
        scopes: [],
        resourceMetadata: false,
      },
    });
    expect(
      await discoverMcpOAuth({ url: MCP, fetch: fakeFetch({}).fetch }),
    ).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/has no OAuth metadata/),
    });
  });

  it("follows no redirect", async () => {
    const { fetch, calls } = fakeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        status: 302,
        headers: { location: "https://elsewhere.example.com/prm" },
      },
    });
    expect(await discoverMcpOAuth({ url: MCP, fetch })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/redirect \(302\)/),
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses an answer over 64 KiB", async () => {
    const big = JSON.stringify({
      ...PRM,
      padding: "x".repeat(MCP_OAUTH_MAX_BODY),
    });
    const { fetch } = fakeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        status: 200,
        body: big,
      },
    });
    expect(await discoverMcpOAuth({ url: MCP, fetch })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/more than 64 KiB/),
    });
  });

  it("fetches nothing on a private host, an IP, http or another port", async () => {
    for (const issuer of [
      "https://auth.internal",
      "https://localhost",
      "https://10.0.0.1",
      "http://auth.example.com",
      "https://auth.example.com:8443",
    ]) {
      const { fetch, calls } = fakeFetch({
        "https://mcp.example.com/.well-known/oauth-protected-resource": {
          ...PRM,
          authorization_servers: [issuer],
        },
      });
      expect(await discoverMcpOAuth({ url: MCP, fetch }), issuer).toMatchObject(
        {
          ok: false,
        },
      );
      expect(
        calls.some((call) => call.url.startsWith(issuer)),
        issuer,
      ).toBe(false);
    }
    const { fetch, calls } = fakeFetch({});
    expect(
      await discoverMcpOAuth({ url: "https://mcp.local/mcp", fetch }),
    ).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/not a public host/),
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses an endpoint off https, on a private host or with a query on the token URL", async () => {
    for (const patch of [
      { token_endpoint: "http://auth.example.com/token" },
      { authorization_endpoint: "https://auth.internal/authorize" },
      { token_endpoint: `${ISSUER}/token?x=1` },
      { registration_endpoint: "https://127.0.0.1/register" },
    ]) {
      const { fetch } = fakeFetch({
        "https://mcp.example.com/.well-known/oauth-protected-resource": PRM,
        [`${ISSUER}/.well-known/oauth-authorization-server`]: {
          ...AS,
          ...patch,
        },
      });
      expect(
        await discoverMcpOAuth({ url: MCP, fetch }),
        JSON.stringify(patch),
      ).toMatchObject({ ok: false });
    }
  });
});

const discovery: McpOAuthDiscovery = {
  resource: MCP,
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  registrationEndpoint: `${ISSUER}/register`,
  revocationEndpoint: `${ISSUER}/revoke`,
  scopes: ["mcp:read"],
  tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post"],
  resourceMetadata: true,
};
const REDIRECT = "https://apps.example.com/connect/acme-mcp/callback";

describe("registerMcpClient", () => {
  it("picks Basic, then the form, then a public client", () => {
    expect(
      chooseTokenEndpointAuthMethod([
        "client_secret_post",
        "client_secret_basic",
      ]),
    ).toBe("client_secret_basic");
    expect(chooseTokenEndpointAuthMethod(["client_secret_post", "none"])).toBe(
      "client_secret_post",
    );
    expect(chooseTokenEndpointAuthMethod(["none"])).toBe("none");
    expect(chooseTokenEndpointAuthMethod(["private_key_jwt"])).toBeNull();
  });

  it("registers the Gateway's callback and reads back what the server registered", async () => {
    const { fetch, calls } = fakeFetch({
      [`${ISSUER}/register`]: {
        client_id: "c-1",
        client_secret: "s-1",
        token_endpoint_auth_method: "client_secret_basic",
      },
    });
    const result = await registerMcpClient({
      discovery,
      redirectUri: REDIRECT,
      clientName: "Every App (Acme)",
      fetch,
    });
    expect(result).toEqual({
      ok: true,
      clientId: "c-1",
      clientSecret: "s-1",
      inject: "basic",
      authMethod: "client_secret_basic",
    });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      client_name: "Every App (Acme)",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      scope: "mcp:read",
    });
  });

  it("takes the server's word on the method: the form, or a public client", async () => {
    const post = fakeFetch({
      [`${ISSUER}/register`]: {
        client_id: "c-2",
        client_secret: "s-2",
        token_endpoint_auth_method: "client_secret_post",
      },
    });
    expect(
      await registerMcpClient({
        discovery,
        redirectUri: REDIRECT,
        clientName: "x",
        fetch: post.fetch,
      }),
    ).toMatchObject({ ok: true, inject: "form", clientSecret: "s-2" });
    const publicClient = fakeFetch({
      [`${ISSUER}/register`]: {
        client_id: "c-3",
        token_endpoint_auth_method: "none",
      },
    });
    const result = await registerMcpClient({
      discovery: { ...discovery, tokenEndpointAuthMethods: ["none"] },
      redirectUri: REDIRECT,
      clientName: "x",
      fetch: publicClient.fetch,
    });
    expect(result).toEqual({
      ok: true,
      clientId: "c-3",
      inject: "form",
      authMethod: "none",
    });
    expect(
      JSON.parse(publicClient.calls[0]!.init.body as string)
        .token_endpoint_auth_method,
    ).toBe("none");
  });

  it("refuses without a registration endpoint, a refusal, a missing id or secret", async () => {
    const { registrationEndpoint: _, ...noDcr } = discovery;
    expect(
      await registerMcpClient({
        discovery: noDcr,
        redirectUri: REDIRECT,
        clientName: "x",
        fetch: fakeFetch({}).fetch,
      }),
    ).toMatchObject({ ok: false, unsupported: true });
    for (const route of [
      { status: 400, body: "{}" },
      { client_secret: "s" },
      { client_id: "c", token_endpoint_auth_method: "client_secret_basic" },
      { client_id: "c", token_endpoint_auth_method: "private_key_jwt" },
    ]) {
      const { fetch } = fakeFetch({ [`${ISSUER}/register`]: route });
      expect(
        await registerMcpClient({
          discovery,
          redirectUri: REDIRECT,
          clientName: "x",
          fetch,
        }),
        JSON.stringify(route),
      ).toMatchObject({ ok: false });
    }
  });
});

describe("the synthesized provider specs", () => {
  it("builds an oauth2-user spec that parses, round-trips and binds its resource and issuer", () => {
    const built = mcpOAuthProviderSpec({
      appId: "acme",
      name: "Acme",
      url: MCP,
      discovery,
      client: { hasSecret: true, inject: "basic" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec).toMatchObject({
      id: "acme-mcp",
      name: "Acme MCP server",
      docs: "https://mcp.example.com",
      hosts: ["mcp.example.com"],
      auth: {
        kind: "oauth2-user",
        authorizeUrl: `${ISSUER}/authorize`,
        tokenUrl: `${ISSUER}/token`,
        revokeUrl: `${ISSUER}/revoke`,
        clientId: "ACME_MCP_CLIENT_ID",
        clientSecret: "ACME_MCP_CLIENT_SECRET",
        inject: "basic",
        pkce: true,
        scopeSeparator: "space",
        resource: MCP,
        issuer: ISSUER,
        tolerated: ["mcp:read"],
      },
      tags: ["mcp"],
    });
    const parsed = parseProviderSpec(built.spec);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const capability = parsed.capability as OAuthClientCapability;
    expect(capability.flow).toMatchObject({ resource: MCP, issuer: ISSUER });
    expect(capability.api).toEqual(["mcp.example.com"]);
    // The spec round-trips through oauthSpecOf.
    expect(parseProviderSpec(oauthSpecOf("acme-mcp", capability))).toEqual(
      parsed,
    );
    // The binding key changes with the resource or the issuer.
    const moved = parseProviderSpec({
      ...built.spec,
      auth: {
        ...(built.spec["auth"] as object),
        issuer: "https://other.example.com",
      },
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(providerBindingKey(moved.capability)).not.toBe(
      providerBindingKey(capability),
    );
    // A registry serves it, with the row's own client settings.
    const registry = providerRegistry([{ id: "acme-mcp", spec: built.spec }]);
    expect(registry.rejected).toEqual([]);
    expect([...registry.settingNames()]).toEqual(
      expect.arrayContaining(["ACME_MCP_CLIENT_ID", "ACME_MCP_CLIENT_SECRET"]),
    );
  });

  it("builds a public client's spec with no scopes", () => {
    const built = mcpOAuthProviderSpec({
      appId: "acme",
      name: "A".repeat(80),
      url: MCP,
      discovery: { ...discovery, scopes: [], revocationEndpoint: undefined },
      client: { hasSecret: false, inject: "form" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec["auth"]).not.toHaveProperty("clientSecret");
    expect(built.spec["auth"]).not.toHaveProperty("revokeUrl");
    expect(parseProviderSpec(built.spec).ok).toBe(true);
  });

  it("builds an API-key spec for each static kind that parses", () => {
    const cases = [
      {
        kind: "bearer" as const,
        auth: { kind: "bearer", secret: "ACME_MCP_TOKEN" },
      },
      {
        kind: "bearer" as const,
        prefix: "Token",
        auth: { kind: "bearer", secret: "ACME_MCP_TOKEN", scheme: "Token" },
      },
      {
        kind: "header" as const,
        header: "X-Api-Key",
        prefix: "Key ",
        auth: {
          kind: "header",
          secret: "ACME_MCP_TOKEN",
          header: "X-Api-Key",
          prefix: "Key ",
        },
      },
      {
        kind: "query" as const,
        param: "api_key",
        auth: { kind: "query", secret: "ACME_MCP_TOKEN", param: "api_key" },
      },
      {
        kind: "basic" as const,
        auth: { kind: "basic", secret: "ACME_MCP_TOKEN", as: "pair" },
      },
    ];
    for (const { auth, ...given } of cases) {
      const built = mcpStaticProviderSpec({
        appId: "acme",
        name: "Acme",
        url: MCP,
        ...given,
      });
      expect(built, JSON.stringify(given)).toMatchObject({
        ok: true,
        spec: {
          id: "acme-mcp",
          name: "Acme MCP server",
          docs: "https://mcp.example.com",
          hosts: ["mcp.example.com"],
          auth,
          data: "per-call",
          tags: ["mcp"],
        },
      });
      if (!built.ok) continue;
      const parsed = parseProviderSpec(built.spec);
      expect(parsed.ok, JSON.stringify(given)).toBe(true);
      expect(
        providerRegistry([{ id: "acme-mcp", spec: built.spec }]).rejected,
      ).toEqual([]);
    }
  });

  it("refuses a header the transport sets, a query kind without its parameter, and http", () => {
    expect(
      mcpStaticProviderSpec({
        appId: "acme",
        name: "Acme",
        url: MCP,
        kind: "header",
        header: "Mcp-Session-Id",
      }),
    ).toMatchObject({ ok: false });
    expect(
      mcpStaticProviderSpec({
        appId: "acme",
        name: "Acme",
        url: MCP,
        kind: "query",
      }),
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/--param/) });
    expect(
      mcpStaticProviderSpec({
        appId: "acme",
        name: "Acme",
        url: "http://localhost:8787/mcp",
        kind: "bearer",
      }),
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/https/) });
  });
});
