import {
  CATALOG,
  declaredScopeSets,
  type CapabilityLookup,
  type OAuthScopePolicy,
} from "@every-app/sdk/internal";
import { validateManifest } from "@every-app/perimeter/manifest";
import type { AppCapabilitySummary } from "@/types/app";

/**
 * What an app's stored manifest lists under `capabilities`, read against
 * the registry for Admin → Apps: labels, access, the `why`, and for a
 * scoped OAuth client the sets it names and whether that grant holds, so an
 * admin sees why the gateway refuses an app's tokens. Fails quiet: an
 * unreadable manifest lists nothing, and an id this gateway's registry
 * doesn't know is dropped rather than guessed at (the lenient validator the
 * registry uses keeps unknown ids verbatim).
 */
export function appCapabilities(
  manifest: string | null,
  lookup: CapabilityLookup = CATALOG,
): AppCapabilitySummary[] {
  let listed: Record<
    string,
    { access: "read" | "write"; why?: string; scopes?: unknown }
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
    const policy =
      capability.mode === "oauth_client" ? capability.scopePolicy : undefined;
    summaries.push({
      id,
      label: capability.label,
      access: entry.access,
      ...(entry.why === undefined ? {} : { why: entry.why }),
      ...(policy
        ? scopeSetsOf(policy, entry)
        : { scopeSets: [], scopesStatus: "none" }),
    });
  }
  return summaries;
}

/**
 * The sets a scoped client's entry names, as the token endpoint reads them:
 * the grant is void (`undeclared`) unless `scopes` is a list of distinct
 * names this gateway offers. A name it doesn't offer is still listed,
 * marked, so the admin can tell a gateway behind the app from a typo.
 */
function scopeSetsOf(
  policy: OAuthScopePolicy,
  entry: { scopes?: unknown },
): Pick<AppCapabilitySummary, "scopeSets" | "scopesStatus"> {
  const names = Array.isArray(entry.scopes)
    ? [
        ...new Set(
          entry.scopes.filter(
            (name): name is string => typeof name === "string",
          ),
        ),
      ]
    : [];
  const scopeSets = names.map((name) =>
    Object.hasOwn(policy.sets, name)
      ? {
          name,
          label: policy.sets[name].label,
          access: policy.sets[name].access,
        }
      : { name, label: `${name} (unknown to this gateway)` },
  );
  const scopesStatus = scopeSets.some((set) => !("access" in set))
    ? "unknown"
    : declaredScopeSets(policy, entry)
      ? "ok"
      : "undeclared";
  return { scopeSets, scopesStatus };
}
