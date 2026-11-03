import { CATALOG, type CapabilityLookup } from "@every-app/sdk/internal";
import { validateManifest } from "@every-app/perimeter/manifest";
import type { AppCapabilitySummary } from "@/types/app";

/**
 * What an app's stored manifest lists under `capabilities`, read against
 * the registry for Admin → Apps: labels, the `why`, and an OAuth
 * provider's scopes (the provider's own strings, as the app wrote them) or
 * another capability's access. Fails quiet: an unreadable manifest lists
 * nothing, and an id this gateway's registry doesn't know is dropped
 * rather than guessed at (the lenient validator the registry uses keeps
 * unknown ids verbatim).
 */
export function appCapabilities(
  manifest: string | null,
  lookup: CapabilityLookup = CATALOG,
): AppCapabilitySummary[] {
  let listed: Record<
    string,
    { access?: "read" | "write"; why?: string; scopes?: unknown }
  >;
  try {
    listed =
      validateManifest(JSON.parse(manifest ?? "null")).capabilities ?? {};
  } catch {
    return [];
  }
  const summaries: AppCapabilitySummary[] = [];
  for (const [id, entry] of Object.entries(listed)) {
    const capability = lookup.get(id);
    if (!capability || capability.mode === "ai") continue;
    const why = entry.why === undefined ? {} : { why: entry.why };
    if (capability.mode === "oauth_client") {
      const scopes = Array.isArray(entry.scopes)
        ? [
            ...new Set(
              entry.scopes.filter(
                (scope): scope is string => typeof scope === "string",
              ),
            ),
          ]
        : [];
      summaries.push({ id, label: capability.label, ...why, scopes });
      continue;
    }
    summaries.push({
      id,
      label: capability.label,
      ...(entry.access ? { access: entry.access } : {}),
      ...why,
    });
  }
  return summaries;
}
