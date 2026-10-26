import { describe, expect, it } from "vitest";
import { aiProviderSettings, DEV_AI_PROVIDERS } from "./aiProviders";
import { CAPABILITIES, capabilitySettings } from "./capabilities";
import { EVENTS_ALLOW_PRIVATE_TARGETS_SETTING } from "./events";
import {
  gatewaySettingOwner,
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
import { rowSecretProblem } from "./providerRegistry";
import {
  isSignInSettingName,
  SIGN_IN_GATEWAY_SETTINGS,
} from "./signInProviders";

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

  it("makes every sign-in setting settable and keeps the family from apps and rows", () => {
    for (const name of SIGN_IN_GATEWAY_SETTINGS) {
      expect(isSettableGatewaySetting(name), name).toBe(true);
      expect(isSignInSettingName(name), name).toBe(true);
      expect(isInstallOwnedGatewaySetting(name), name).toBe(false);
    }
    expect(isPlainGatewaySetting("GOOGLE_SIGNIN_CLIENT_ID")).toBe(true);
    expect(isPlainGatewaySetting("OIDC_SIGNIN_ISSUER")).toBe(true);
    expect(isPlainGatewaySetting("GOOGLE_SIGNIN_CLIENT_SECRET")).toBe(false);
    // The family covers names no catalog entry reads yet, so a registered
    // row (rowSecretProblem) and a manifest can never take one.
    expect(isSignInSettingName("OKTA_SIGNIN_CLIENT_ID")).toBe(true);
    expect(isSignInSettingName("GOOGLE_WORKSPACE_CLIENT_ID")).toBe(false);
    expect(isSignInSettingName("GOOGLE_SIGNIN_API_KEY")).toBe(false);
    expect(
      rowSecretProblem("google", "GOOGLE_SIGNIN_CLIENT_SECRET", () => false),
    ).toContain("sign-in provider's setting name");
    expect(
      rowSecretProblem("okta", "OKTA_SIGNIN_CLIENT_ID", () => false),
    ).toContain("sign-in provider's setting name");
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
    expect(gatewaySettingOwner("SLACK_CLIENT_SECRET")).toEqual({
      kind: "capability",
      id: "slack",
    });
    // A preset's names are no one's until a row holds them.
    expect(gatewaySettingOwner("LINKEDIN_CLIENT_SECRET")).toBeNull();
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
      "EVENTS_ALLOW_PRIVATE_TARGETS",
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
    expect(isPlainGatewaySetting("SLACK_CLIENT_SECRET")).toBe(false);
    expect(isPlainGatewaySetting("CF_DEPLOY_TOKEN")).toBe(false);
    // The event bus's switch is set with `everyapp secret set` and shown as typed.
    expect(isSettableGatewaySetting(EVENTS_ALLOW_PRIVATE_TARGETS_SETTING)).toBe(
      true,
    );
    expect(isPlainGatewaySetting(EVENTS_ALLOW_PRIVATE_TARGETS_SETTING)).toBe(
      true,
    );
    expect(isHostedOnlyGatewaySetting("THIRD_PARTY_DOMAIN")).toBe(true);
    // The browser deployer's token serves self-hosted installs too.
    expect(isHostedOnlyGatewaySetting("CF_DEPLOY_TOKEN")).toBe(false);
  });
});
