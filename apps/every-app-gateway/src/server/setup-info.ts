/**
 * What would make a capability or model work, as the gateway words it:
 * the Gateway settings that are unset, one sentence a person can act on,
 * and the command an admin runs. Every refusal that means "not set up"
 * (`integration_not_configured`, `ai_provider_not_configured`,
 * `ai_default_not_configured`) and every status that isn't ready for
 * that reason carries these three fields, so an app shows them as they
 * are and never hardcodes a setting name or a CLI command
 * (`refusalFromError()`, `integrationStatus()` and `aiStatus()` in
 * `@every-app/sdk/server` read them).
 *
 * The command is `everyapp configure <app>`, which asks for every setting
 * the app lacks wherever it is held, or null when whoever reads it can't
 * run it (a shared app, a hosted gateway): then the sentence says the
 * Gateway's operator sets it.
 */
import { SETUP_CLI } from "@/server/setup-cli";

export interface SetupInfo {
  /** The Gateway settings that are unset (`["DATAFORSEO_API_KEY"]`). */
  settings: string[];
  /** One sentence for a person, naming what to set and how. */
  setup: string;
  /** The command an admin runs (`pnpm everyapp configure crm`), or null. */
  command: string | null;
}

/** The command that sets what `appId` lacks, or null when the reader can't run it. */
export function configureCommand(
  appId: string,
  canFix: boolean,
): string | null {
  return canFix ? `${SETUP_CLI} configure ${appId}` : null;
}

/**
 * `label` isn't set up: it needs `settings`. `command` (from
 * {@link configureCommand}) is how; `alternative` is a second way, said
 * only to someone who can run it (the default model's `ai default`).
 * `problem` replaces "isn't set up on this Gateway" when there is more to
 * say (a key set for other hosts).
 */
export function setupInfo({
  label,
  settings,
  command,
  alternative,
  problem = "isn't set up on this Gateway",
}: {
  label: string;
  settings: readonly string[];
  command: string | null;
  alternative?: string;
  problem?: string;
}): SetupInfo {
  const names = listOf(settings);
  const needs = names
    ? `${label} ${problem}: it needs ${names}.`
    : `${label} ${problem}.`;
  const how = command
    ? ` An admin runs: ${command}${alternative ? ` (or ${alternative})` : ""}`
    : names
      ? ` The Gateway's operator sets ${settings.length === 1 ? "it" : "them"}.`
      : " The Gateway's operator sets it up.";
  return { settings: [...settings], setup: `${needs}${how}`, command };
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
