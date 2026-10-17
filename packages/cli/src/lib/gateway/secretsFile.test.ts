import { describe, expect, it } from "vitest";
import {
  aiProviderSettings,
  CAPABILITIES,
  capabilitySettings,
  DEV_AI_PROVIDERS,
} from "@every-app/sdk/internal";
import { assertSettableSecret, newGatewaySecrets } from "./secretsFile";

describe("gateway settings `secret set --for gateway` changes", () => {
  it.each([
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "WORKERS_AI_API_TOKEN",
    "DATAFORSEO_API_KEY",
    "CONTEXT_API_KEY",
  ])("include the provider key %s", (name) => {
    expect(() => assertSettableSecret(name)).not.toThrow();
  });

  it("include every AI provider's and capability's key, and the install sets the rest", () => {
    const { secrets } = newGatewaySecrets({
      gatewayUrl: "https://gateway.example.com",
      accountId: "acc123",
      deploymentMode: "self_hosted",
    });
    for (const spec of Object.values(DEV_AI_PROVIDERS)) {
      expect(() => assertSettableSecret(spec.keyEnv)).not.toThrow();
      // Workers AI's account is the gateway's own, set at install.
      for (const setting of aiProviderSettings(spec).slice(1)) {
        expect(secrets[setting], setting).toBeDefined();
      }
    }
    for (const capability of Object.values(CAPABILITIES)) {
      if (capability.mode === "api_key") {
        expect(() => assertSettableSecret(capability.secret)).not.toThrow();
        continue;
      }
      // An OAuth client's id, secret and instance are all the operator's.
      if (capability.mode === "oauth_client") {
        for (const setting of capabilitySettings(capability)) {
          expect(() => assertSettableSecret(setting), setting).not.toThrow();
        }
        continue;
      }
      // A service's sender is the operator's; its REST transport's account
      // is the gateway's own, set at install.
      for (const setting of capability.settings) {
        expect(() => assertSettableSecret(setting), setting).not.toThrow();
      }
      for (const setting of capability.optionalSettings) {
        let settable = true;
        try {
          assertSettableSecret(setting);
        } catch {
          settable = false;
        }
        expect(settable || secrets[setting] !== undefined, setting).toBe(true);
      }
    }
  });

  it("include the 33 names of the 16 OAuth clients", () => {
    const names = Object.values(CAPABILITIES).flatMap((capability) =>
      capability.mode === "oauth_client" ? capabilitySettings(capability) : [],
    );
    expect(names).toHaveLength(33);
    expect(new Set(names).size).toBe(33);
    for (const name of names) {
      expect(() => assertSettableSecret(name), name).not.toThrow();
    }
    expect(names).toEqual(
      expect.arrayContaining([
        "LINKEDIN_CLIENT_ID",
        "LINKEDIN_CLIENT_SECRET",
        "FACEBOOK_APP_ID",
        "SLACK_CLIENT_ID",
        "KICK_CLIENT_SECRET",
        "MASTODON_URL",
      ]),
    );
  });

  it.each(["CF_DEPLOY_TOKEN", "DISPATCH_NAMESPACE", "THIRD_PARTY_DOMAIN"])(
    "include the deployer's setting %s",
    (name) => {
      expect(() => assertSettableSecret(name)).not.toThrow();
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
      expect(() => assertSettableSecret(name)).toThrow(
        expect.objectContaining({ code: "SECRET_NOT_SETTABLE" }),
      );
    },
  );
});
