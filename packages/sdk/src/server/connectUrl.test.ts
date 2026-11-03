/**
 * `connectUrl()`, and the local-dev twin for a provider registered on the
 * gateway (a preset's spec in `.everyapp/providers`). The built-in
 * providers' dev twin is in integrationFetch.test.ts.
 */
import { afterEach, describe, expect, vi } from "vitest";
import { it } from "../../test/inOrganization";
import { OAUTH_PRESETS } from "../internal/index.js";
import { connectPath, connectUrl } from "./connectUrl.js";
import {
  devAccessTokenName,
  integrationFetch,
  integrationStatus,
} from "./integrationFetch.js";
import { gatewayRefusal } from "./refusal.js";

describe("connectUrl", () => {
  const env = {
    GATEWAY_URL: "https://apps.example.com/some/path",
    EVERYAPP_APP_ID: "openmail",
  };

  it("builds the Gateway's connect URL for this app from GATEWAY_URL and the app id", () => {
    expect(connectPath("github-oauth")).toBe("/connect/github-oauth");
    expect(connectUrl({ env, provider: "google-workspace" })).toBe(
      "https://apps.example.com/connect/google-workspace?app=openmail",
    );
    expect(
      connectUrl({
        env,
        provider: "google-workspace",
        returnTo: "https://openmail.apps.example.com/settings?tab=google",
      }),
    ).toBe(
      "https://apps.example.com/connect/google-workspace?app=openmail&return=https%3A%2F%2Fopenmail.apps.example.com%2Fsettings%3Ftab%3Dgoogle",
    );
    expect(connectUrl({ env, provider: "a b" })).toBe(
      "https://apps.example.com/connect/a%20b?app=openmail",
    );
  });

  it("needs GATEWAY_URL and the app id", () => {
    expect(() =>
      connectUrl({ env: { EVERYAPP_APP_ID: "openmail" }, provider: "slack" }),
    ).toThrow(/GATEWAY_URL/);
    expect(() =>
      connectUrl({
        env: { GATEWAY_URL: "nope", EVERYAPP_APP_ID: "openmail" },
        provider: "slack",
      }),
    ).toThrow(/isn't a URL/);
    expect(() =>
      connectUrl({
        env: { GATEWAY_URL: "https://apps.example.com", EVERYAPP_APP_ID: " " },
        provider: "slack",
      }),
    ).toThrow(/EVERYAPP_APP_ID/);
  });
});

describe("a registered OAuth provider in local dev", () => {
  afterEach(() => vi.unstubAllGlobals());

  const files = [
    {
      file: ".everyapp/providers/github-oauth.json",
      spec: OAUTH_PRESETS["github-oauth"],
    },
  ];
  const env = (extra: Record<string, string> = {}) => ({
    EVERYAPP_DEV: "1",
    EVERYAPP_APP_ID: "agent",
    EVERYAPP_DEV_PROVIDERS: JSON.stringify(files),
    EVERYAPP_DEV_CAPABILITIES: JSON.stringify({
      "github-oauth": { scopes: ["repo"], why: "Reads issues." },
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

  it("puts the developer's token on any method to the spec's hosts, and only those", async () => {
    const sent = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ number: 1 }),
    );
    vi.stubGlobal("fetch", sent);
    const github = integrationFetch({
      env: env({ GITHUB_OAUTH_ACCESS_TOKEN: "gho_dev" }),
      provider: "github-oauth",
    });
    const response = await github("https://api.github.com/repos/a/b/issues", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    const request = sent.mock.calls[0]![0];
    expect(request.headers.get("authorization")).toBe("Bearer gho_dev");
    await expect(
      github("https://github.com/login/oauth/access_token", { method: "POST" }),
    ).rejects.toThrow(/only reaches api\.github\.com/);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("answers not connected without a token, and reports the status", async () => {
    const github = integrationFetch({ env: env(), provider: "github-oauth" });
    const refused = await github("https://api.github.com/user");
    expect(refused.status).toBe(409);
    await expect(gatewayRefusal(refused)).resolves.toMatchObject({
      code: "integration_not_connected",
    });
    await expect(
      integrationStatus({ env: env(), provider: "github-oauth" }),
    ).resolves.toMatchObject({
      requested: true,
      configured: false,
      ready: false,
      scopes: ["repo"],
      connectPath: "/connect/github-oauth?app=agent",
      connection: null,
      settings: ["GITHUB_OAUTH_ACCESS_TOKEN"],
    });
    await expect(
      integrationStatus({
        env: env({ GITHUB_OAUTH_ACCESS_TOKEN: "gho_dev" }),
        provider: "github-oauth",
      }),
    ).resolves.toMatchObject({
      ready: true,
      connection: { label: null, scopes: ["repo"], ready: true },
    });
  });
});
