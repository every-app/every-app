import { describe, expect, it } from "vitest";
import {
  aiProviderSettings,
  CAPABILITIES,
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
    for (const { secret } of Object.values(CAPABILITIES)) {
      expect(() => assertSettableSecret(secret)).not.toThrow();
    }
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
