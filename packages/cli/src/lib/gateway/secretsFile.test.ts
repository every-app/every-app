import { describe, expect, it } from "vitest";
import {
  aiProviderSettings,
  CAPABILITIES,
  capabilitySettings,
  DEV_AI_PROVIDERS,
  isSettableGatewaySetting,
} from "@every-app/sdk/internal";
import { newGatewaySecrets } from "./secretsFile";

/** What `everyapp secret set <NAME>` changes on the Gateway, against what the install sets. */
describe("gateway settings `secret set` changes", () => {
  it.each([
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "WORKERS_AI_API_TOKEN",
    "DATAFORSEO_API_KEY",
    "CONTEXT_API_KEY",
  ])("include the provider key %s", (name) => {
    expect(isSettableGatewaySetting(name)).toBe(true);
  });

  it("include every AI provider's and capability's key, and the install sets the rest", () => {
    const { secrets } = newGatewaySecrets({
      gatewayUrl: "https://gateway.example.com",
      accountId: "acc123",
      deploymentMode: "self_hosted",
    });
    for (const spec of Object.values(DEV_AI_PROVIDERS)) {
      expect(isSettableGatewaySetting(spec.keyEnv)).toBe(true);
      // Workers AI's account is the gateway's own, set at install.
      for (const setting of aiProviderSettings(spec).slice(1)) {
        expect(secrets[setting], setting).toBeDefined();
      }
    }
    for (const capability of Object.values(CAPABILITIES)) {
      if (capability.mode === "api_key" || capability.mode === "ai") {
        expect(isSettableGatewaySetting(capability.auth.secret)).toBe(true);
        continue;
      }
      // An OAuth client's id, secret and instance are all the operator's.
      if (capability.mode === "oauth_client") {
        for (const setting of capabilitySettings(capability)) {
          expect(isSettableGatewaySetting(setting), setting).toBe(true);
        }
        continue;
      }
      // A service's sender is the operator's; its REST transport's account
      // is the gateway's own, set at install.
      for (const setting of capability.settings) {
        expect(isSettableGatewaySetting(setting), setting).toBe(true);
      }
      for (const setting of capability.optionalSettings) {
        expect(
          isSettableGatewaySetting(setting) || secrets[setting] !== undefined,
          setting,
        ).toBe(true);
      }
    }
  });

  it("include the 6 names of the 3 OAuth clients, and no preset's", () => {
    const names = Object.values(CAPABILITIES).flatMap((capability) =>
      capability.mode === "oauth_client" ? capabilitySettings(capability) : [],
    );
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6);
    for (const name of names) {
      expect(isSettableGatewaySetting(name), name).toBe(true);
    }
    expect(names).toEqual(
      expect.arrayContaining([
        "SLACK_CLIENT_ID",
        "GOOGLE_WORKSPACE_CLIENT_SECRET",
        "MICROSOFT_365_CLIENT_ID",
      ]),
    );
    for (const name of ["LINKEDIN_CLIENT_ID", "FACEBOOK_APP_ID", "MASTODON_URL"]) {
      expect(isSettableGatewaySetting(name), name).toBe(false);
    }
  });

  it.each(["CF_DEPLOY_TOKEN", "DISPATCH_NAMESPACE", "THIRD_PARTY_DOMAIN"])(
    "include the deployer's setting %s",
    (name) => {
      expect(isSettableGatewaySetting(name)).toBe(true);
    },
  );

  it.each([
    "JWT_PRIVATE_KEY",
    "BETTER_AUTH_SECRET",
    "GATEWAY_DEPLOYMENT_MODE",
    "CLOUDFLARE_ACCOUNT_ID",
    // The launch gate opens by hand only.
    "THIRD_PARTY_DEPLOYS",
  ])(
    "never include %s, which the install owns",
    (name) => {
      expect(isSettableGatewaySetting(name)).toBe(false);
    },
  );
});
