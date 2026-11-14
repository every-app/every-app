import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * A person's Composio linked to the Gateway
 * (docs/design/2026-11-composio.md). Every secret column holds a sealed
 * value (server/secrets/sealed.ts), never plaintext; the repository seals
 * and opens, so no caller writes one itself. What a person uses from
 * their Composio is a `provider_connections` row marked `via: composio`.
 */

/**
 * One person's link in an organization: their Composio user key, sealed,
 * and what each call to Composio is made with. One row per (organization,
 * user). Deleted when the person unlinks, Composio refuses the key, an
 * owner or admin turns Composio off, or the person leaves the
 * organization or is deactivated.
 */
export const composioLinks = sqliteTable(
  "composio_links",
  {
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    // The user key (`uak_…`), sealed.
    keyEnc: text("key_enc").notNull(),
    // How Composio names the account: its email, else its name.
    accountLabel: text("account_label").notNull(),
    composioOrgId: text("composio_org_id").notNull(),
    // The consumer project's short id (`pr_…`).
    composioProjectId: text("composio_project_id").notNull(),
    // The person's id in that project (`consumer-…`).
    composioUserId: text("composio_user_id").notNull(),
    // The session calls go through; null until the first call.
    sessionId: text("session_id"),
    // The accounts that session was opened for, as one string: a call
    // whose connections name other accounts opens another.
    sessionAccounts: text("session_accounts"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("composio_links_person_idx").on(
      table.organizationId,
      table.userId,
    ),
    index("composio_links_user_idx").on(table.userId),
  ],
);

/**
 * A sign-in waiting for the person to approve it in Composio. The sign-in
 * id picks the key up once they do, so it is sealed. One row per
 * (organization, user): starting again replaces it. Deleted when the link
 * is made, the sign-in expires, or the person leaves the organization or
 * is deactivated.
 */
export const composioLinkRequests = sqliteTable(
  "composio_link_requests",
  {
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    // Composio's sign-in id, sealed.
    signInEnc: text("sign_in_enc").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("composio_link_requests_person_idx").on(
      table.organizationId,
      table.userId,
    ),
    index("composio_link_requests_user_idx").on(table.userId),
  ],
);
