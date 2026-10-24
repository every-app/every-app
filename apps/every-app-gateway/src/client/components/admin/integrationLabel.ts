import type { AppCapabilitySummary } from "@/types/app";

/**
 * "Google (Google account, Gmail read-only)": the Apps table's one line
 * per capability. Once its sets say which of a provider's services the app
 * reaches, the provider's short name carries them: each set as its noun,
 * the access qualifier bare and the identity set's gloss ("who you are")
 * left to the dialog, where there is room for it. A client with one
 * purpose keeps its registry label; a void grant is marked rather than
 * listed, since the gateway refuses its tokens whatever sets survived.
 */
export function integrationLabel(capability: AppCapabilitySummary): string {
  if (capability.scopesStatus === "none") return capability.label;
  const provider = capability.label.replace(/ \([^)]*\)$/, "");
  if (capability.scopesStatus === "undeclared") {
    return `${provider} (no usable scope sets)`;
  }
  const sets = capability.scopeSets.map((set) =>
    // A set this gateway doesn't offer keeps the gateway's own mark.
    set.access ? shortSetLabel(set.label) : set.label,
  );
  return `${provider} (${sets.join(", ")})`;
}

/** "Gmail (read-only)" → "Gmail read-only"; "Google account (who you are)" → "Google account". */
function shortSetLabel(label: string): string {
  const qualified = /^(.*) \((read-only|write)\)$/.exec(label);
  return qualified
    ? `${qualified[1]} ${qualified[2]}`
    : label.replace(/ \([^)]*\)$/, "");
}
