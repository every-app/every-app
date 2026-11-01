import { describe, expect, it, vi } from "vitest";
import {
  aiProviderSettings,
  CAPABILITIES,
  capabilitySettings,
  DEV_AI_PROVIDERS,
  SETTABLE_GATEWAY_SETTINGS,
} from "@every-app/sdk/internal";
import { OPTIONAL_SECRETS } from "../cloudflare.config";

// The config's Worker entrypoint import; only its settings list matters here.
vi.mock("./server.ts", () => ({}));

/**
 * In dev the gateway Worker sees a setting only when cloudflare.config.ts
 * declares it, so a provider or capability whose setting is missing from
 * OPTIONAL_SECRETS answers "not configured" under `cf dev` however
 * .dev.vars is filled in.
 */
describe("OPTIONAL_SECRETS", () => {
  const declared = new Set<string>(OPTIONAL_SECRETS);

  it("declares every setting `everyapp secret set` changes on a deployed gateway", () => {
    for (const setting of SETTABLE_GATEWAY_SETTINGS) {
      expect(declared.has(setting), setting).toBe(true);
    }
  });

  it("declares every setting of every AI provider", () => {
    for (const [provider, spec] of Object.entries(DEV_AI_PROVIDERS)) {
      for (const setting of aiProviderSettings(spec)) {
        expect(declared.has(setting), `${provider}: ${setting}`).toBe(true);
      }
    }
  });

  it("declares every capability's key and settings", () => {
    for (const [id, capability] of Object.entries(CAPABILITIES)) {
      // A kind's settings (email's sender and REST transport), and any
      // string field naming one (`secret`, `...Setting`).
      const settings = [
        ...capabilitySettings(capability),
        ...Object.entries(capability)
          .filter(
            ([field, value]) =>
              typeof value === "string" &&
              (field === "secret" || field.endsWith("Setting")),
          )
          .map(([, value]) => value as string),
      ];
      // Only a service the gateway runs from its own data (members) holds
      // no setting; a credential-holding kind always names one.
      if (capability.mode !== "service") {
        expect(settings.length, id).toBeGreaterThan(0);
      }
      for (const setting of settings) {
        expect(declared.has(setting), `${id}: ${setting}`).toBe(true);
      }
    }
  });
});
