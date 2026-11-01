/**
 * The Gateway's default model provider, resolved for a calling
 * organization: its stored provider and models (`org_settings.ai_default`
 * and `ai_models`, written by Manage workspace → Usage, `everyapp ai
 * default` and `everyapp ai model`) against what this Worker's env has
 * set, by the SDK's rule (`resolveAiDefault`: the operator's model, else
 * the catalog's seed). The settings are cached per isolate like the caps
 * are, so a default-route call costs one D1 read every 30 seconds per
 * organization; `clearAiDefaultCache` after a write makes it bind at once
 * in this isolate.
 */
import { env } from "cloudflare:workers";
import {
  parseAiDefaultProvider,
  parseAiModelSettings,
  type AiModelSettings,
} from "@every-app/sdk/internal";
import type { StoredAiSettings } from "@/server/repositories/OrgSettingsRepository";

const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 30_000;

/** What the default resolves on for one organization: the stored provider and models. */
export interface AiDefaultSettings {
  provider: string | null;
  models: AiModelSettings;
}

const choices = new Map<
  string,
  { settings: AiDefaultSettings; expiresAt: number }
>();

export function clearAiDefaultCache(organizationId?: string): void {
  if (organizationId === undefined) choices.clear();
  else choices.delete(organizationId);
}

/** Whether a Gateway setting holds a value, as the AI proxy reads it. */
export function gatewaySettingIsSet(
  name: string,
  settings: Readonly<Record<string, unknown>> = env as unknown as Readonly<
    Record<string, unknown>
  >,
): boolean {
  const value = settings[name];
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

/** The stored text as the resolution reads it. */
export function aiDefaultSettingsOf(
  stored: StoredAiSettings,
): AiDefaultSettings {
  return {
    provider: parseAiDefaultProvider(stored.aiDefault),
    models: parseAiModelSettings(stored.aiModels),
  };
}

/** The organization's stored provider and models; read through the cache. */
export async function aiDefaultSettingsFor(
  organizationId: string,
  read: (organizationId: string) => Promise<StoredAiSettings> = async (id) =>
    (
      await import("@/server/repositories/OrgSettingsRepository")
    ).OrgSettingsRepository.getAiSettings(id),
): Promise<AiDefaultSettings> {
  const now = Date.now();
  const cached = choices.get(organizationId);
  if (cached && cached.expiresAt > now) return cached.settings;
  const settings = aiDefaultSettingsOf(await read(organizationId));
  choices.delete(organizationId);
  choices.set(organizationId, { settings, expiresAt: now + CACHE_TTL_MS });
  if (choices.size > CACHE_MAX_ENTRIES) {
    const oldest = choices.keys().next().value;
    if (oldest !== undefined) choices.delete(oldest);
  }
  return settings;
}
