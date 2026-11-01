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
