/**
 * `connectUrl()` and the local-dev twin of the Gateway's held-token
 * branch (docs/design/2026-10-oauth-providers.md sections 5 and 7).
 */
import { afterEach, describe, expect, vi } from "vitest";
import { it } from "../../test/inOrganization";
import { ACCOUNT_HEADER, OAUTH_PRESETS } from "../internal/index.js";
import { connectPath, connectUrl } from "./connectUrl.js";
import {
  devAccessTokenName,
  gatewayRefusal,
  integrationFetch,
  integrationStatus,
} from "./integrationFetch.js";

describe("connectUrl", () => {
  it("builds the Gateway's connect URL from GATEWAY_URL", () => {
    expect(connectPath("github-oauth")).toBe("/connect/github-oauth");
    expect(
      connectUrl({
        env: { GATEWAY_URL: "https://apps.example.com/" },
        provider: "google-workspace",
      }),
    ).toBe("https://apps.example.com/connect/google-workspace");
    expect(
      connectUrl({
        env: { GATEWAY_URL: "https://apps.example.com" },
        provider: "github-oauth",
        returnTo: "https://seo.apps.example.com/settings?tab=google",
        account: "organization",
        sets: ["identity", "repo.read"],
      }),
    ).toBe(
      "https://apps.example.com/connect/github-oauth?return=https%3A%2F%2Fseo.apps.example.com%2Fsettings%3Ftab%3Dgoogle&account=organization&sets=identity%2Crepo.read",
    );
  });

  it("needs GATEWAY_URL", () => {
    expect(() => connectUrl({ env: {}, provider: "github-oauth" })).toThrow(
      /GATEWAY_URL/,
    );
    expect(() =>
      connectUrl({ env: { GATEWAY_URL: "nope" }, provider: "github-oauth" }),
    ).toThrow(/isn't a URL/);
  });
});

describe("the held-token twin in local dev", () => {
  afterEach(() => vi.unstubAllGlobals());

  const files = [
    {
      file: ".everyapp/providers/github-oauth.json",
      spec: OAUTH_PRESETS["github-oauth"],
    },
  ];
  const env = (extra: Record<string, string> = {}) => ({
    EVERYAPP_DEV: "1",
    EVERYAPP_DEV_PROVIDERS: JSON.stringify(files),
    EVERYAPP_DEV_CAPABILITIES: JSON.stringify({
      "github-oauth": { access: "read", scopes: ["repo.read"] },
    }),
    ...extra,
  });

  it("names the dev token after the provider", () => {
    expect(devAccessTokenName("github-oauth")).toBe(
      "GITHUB_OAUTH_ACCESS_TOKEN",
    );
    expect(devAccessTokenName("google-workspace")).toBe(
      "GOOGLE_WORKSPACE_ACCESS_TOKEN",
    );
  });

  it("puts the developer's token on an allowed call and strips the app's own authorization", async () => {
    const sent = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ login: "ben" }),
    );
    vi.stubGlobal("fetch", sent);
    const fetchGitHub = integrationFetch({
      env: env({ GITHUB_OAUTH_ACCESS_TOKEN: "gho_dev" }),
      provider: "github-oauth",
      account: "organization",
    });
    const response = await fetchGitHub(
      "https://api.github.com/user/repos?token=x",
      {
        headers: {
          authorization: "Bearer mine",
          "x-http-method-override": "DELETE",
        },
      },
    );
    expect(response.status).toBe(200);
    const request = sent.mock.calls[0]![0];
    expect(request.url).toBe("https://api.github.com/user/repos");
    expect(request.headers.get("authorization")).toBe("Bearer gho_dev");
    expect(request.headers.get("x-http-method-override")).toBeNull();
    // The twin calls the provider itself: the account header is a gateway matter.
    expect(request.headers.get(ACCOUNT_HEADER)).toBeNull();
    expect(request.redirect).toBe("manual");
  });

  it("answers the Gateway's refusals: not connected, outside the declared sets, a write on a read grant", async () => {
    const sent = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({}),
    );
    vi.stubGlobal("fetch", sent);
    const noToken = integrationFetch({ env: env(), provider: "github-oauth" });
    const notConnected = await noToken("https://api.github.com/user");
    expect(notConnected.status).toBe(409);
    await expect(notConnected.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      connectPath: "/connect/github-oauth",
      reconnect: false,
    });
    const withToken = integrationFetch({
      env: env({ GITHUB_OAUTH_ACCESS_TOKEN: "gho_dev" }),
      provider: "github-oauth",
    });
    await expect(
      gatewayRefusal(await withToken("https://api.github.com/batch/x")),
    ).resolves.toMatchObject({ code: "integration_scope_not_allowed" });
    await expect(
      gatewayRefusal(
        await withToken("https://api.github.com/repos/a/b/issues", {
          method: "POST",
          body: "{}",
        }),
      ),
    ).resolves.toMatchObject({ code: "integration_method_not_allowed" });
    expect(sent).not.toHaveBeenCalled();
    // A token endpoint stays the app-driven call, and needs the client.
    expect(() =>
      withToken("https://github.com/login/oauth/access_token", {
        method: "POST",
      }),
    ).rejects.toThrow(/token endpoints need the client/);
  });

  it("reports the flow, the connect path and the dev connection in the status", async () => {
    await expect(
      integrationStatus({ env: env(), provider: "github-oauth" }),
    ).resolves.toMatchObject({
      requested: true,
      configured: false,
      ready: false,
      flow: "both",
      connectPath: "/connect/github-oauth",
      connection: null,
    });
    await expect(
      integrationStatus({
        env: env({ GITHUB_OAUTH_ACCESS_TOKEN: "gho_dev" }),
        provider: "github-oauth",
      }),
    ).resolves.toMatchObject({
      ready: true,
      scopeSets: ["repo.read"],
      scopes: ["repo"],
      connection: {
        account: "user",
        label: "GITHUB_OAUTH_ACCESS_TOKEN",
        scopeSets: ["repo.read"],
        ready: true,
      },
    });
    // A catalog client without a flow says so.
    await expect(
      integrationStatus({
        env: {
          EVERYAPP_DEV: "1",
          LINKEDIN_CLIENT_ID: "id",
          LINKEDIN_CLIENT_SECRET: "secret",
        },
        provider: "linkedin",
      }),
    ).resolves.toMatchObject({ flow: "app" });
  });
});
