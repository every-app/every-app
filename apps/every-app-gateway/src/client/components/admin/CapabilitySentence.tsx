import type { AppCapabilitySummary } from "@/types/app";

/**
 * One capability the app lists, as a sentence for the Edit dialog: what it
 * reaches and why, and for an OAuth provider the scopes the app asks each
 * person for when they connect it in the app. Read-only like the mail
 * facts: the manifest is the app's, and only a deploy changes it.
 */
export function CapabilitySentence({
  capability,
}: {
  capability: AppCapabilitySummary;
}) {
  // The why sits inside the sentence, so its own full stop comes off.
  const why = capability.why ? (
    <> &ldquo;{capability.why.trimEnd().replace(/\.+$/, "")}&rdquo;</>
  ) : null;
  if (capability.scopes) {
    return (
      <>
        {capability.label},{" "}
        {capability.scopes.length ? (
          <>
            scopes{" "}
            <span className="font-mono">{capability.scopes.join(", ")}</span>
          </>
        ) : (
          "no scopes"
        )}
        {why ? "," : null}
        {why}.
      </>
    );
  }
  return (
    <>
      {capability.label}
      {capability.access ? `, ${capability.access} access` : null}
      {why ? "," : null}
      {why}.
    </>
  );
}
