import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { invitations } from "./auth.schema";

/**
 * The secret in an invite link. Better Auth's invitation id is not one: its
 * API has handed pending invitation ids to plain members, and admins see them
 * on the Users page. Each link carries a random `einv_` token instead, and
 * only the token's SHA-256 is stored, bound to one invitation. An invitation
 * can have several live links (emailed, then copied again); all of them stop
 * working once it is accepted, canceled or expired.
 */
export const invitationLinkTokens = sqliteTable(
  "invitation_link_tokens",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("invitation_link_tokens_invitation_id_idx").on(table.invitationId),
  ],
);
