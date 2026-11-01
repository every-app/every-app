/**
 * What `everyapp status` counts in the install organization for its next
 * steps, in one `cf d1 query` batch of five statements, read under the
 * operator's own credentials (ADR-0003) and never over HTTPS. Counts only:
 * no row, name or value comes back. Any failure (a Gateway from before one
 * of these tables existed, cf down) is the caller's to treat as unread:
 * the rules that need a count are skipped, never an error.
 */
import type { D1Database } from "@/lib/cf/d1";

export interface OrganizationCounts {
  /** `members` rows. */
  members: number;
  /** `invitations` pending and not expired: people asked who haven't joined yet. */
  invitations: number;
  /** `mcp_connections` not revoked: AI clients connected through OAuth. */
  connections: number;
  /** `user_access_tokens` not revoked and not expired: personal tokens in use. */
  tokens: number;
  /** `app_tool_catalogs` serving at least one tool. */
  toolApps: number;
}

const count = (rows: Array<Record<string, unknown>> | undefined): number =>
  Number(rows?.[0]?.["n"] ?? 0);

export async function readOrganizationCounts(
  db: D1Database,
  organizationId: string,
  now = Date.now(),
): Promise<OrganizationCounts> {
  const [members, invitations, connections, tokens, toolApps] = await db.run([
    { sql: "SELECT count(*) AS n FROM members WHERE organization_id = ?", params: [organizationId] },
    {
      sql: "SELECT count(*) AS n FROM invitations WHERE organization_id = ? AND status = 'pending' AND expires_at > ?",
      params: [organizationId, now],
    },
    {
      sql: "SELECT count(*) AS n FROM mcp_connections WHERE organization_id = ? AND revoked_at IS NULL",
      params: [organizationId],
    },
    {
      sql: "SELECT count(*) AS n FROM user_access_tokens WHERE organization_id = ? AND revoked_at IS NULL AND expires_at > ?",
      params: [organizationId, now],
    },
    {
      sql: "SELECT count(*) AS n FROM app_tool_catalogs WHERE organization_id = ? AND status = 'ok' AND tool_count > 0",
      params: [organizationId],
    },
  ]);
  return {
    members: count(members),
    invitations: count(invitations),
    connections: count(connections),
    tokens: count(tokens),
    toolApps: count(toolApps),
  };
}
