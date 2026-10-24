import { describe, expect, it } from "vitest";
import { aiProviderSettings, DEV_AI_PROVIDERS } from "./aiProviders";
import { CAPABILITIES, capabilitySettings } from "./capabilities";
import {
  gatewaySettingOwner,
  gatewaySettingsFor,
  HOSTED_ONLY_GATEWAY_SETTINGS,
  isHostedOnlyGatewaySetting,
  isPlainGatewaySetting,
  PLAIN_GATEWAY_SETTINGS,
  INSTALL_OWNED_GATEWAY_SETTINGS,
  isInstallOwnedGatewaySetting,
  isReservedAppSecretName,
  isSettableGatewaySetting,
  SETTABLE_GATEWAY_SETTINGS,
} from "./gatewaySettings";

describe("the Gateway's settings", () => {
  it("are either settable or the install's, never both", () => {
    for (const name of SETTABLE_GATEWAY_SETTINGS) {
      expect(isSettableGatewaySetting(name)).toBe(true);
      expect(isInstallOwnedGatewaySetting(name), name).toBe(false);
    }
    for (const name of INSTALL_OWNED_GATEWAY_SETTINGS) {
      expect(isInstallOwnedGatewaySetting(name)).toBe(true);
      expect(isSettableGatewaySetting(name), name).toBe(false);
    }
    expect(new Set(SETTABLE_GATEWAY_SETTINGS).size).toBe(
      SETTABLE_GATEWAY_SETTINGS.length,
    );
  });

  it("cover every setting an AI provider or capability reads", () => {
    const known = (name: string) =>
      isSettableGatewaySetting(name) || isInstallOwnedGatewaySetting(name);
    for (const [provider, spec] of Object.entries(DEV_AI_PROVIDERS)) {
      expect(isSettableGatewaySetting(spec.keyEnv), provider).toBe(true);
      for (const setting of aiProviderSettings(spec)) {
        expect(known(setting), `${provider}: ${setting}`).toBe(true);
      }
    }
    for (const [id, capability] of Object.entries(CAPABILITIES)) {
      for (const setting of capabilitySettings(capability)) {
        expect(known(setting), `${id}: ${setting}`).toBe(true);
      }
    }
  });

  it("never include a name an app's deploy sets", () => {
    for (const name of SETTABLE_GATEWAY_SETTINGS) {
      expect(isReservedAppSecretName(name), name).toBe(false);
    }
  });
});

describe("isReservedAppSecretName", () => {
  it.each([
    "GATEWAY_URL",
    "gateway_url",
    "CF_VERSION_METADATA",
    "EVERYAPP_DEV",
    "EVERY_APP_ORG_ID",
    "every_app_org_id",
    "APP__every-todo",
  ])("refuses %s", (name) => {
    expect(isReservedAppSecretName(name)).toBe(true);
  });

  it.each(["GITHUB_TOKEN", "BETTER_AUTH_SECRET", "APP_SECRET", "EVERYAPPX"])(
    "lets %s through",
    (name) => {
      expect(isReservedAppSecretName(name)).toBe(false);
    },
  );
});

describe("gatewaySettingOwner", () => {
  it("names the provider or capability a setting belongs to", () => {
    expect(gatewaySettingOwner("OPENAI_API_KEY")).toEqual({
      kind: "provider",
      id: "openai",
    });
    expect(gatewaySettingOwner("DATAFORSEO_API_KEY")).toEqual({
      kind: "capability",
      id: "dataforseo",
    });
    expect(gatewaySettingOwner("LINKEDIN_CLIENT_SECRET")).toEqual({
      kind: "capability",
      id: "linkedin",
    });
    expect(gatewaySettingOwner("RESEND_API_KEY")).toEqual({
      kind: "capability",
      id: "email",
    });
  });

  it("has none for the Gateway's own switches", () => {
    for (const name of [
      "MCP_OAUTH_ENABLED",
      "CLOUDFLARE_ACCESS_AUD",
      "HOSTED_OPEN_SIGNUP",
    ]) {
      expect(gatewaySettingOwner(name), name).toBeNull();
    }
  });
});

describe("plain and hosted-only settings", () => {
  it("names only settable settings, and tells a credential from a plain value", () => {
    for (const name of [
      ...PLAIN_GATEWAY_SETTINGS,
      ...HOSTED_ONLY_GATEWAY_SETTINGS,
    ]) {
      expect(isSettableGatewaySetting(name), name).toBe(true);
    }
    expect(isPlainGatewaySetting("EMAIL_FROM")).toBe(true);
    expect(isPlainGatewaySetting("MCP_OAUTH_ENABLED")).toBe(true);
    expect(isPlainGatewaySetting("OPENAI_API_KEY")).toBe(false);
    expect(isPlainGatewaySetting("LINKEDIN_CLIENT_SECRET")).toBe(false);
    expect(isPlainGatewaySetting("CF_DEPLOY_TOKEN")).toBe(false);
    expect(isHostedOnlyGatewaySetting("THIRD_PARTY_DOMAIN")).toBe(true);
    // The browser deployer's token serves self-hosted installs too.
    expect(isHostedOnlyGatewaySetting("CF_DEPLOY_TOKEN")).toBe(false);
  });
});

describe("gatewaySettingsFor", () => {
  it("lists what the manifest's providers and capabilities read, in order, once, required first where both say so", () => {
    expect(
      gatewaySettingsFor({
        providers: ["workers-ai", "openai"],
        capabilities: {
          email: { access: "write" },
          mastodon: { access: "write" },
          dataforseo: { access: "read" },
        },
        ai: { routes: ["/v1/files"] },
      }),
    ).toEqual([
      // Workers AI's CLOUDFLARE_ACCOUNT_ID is the install's: left out.
      { name: "WORKERS_AI_API_TOKEN", required: true },
      { name: "OPENAI_API_KEY", required: true },
      { name: "EMAIL_FROM", required: true },
      // The sender's display name, another transport, and the provider
      // choice: the Gateway sends through its EMAIL binding without them.
      { name: "EMAIL_FROM_NAME", required: false },
      { name: "EMAIL_REST_API_TOKEN", required: false },
      { name: "RESEND_API_KEY", required: false },
      { name: "EMAIL_PROVIDER", required: false },
      { name: "MASTODON_CLIENT_ID", required: true },
      { name: "MASTODON_CLIENT_SECRET", required: true },
      // The instance has a default.
      { name: "MASTODON_URL", required: false },
      { name: "DATAFORSEO_API_KEY", required: true },
      { name: "AI_PROXY_EXTRA_ROUTES", required: true },
    ]);
  });

  it("is empty for a manifest that uses nothing, or names what the gateway doesn't offer", () => {
    expect(gatewaySettingsFor({})).toEqual([]);
    expect(
      gatewaySettingsFor({
        providers: ["anthropic"],
        capabilities: { github: { access: "read" } },
        ai: { routes: [] },
      }),
    ).toEqual([]);
  });
});
