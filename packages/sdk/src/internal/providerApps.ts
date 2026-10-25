/**
 * Provider apps, "MCP apps" to the person: a data provider (DataForSEO
 * today) offered to members as an app of the Gateway's own, with no page
 * and no Worker to deploy. The operator turns it on (`everyapp mcp on
 * <id>`) and sets the provider's key as a Gateway setting; the Gateway then
 * serves the provider's tools on its `/mcp` under `<id>_<tool>` names, with
 * the key never leaving the Gateway, every call attributed to the member
 * who made it, counted and audited like an app's capability calls. The
 * launcher lists it under "MCP apps" and its card opens the "Use it from
 * your agent" dialog instead of a page (docs/design/2026-10-mcp-apps-ui.md).
 *
 * A provider app is an `apps` row of tier {@link PROVIDER_APP_TIER} with no
 * hostname and no Worker name: the perimeter never routes it, and the
 * Gateway reaches its tools in-process rather than over a service binding.
 * Its manifest is generated here, so the settings model
 * (./appSettings.ts) reads the provider's key as a required Gateway setting
 * like any app's capability. The registry rules that write the row are in
 * `@every-app/perimeter/registry` (providerApps.ts); the Gateway serves it
 * from `apps/every-app-gateway/src/server/provider-apps/`.
 */
import {
  CAPABILITIES,
  authSettingNames,
  type ApiKeyCapabilityId,
} from "./capabilities.js";

/** The `apps.tier` of a provider app: no Worker, served by the Gateway itself. */
export const PROVIDER_APP_TIER = "provider";

export interface ProviderAppDefinition {
  /** The app id (its slug and tool-name prefix): lowercase, no underscore. */
  id: string;
  /** What Admin → Apps and the launcher call it. */
  name: string;
  /** What it is for, as the app library and `everyapp_list_apps` tell it. */
  description: string;
  /**
   * The `api_key` capability whose Gateway setting holds the key and whose
   * proxy rules (hosts, methods, account-wide paths) every tool call obeys.
   */
  capability: ApiKeyCapabilityId;
  /** Why the app lists the capability: the manifest entry's `why`. */
  why: string;
  /**
   * What to say to an agent to try it, after "Use <name> to": the "Use it
   * from your agent" dialog's example sentence.
   */
  example: string;
}

export const PROVIDER_APPS = {
  dataforseo: {
    id: "dataforseo",
    name: "DataForSEO",
    description:
      "SEO data for your agent: keyword metrics and suggestions, live Google results, domain rankings, competitors and backlinks, through the Gateway's DataForSEO key.",
    capability: "dataforseo",
    why: "Serves DataForSEO's keyword, search-result, domain and backlink data to members' AI clients.",
    example: "find keyword ideas for a page about running shoes",
  },
} as const satisfies Record<string, ProviderAppDefinition>;

export type ProviderAppId = keyof typeof PROVIDER_APPS;

/** The provider app ids, in a stable order. */
export const PROVIDER_APP_IDS = Object.keys(
  PROVIDER_APPS,
).sort() as ProviderAppId[];

export function isProviderAppId(id: string): id is ProviderAppId {
  return Object.hasOwn(PROVIDER_APPS, id);
}

/** The Gateway setting that holds a provider app's key (`DATAFORSEO_API_KEY`). */
export function providerAppKeySetting(id: ProviderAppId): string {
  return authSettingNames(CAPABILITIES[PROVIDER_APPS[id].capability].auth)[0]!;
}

/**
 * The manifest a provider app's registry row stores: what a deployed app
 * would declare to use the same capability, so Admin → Apps, the settings
 * model and the integration proxy read it like any app's. Read-only
 * access: every provider app only reads data.
 */
export function providerAppManifest(id: ProviderAppId): {
  id: string;
  name: string;
  description: string;
  capabilities: Record<string, { access: "read"; why: string }>;
} {
  const provider = PROVIDER_APPS[id];
  return {
    id: provider.id,
    name: provider.name,
    description: provider.description,
    capabilities: {
      [provider.capability]: { access: "read", why: provider.why },
    },
  };
}
