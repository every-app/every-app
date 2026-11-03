/**
 * A registered OAuth provider (`auth.kind: "oauth2-user"`) through the
 * capability proxy: its client counts only while the row still has the
 * endpoints, hosts and setting names the client was set for
 * (`oauth.client-bound-to-endpoints`), as an API-key row's key is
 * (`providers.value-bound-to-hosts`). The status never shows the client
 * id, and nothing is sent upstream from here.
 */
import { describe, expect, it } from "vitest";
import {
  OAUTH_PRESETS,
  parseProviderSpec,
  providerBindingKey,
  providerRegistry,
} from "@every-app/sdk/internal";
import { handleIntegrationProxyRequest } from "./integration-proxy";

const ORIGIN = "http://every-app-gateway.internal";
const GITHUB = OAUTH_PRESETS["github-oauth"]!;
const parsed = parseProviderSpec(GITHUB);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
const KEY = providerBindingKey(parsed.capability);

const ENV = {
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  GITHUB_OAUTH_CLIENT_ID: "gh-id",
  GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
};

async function call(
  registry: ReturnType<typeof providerRegistry>,
  path: string,
  method = "POST",
) {
  const captured: Request[] = [];
  const response = await handleIntegrationProxyRequest({
    request: new Request(`${ORIGIN}${path}`, {
      method,
      headers:
        method === "POST"
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {},
      ...(method === "POST"
        ? { body: "grant_type=authorization_code&code=c&redirect_uri=r" }
        : {}),
    }),
    capabilities: {
      "github-oauth": {
        scopes: ["repo"],
        why: "Reads the person's repositories.",
      },
    },
    lookup: registry,
    env: ENV,
    admit: async () => ({
      caller: {
        organizationId: "org-1",
        appId: "app",
        worker: "every-app",
        orgSource: "props",
      },
      user: null,
    }),
    fetchUpstream: async (request) => {
      captured.push(request);
      return Response.json({ access_token: "t", scope: "repo" });
    },
    listMembers: async () => {
      throw new Error("not a service");
    },
  });
  return { response, upstream: captured[0] };
}

describe("a registered OAuth provider's client", () => {
  const api = "/api/integrations/github-oauth/api.github.com/user";

  it("reads as configured while the row is bound, and the status never shows the client", async () => {
    const registry = providerRegistry([
      { id: "github-oauth", spec: GITHUB, boundTo: KEY },
    ]);
    const status = await call(
      registry,
      "/api/integrations/github-oauth",
      "GET",
    );
    const answer = (await status.response.json()) as Record<string, unknown>;
    expect(answer).toMatchObject({ requested: true, configured: true });
    expect(answer.clientId).toBeUndefined();
    expect(status.upstream).toBeUndefined();
  });

  it("reads as unset once the row's endpoints changed, and never calls out", async () => {
    // The same row with its token URL re-pointed: the key the client was
    // set for no longer matches, so the client reads as unset.
    const moved = {
      ...GITHUB,
      auth: {
        ...(GITHUB["auth"] as object),
        tokenUrl: "https://github.com/login/oauth/elsewhere",
      },
    };
    const registry = providerRegistry([
      { id: "github-oauth", spec: moved, boundTo: KEY },
    ]);
    expect(registry.bound("github-oauth")).toBe(false);
    const status = await call(
      registry,
      "/api/integrations/github-oauth",
      "GET",
    );
    const answer = (await status.response.json()) as Record<string, unknown>;
    expect(answer).toMatchObject({
      requested: true,
      configured: false,
      ready: false,
    });
    expect(answer.clientId).toBeUndefined();
    // Never bound at all: the same.
    const fresh = providerRegistry([{ id: "github-oauth", spec: GITHUB }]);
    const unbound = await call(fresh, "/api/integrations/github-oauth", "GET");
    expect(await unbound.response.json()).toMatchObject({ configured: false });
    // An API call with no connection store behind it is refused before
    // anything leaves the gateway.
    const refused = await call(registry, api);
    expect(refused.response.status).toBe(503);
    expect(await refused.response.json()).toMatchObject({
      code: "integration_not_configured",
    });
    expect(refused.upstream).toBeUndefined();
  });
});
