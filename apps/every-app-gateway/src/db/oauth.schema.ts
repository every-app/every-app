import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * OAuth providers the Gateway runs the flow for
 * (docs/design/2026-10-oauth-providers.md section 6): the client an owner
 * or admin pasted in the UI, each person's (or the organization's)
 * connection, and the in-flight authorize states. Every secret column
 * holds a sealed value (server/secrets/sealed.ts), never plaintext; the
 * repositories seal and open, so no caller writes a token column itself.
 */

/**
 * The client id and secret uploaded for one provider on this gateway. One
 * per provider, gateway-wide like a registered row's key; read only when
 * the Worker env lacks the provider's `clientId` setting, so a secret the
 * CLI set wins and the operator can always rotate from the CLI.
 */
export const oauthClients = sqliteTable("oauth_clients", {
  // The provider id (`github`, `google-workspace`).
  providerId: text("provider_id").primaryKey(),
  // The public client id, as the provider issued it.
  clientId: text("client_id").notNull(),
  // The client secret, sealed; null for a public client.
  clientSecretEnc: text("client_secret_enc"),
  // What the client was uploaded for (`providerBindingKey` of the provider
  // as it was then): read only while the provider still matches.
  boundTo: text("bound_to"),
  // The member's email who uploaded it.
  addedBy: text("added_by"),
  addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One person's, or one organization's, tokens for one provider. The
 * subject is the user id for a person's connection and `organization` for
 * the organization's (`account_kind` says which), so the unique index
 * holds one row per (organization, provider, subject).
 */
export const providerConnections = sqliteTable(
  "provider_connections",
  {
    // `conn_<uuid>`.
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    providerId: text("provider_id").notNull(),
    // "user" | "organization".
    accountKind: text("account_kind").notNull(),
    // The user id, or "organization".
    subject: text("subject").notNull(),
    // The user id for a person's connection; null for the organization's.
    userId: text("user_id"),
    // How the provider names the account ("ben" at GitHub, an email at Google).
    label: text("label"),
    // The provider's own id for the account.
    externalId: text("external_id"),
    // The scope set names the connection was asked for, JSON array.
    scopeSets: text("scope_sets").notNull(),
    // The provider scopes as granted, JSON array.
    scopes: text("scopes").notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    // "active" | "expired".
    status: text("status").notNull(),
    // While a refresh is under way, the lease's end; null otherwise.
    refreshingUntil: integer("refreshing_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("provider_connections_subject_idx").on(
      table.organizationId,
      table.providerId,
      table.subject,
    ),
    index("provider_connections_user_idx").on(table.userId),
  ],
);

/**
 * An authorize flow in progress: the state the provider will send back,
 * the PKCE verifier, who started it and where to return. One use: the
 * callback deletes the row as it reads it; expired rows are deleted
 * whenever a new one is written.
 */
export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  providerId: text("provider_id").notNull(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  // "user" | "organization".
  accountKind: text("account_kind").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  // The scope set names asked for, JSON array.
  scopeSets: text("scope_sets").notNull(),
  // Where the browser goes after the callback.
  returnTo: text("return_to"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One member's opt-in to let one app use their connection with nobody
 * present (docs/design/2026-11-birds-decisions/888-background-oauth.md):
 * granted on the Gateway's own page (`/connect/<id>/background`), for the
 * background sets the app's manifest entry declared at the time. One row
 * per (connection, app); a grant made again after a revocation or lapse
 * reuses the row. Rows are kept after they end, for Connected accounts and
 * the admin list, and are never read as live once `ended_at` is set.
 */
export const providerBackgroundGrants = sqliteTable(
  "provider_background_grants",
  {
    // `bgg_<uuid>`.
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    providerId: text("provider_id").notNull(),
    // The member's own connection (provider_connections.id). A reconnect
    // after a disconnect is a new row there, so it needs a new grant.
    connectionId: text("connection_id").notNull(),
    // apps.id of the first-party organization app the grant is for.
    appRowId: text("app_row_id").notNull(),
    userId: text("user_id").notNull(),
    // The background scope set names consented to, JSON array.
    scopeSets: text("scope_sets").notNull(),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
    // The member last opened the app (the perimeter touches it, at most
    // once a day): the 90-day idle lapse counts from here.
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    // The app last used the grant (at most once a day).
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    // When the grant ended (revoked or lapsed); null while it is live.
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    // Why it ended: "revoked" | "admin_revoked" | "idle" | "no_access" |
    // "member_inactive" | "app_removed" | "disconnected".
    endedReason: text("ended_reason"),
    // The user id of whoever revoked it; null for a lapse.
    endedBy: text("ended_by"),
  },
  (table) => [
    uniqueIndex("provider_background_grants_pair_idx").on(
      table.connectionId,
      table.appRowId,
    ),
    index("provider_background_grants_user_idx").on(
      table.userId,
      table.appRowId,
    ),
    index("provider_background_grants_org_idx").on(table.organizationId),
  ],
);
