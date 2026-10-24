/**
 * The Gateway settings an app reads from `.dev.vars` in place of the
 * Gateway: what `everyapp dev` checks the file for. Built from the same
 * provider and capability tables the Gateway's own view reads
 * (`gatewaySettings.ts`), with one difference: a service's `settings` are
 * optional here, since the SDK's stand-ins work without them. Kept in its
 * own file so the Gateway's registry can change on its own.
 */
import { aiProviderSettings, devAiProvider } from "./aiProviders.js";
import {
  CAPABILITIES,
  isCapabilityId,
  type Capability,
} from "./capabilities.js";

/** One name an app reads from `.dev.vars` in place of the Gateway, and whether it can do without. */
export interface DevGatewaySettingNeed {
  name: string;
  /**
   * Required: what the SDK's local-dev fallback can't call without, so
   * the app answers that it isn't set up. An AI provider's settings (its
   * key, and Workers AI's CLOUDFLARE_ACCOUNT_ID), an `api_key`
   * capability's key, an OAuth client's id and secret, and its host
   * setting when the provider has no default origin. Optional: a
   * service's settings, which its stand-in does without (`sendEmail()`
   * prints until EMAIL_FROM and a transport are set; `listMembers()`
   * answers from the dev identity), and a host setting with a default.
   */
  required: boolean;
}

/**
 * The Gateway settings an app reads from `.dev.vars` in place of the
 * Gateway (the SDK's local-dev fallback; `cloudflare/worker.ts` declares
 * the same names from its own copy of the tables, which a test keeps in
 * step): the keys of its AI `providers` with what their URLs need, and the
 * keys, clients, senders and transports of its `capabilities`; in the
 * manifest's order, each once (required wins). A provider entry is its id,
 * or an object naming it. What `everyapp dev` checks the file for. An
 * unknown provider or capability contributes nothing.
 */
export function devGatewaySettingsFor(manifest: {
  readonly providers?: ReadonlyArray<string | { readonly id: string }>;
  readonly capabilities?: { readonly [id: string]: unknown };
}): DevGatewaySettingNeed[] {
  const needs: DevGatewaySettingNeed[] = [];
  for (const entry of manifest.providers ?? []) {
    const spec = devAiProvider(typeof entry === "string" ? entry : entry.id);
    if (!spec) continue;
    for (const name of aiProviderSettings(spec))
      needs.push({ name, required: true });
  }
  for (const id of Object.keys(manifest.capabilities ?? {})) {
    if (!isCapabilityId(id)) continue;
    const capability: Capability = CAPABILITIES[id];
    switch (capability.mode) {
      case "api_key":
        needs.push({ name: capability.secret, required: true });
        break;
      case "service":
        // The stand-ins do without a service's settings and its transports.
        for (const name of [
          ...capability.settings,
          ...capability.optionalSettings,
        ]) {
          needs.push({ name, required: false });
        }
        break;
      case "oauth_client":
        needs.push({ name: capability.secrets.clientId, required: true });
        if (capability.secrets.clientSecret) {
          needs.push({ name: capability.secrets.clientSecret, required: true });
        }
        if (capability.hostSetting) {
          needs.push({
            name: capability.hostSetting,
            required: !capability.defaultOrigin,
          });
        }
        break;
    }
  }
  const byName = new Map<string, DevGatewaySettingNeed>();
  for (const need of needs) {
    const seen = byName.get(need.name);
    if (seen) seen.required ||= need.required;
    else byName.set(need.name, { ...need });
  }
  return [...byName.values()];
}
