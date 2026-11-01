/**
 * A registered OAuth provider (`auth.kind: "oauth2-user"`) through the
 * capability proxy's token-endpoint branch: its client is read only while
 * the row still has the endpoints, hosts and setting names the client
 * was set for (`oauth.client-bound-to-endpoints`), as an API-key row's
 * key is (`providers.value-bound-to-hosts`). An unbound row never sends
 * the client anywhere, and its status hides the client id.
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
      "github-oauth": { access: "write", scopes: ["repo.read"] },
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
  const token =
    "/api/integrations/github-oauth/github.com/login/oauth/access_token";

  it("completes a token call while the row is bound, with the client on the request", async () => {
    const registry = providerRegistry([
      { id: "github-oauth", spec: GITHUB, boundTo: KEY },
    ]);
    const { response, upstream } = await call(registry, token);
    expect(response.status).toBe(200);
    expect(upstream?.url).toBe("https://github.com/login/oauth/access_token");
    const body = new URLSearchParams(await upstream!.text());
    expect(body.get("client_id")).toBe("gh-id");
    expect(body.get("client_secret")).toBe("gh-secret");
    const status = await call(
      registry,
      "/api/integrations/github-oauth",
      "GET",
    );
    expect(await status.response.json()).toMatchObject({
      configured: true,
      ready: true,
      clientId: "gh-id",
    });
  });

  it("never sends the client once the row's endpoints changed, and the status hides it", async () => {
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
    const { response, upstream } = await call(
      registry,
      "/api/integrations/github-oauth/github.com/login/oauth/elsewhere",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "integration_not_configured",
    });
    expect(upstream).toBeUndefined();
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
    const unbound = await call(fresh, token);
    expect(unbound.response.status).toBe(503);
    expect(unbound.upstream).toBeUndefined();
  });
});
