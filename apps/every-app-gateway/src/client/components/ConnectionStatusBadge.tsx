import { Badge } from "@/client/components/ui/badge";

/**
 * A connection's state, as a chip either way. Your connections → Accounts
 * and Manage workspace → Providers both say it this way. The person
 * reconnects their own from Your connections → Accounts.
 */
export function ConnectionStatusBadge({
  connection,
}: {
  connection: { status: "active" | "expired"; needsReconnect: boolean };
}) {
  if (connection.needsReconnect) {
    return <Badge variant="warning">Needs reconnect</Badge>;
  }
  if (connection.status === "expired") {
    return <Badge variant="secondary">Expired</Badge>;
  }
  return <Badge variant="success">Connected</Badge>;
}
