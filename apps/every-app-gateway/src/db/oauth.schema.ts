import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * OAuth providers the Gateway runs the flow for
 * (docs/design/2026-11-oauth-one-connection.md): the client an owner or
 * admin pasted in the UI, each person's one connection to a provider, the
 * apps that person allowed to use it, and the in-flight authorize states.
 * Every secret column holds a sealed value (server/secrets/sealed.ts),
 * never plaintext; the repositories seal and open, so no caller writes a
 * token column itself.
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
 * One person's tokens for one provider
 * (docs/design/2026-11-oauth-one-connection.md): the person connected the
 * provider once, for the scopes the organization's apps listed then. One
 * row per (organization, provider, user); which apps may use it is
 * `provider_app_access`. Deleted when the person disconnects, leaves the
 * organization or is deactivated, or the provider is removed.
 */
export const providerConnections = sqliteTable(
  "provider_connections",
  {
    // `conn_<uuid>`.
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull(),
    // apps.id of the app the connection was last made from. Nothing here
    // reads it: the CLI before migration 0034 does, so it stays until a
    // later release drops it. Which apps may use the connection is
    // `provider_app_access`.
    appRowId: text("app_row_id").notNull(),
    // How the provider names the account ("ben" at GitHub, an email at Google).
    label: text("label"),
    // The provider's own id for the account.
    externalId: text("external_id"),
    // The provider scopes the token holds, canonical (oauthScopes.ts), JSON array.
    scopes: text("scopes").notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    // "active" | "expired".
    status: text("status").notNull(),
    // Counts every write of the tokens (a connect, a refresh). A refresh
    // stores its result, and a refused one marks the row expired, only
    // while this is still the number it read: a write decided on tokens
    // that have since been replaced changes nothing.
    tokenVersion: integer("token_version").notNull().default(0),
    // While a refresh is under way, the lease's end; null otherwise.
    refreshingUntil: integer("refreshing_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("provider_connections_person_idx").on(
      table.organizationId,
      table.providerId,
      table.userId,
    ),
    index("provider_connections_user_idx").on(table.userId),
  ],
);

/**
 * An app a person allowed to use their connection to a provider: one row
 * per (organization, provider, user, app), with the scopes the app listed
 * when they allowed it. Written when the person connects from inside the
 * app or selects Allow on the Gateway's page. Deleted when they take the
 * app's access away, lose the app, disconnect the provider, connect
 * another account, leave the organization or are deactivated, or the
 * provider is removed.
 */
export const providerAppAccess = sqliteTable(
  "provider_app_access",
  {
    organizationId: text("organization_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull(),
    // apps.id of the app allowed.
    appRowId: text("app_row_id").notNull(),
    // The scopes the app listed then, canonical (oauthScopes.ts), JSON array.
    scopes: text("scopes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("provider_app_access_owner_idx").on(
      table.organizationId,
      table.providerId,
      table.userId,
      table.appRowId,
    ),
    index("provider_app_access_user_idx").on(table.userId),
    index("provider_app_access_app_idx").on(table.appRowId),
  ],
);

/**
 * A connect in progress: the state the provider will send back (or the
 * Allow page posts), the PKCE verifier, who started it, in which app, the
 * scopes asked for and where to return. One use: the callback or the
 * Allow deletes the row as it reads it; expired rows are deleted whenever
 * a new one is written.
 */
export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  providerId: text("provider_id").notNull(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  // apps.id of the app the connect is for.
  appRowId: text("app_row_id").notNull(),
  // OAuthStatePurpose: "authorize" and "reconnect" the provider's callback
  // spends ("reconnect" also allows the person's apps again); "allow" the
  // Gateway's own Allow page does, and no provider is asked.
  purpose: text("purpose").notNull().default("authorize"),
  codeVerifier: text("code_verifier").notNull(),
  // The scopes asked for, in the provider's spelling, JSON array.
  scopes: text("scopes").notNull(),
  // Where the browser goes after the callback.
  returnTo: text("return_to"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});
