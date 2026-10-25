/**
 * The Gateway's default model provider, resolved for a calling
 * organization: its stored choice (`org_settings.ai_default`, written by
 * Manage workspace → Usage and `everyapp ai default`) against what this
 * Worker's env has set, by the SDK's rule (`resolveAiDefault`). The choice
 * is cached per isolate like the caps are, so a default-route call costs
 * one D1 read every 30 seconds per organization; `clearAiDefaultCache`
 * after a write makes it bind at once in this isolate.
 */
import { env } from "cloudflare:workers";
import {
  parseAiDefaultChoice,
  resolveAiDefault,
  type AiDefaultChoice,
  type AiDefaultResolution,
  type CapabilityLookup,
} from "@every-app/sdk/internal";

const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 30_000;

const choices = new Map<
  string,
  { choice: AiDefaultChoice | null; expiresAt: number }
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

/** The organization's stored choice, or null; read through the cache. */
export async function aiDefaultChoiceFor(
  organizationId: string,
  read: (organizationId: string) => Promise<string | null> = async (id) =>
    (
      await import("@/server/repositories/OrgSettingsRepository")
    ).OrgSettingsRepository.getAiDefault(id),
): Promise<AiDefaultChoice | null> {
  const now = Date.now();
  const cached = choices.get(organizationId);
  if (cached && cached.expiresAt > now) return cached.choice;
  const choice = parseAiDefaultChoice(await read(organizationId));
  choices.delete(organizationId);
  choices.set(organizationId, { choice, expiresAt: now + CACHE_TTL_MS });
  if (choices.size > CACHE_MAX_ENTRIES) {
    const oldest = choices.keys().next().value;
    if (oldest !== undefined) choices.delete(oldest);
  }
  return choice;
}
