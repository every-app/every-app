import type { AppCapabilitySummary } from "@/types/app";

/**
 * One capability the app lists, as a sentence for the Edit dialog: what it
 * reaches and why, and for a scoped OAuth client the sets that bound its
 * tokens, or the reason the gateway refuses them and the fix. Read-only
 * like the mail facts: the manifest is the app's, and only a deploy
 * changes it.
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
  const sets = (
    <span className="font-mono">
      {capability.scopeSets.map((set) => set.label).join(", ")}
    </span>
  );
  switch (capability.scopesStatus) {
    case "none":
      return (
        <>
          {capability.label}, {capability.access} access{why ? "," : null}
          {why}.
        </>
      );
    case "ok":
      // The entry's own access is "write" on every OAuth client (the
      // registry allows nothing else) while its sets are read-only, so
      // "write access to Gmail (read-only)" would contradict itself: the
      // sets are the grant, and the sentence leads with them.
      return (
        <>
          {capability.label}, tokens for {sets}
          {why ? "," : null}
          {why}: the gateway refuses tokens outside these sets; the app holds
          the tokens and calls the provider itself.
        </>
      );
    case "undeclared":
      // The summary lists the sets that survive a void grant, so an admin
      // seeing them beside "no usable scope sets" would read the grant as
      // held; name what voids it instead. A duplicate and a non-string
      // entry are told apart only by the CLI's strict validation.
      return (
        <span className="text-warning-foreground dark:text-warning">
          {capability.scopeSets.length ? (
            <>
              {capability.label} lists a scope set twice, or an entry that isn't
              a set name, so the gateway refuses its tokens: list each set once
              under <span className="font-mono">scopes</span> in its
              capabilities entry and deploy the app again.
            </>
          ) : (
            <>
              {capability.label} lists no usable scope sets, so the gateway
              refuses its tokens: name one or more under{" "}
              <span className="font-mono">scopes</span> in its capabilities
              entry and deploy the app again.
            </>
          )}
        </span>
      );
    case "unknown":
      return (
        <span className="text-warning-foreground dark:text-warning">
          {capability.label} lists a scope set this gateway doesn't offer (
          <span className="font-mono">
            {capability.scopeSets
              .filter((set) => !set.access)
              .map((set) => set.name)
              .join(", ")}
          </span>
          ), so the gateway refuses its tokens: update the gateway, or drop the
          set from <span className="font-mono">scopes</span> and deploy the app
          again.
        </span>
      );
  }
}
