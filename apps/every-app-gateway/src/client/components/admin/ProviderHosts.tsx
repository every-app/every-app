/**
 * Where a provider's credential can go: the only hosts the Gateway attaches
 * it to, said where an admin is about to hand one over. Nothing when the
 * provider names no hosts.
 */
export function ProviderHosts({
  hosts,
  what,
}: {
  hosts: readonly string[];
  /** What apps use: "this key", "connected accounts". */
  what: string;
}) {
  if (hosts.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Apps can use {what} only to call{" "}
      <span className="font-mono wrap-anywhere">{hosts.join(", ")}</span>.
    </p>
  );
}
