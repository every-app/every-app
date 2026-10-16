import { Badge } from "@/client/components/ui/badge";

// Cells shared by the deploy token and personal access token tables.

type TokenStatus = "active" | "expired" | "revoked";

/** A token works until it is revoked or its expiry passes. */
export function tokenStatus(token: {
  revokedAt: Date | null;
  expiresAt: Date | null;
}): TokenStatus {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    return "expired";
  }
  return "active";
}

const STATUS_BADGES = {
  active: { label: "Active", variant: "success" },
  expired: { label: "Expired", variant: "warning" },
  revoked: { label: "Revoked", variant: "destructive" },
} as const;

export function TokenStatusBadge({ status }: { status: TokenStatus }) {
  const badge = STATUS_BADGES[status];
  return <Badge variant={badge.variant}>{badge.label}</Badge>;
}

/** The visible start of a token. The rest is only shown once, at creation. */
export function TokenPrefix({ prefix }: { prefix: string }) {
  return (
    <span className="font-mono text-xs text-muted-foreground">{prefix}…</span>
  );
}
