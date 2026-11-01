import { describe, expect, it } from "vitest";
import { assertAppSecretName } from "./secrets";

describe("assertAppSecretName", () => {
  it("takes an app's own secret names", () => {
    for (const name of ["GITHUB_TOKEN", "STRIPE_KEY", "openai_key", "_X"]) {
      expect(() => assertAppSecretName(name), name).not.toThrow();
    }
  });

  it("refuses names the deploy sets, and the platform's namespaces", () => {
    for (const name of [
      "GATEWAY_URL",
      "EVERY_APP_ORG_ID",
      "EVERY_APP_GATEWAY",
      "EVERYAPP_IDENTITY_PUBLIC_KEYS",
      "EVERYAPP_DEV",
      "everyapp_app_id",
      "APP__every_acme_notes",
      "CF_VERSION_METADATA",
    ]) {
      expect(() => assertAppSecretName(name), name).toThrow(
        expect.objectContaining({ code: "SECRET_NAME_RESERVED" }),
      );
    }
  });

  it("refuses names a Worker binding can't have", () => {
    for (const name of ["", "1TOKEN", "GITHUB-TOKEN", "A B", "TOKEN="]) {
      expect(() => assertAppSecretName(name), name).toThrow(
        expect.objectContaining({ code: "SECRET_NAME_INVALID" }),
      );
    }
  });
});
