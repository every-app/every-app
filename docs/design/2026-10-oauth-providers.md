# OAuth providers: upload a client, the Gateway runs the flow

Date: 2026-10-25. Status: design, built in the PRs of section 10. Ben, the night of 2026-10-25: "Could you please actually support OAuth providers? They'll need to just upload a client ID and a client secret, and then we'll need logic to handle OAuth flows. Implement that. GitHub in particular is something people may want. I want people to be able to add whatever they want to the gateway." And then: build the general pattern and prove it with Google first (OpenSEO on the port checkout), GitHub second as the proof that a provider with no hand-written entry works by upload alone.

This is the "later note" the provider registry design ([2026-10-provider-registry.md](2026-10-provider-registry.md) section 2) left for `oauth2-user` rows, and section 10 of the scopes design ([2026-10-oauth-scopes.md](2026-10-oauth-scopes.md)) built: the Gateway holds the person's tokens, so the route allowlist becomes a live boundary.

## 1. What exists and what changes

Today an OAuth client is a catalog entry (`mode: "oauth_client"`, eighteen of them: Google, Microsoft, Slack, the social networks) whose client id and secret are Worker secrets the operator sets with `everyapp secret set`. The Gateway completes the provider's **token endpoints** only; the app builds the authorize URL, receives the callback on its own host, and keeps the person's tokens. A registered provider (`everyapp provider add`, a `providers` row) can only be an API key.

With this design:

- **An OAuth provider is a kind in the registry.** A row's spec may say `auth.kind: "oauth2-user"` (section 3). Presets (section 4) are JSON specs of that shape shipped with the SDK: `everyapp provider add --oauth github` writes the preset as a row. A catalog OAuth entry (`google-workspace`, `slack`, `microsoft-365`, `discord`) is a preset too: adding it uploads a client for the entry, no row, no duplicate.
- **The client can be pasted in the UI.** Admin → Providers takes the client id and secret and stores them in D1, the secret encrypted (section 6). A Worker secret of the same name, set by the CLI, takes precedence; the UI says which is live.
- **The Gateway owns the flow end to end** (section 5): `/connect/<id>` starts it (PKCE, state), `/connect/<id>/callback` finishes it, the tokens are stored encrypted per person or per organization, refreshed before use, and the connection is listed under Settings → Connected accounts and Admin → Providers.
- **Apps call the provider through the proxy** with the person's token injected (section 7): `integrationFetch({ provider: "github" })` to `https://api.github.com/user/repos`. The app never sees the access token, the refresh token or the client secret.
- **The app-driven flow stays.** Every token-endpoint call the Gateway completes today still works byte for byte (`provider-migration.test.ts`); OpenSEO and CRM change nothing.

## 2. Vocabulary

| Word | Meaning |
| --- | --- |
| Provider | A catalog entry or a `providers` row; the id apps list under `capabilities` |
| OAuth provider | A provider whose auth is a user OAuth 2 client: `mode: "oauth_client"` in the registry, `auth.kind: "oauth2-user"` in a spec |
| Preset | A ready OAuth spec shipped with the SDK (`OAUTH_PRESETS`), or a catalog OAuth entry; what the UI's "Add OAuth provider" offers |
| Client | The provider-issued client id and secret; one per provider per gateway |
| Connection | One person's (or one organization's) tokens for one provider: a `provider_connections` row |
| Scope set | A named bundle of provider scopes an app declares (`scopes: ["repo.read"]`), as in the scopes design |

## 3. The spec: `auth.kind: "oauth2-user"`

One JSON shape for rows and presets, parsed by `parseProviderSpec` beside the API-key kinds, producing an `OAuthClientCapability` (so every reader of the registry keeps one type per mode):

```jsonc
{
  "id": "github",
  "name": "GitHub",
  "description": "Repositories, issues, pull requests, the person's profile.",
  "docs": "https://github.com/settings/developers",     // where the client is made (required, https)
  "api": "https://docs.github.com/rest",               // the API reference (optional)
  "hosts": ["api.github.com"],                         // the only hosts the token is ever sent to
  "auth": {
    "kind": "oauth2-user",
    "authorizeUrl": "https://github.com/login/oauth/authorize",
    "tokenUrl": "https://github.com/login/oauth/access_token",
    "revokeUrl": "https://api.github.com/applications/{client_id}/grant",   // optional
    "revokeMethod": "DELETE",                          // optional, default POST
    "clientId": "GITHUB_CLIENT_ID",                    // Gateway setting names, never values
    "clientSecret": "GITHUB_CLIENT_SECRET",            // optional: absent is a public client
    "inject": "form",                                  // form | basic: where the client goes on the token request
    "pkce": true,                                      // default true; false for a provider that refuses code_challenge
    "scopeDialect": "comma",                           // space (default) | comma | google | microsoft | slack
    "authorizeParams": { "allow_signup": "false" },    // extra query on the authorize URL (optional)
    "tokenHeaders": { "Accept": "application/json" },  // extra headers on the token request (optional)
    "identity": { "url": "https://api.github.com/user", "label": "login", "id": "id" }  // how to name the account (optional)
  },
  "scopeSets": {
    "identity": { "label": "Who you are", "access": "read", "scopes": ["read:user"] },
    "repo.read": { "label": "Repositories (read)", "access": "read", "scopes": ["repo"] },
    "repo.write": { "label": "Repositories (write)", "access": "write", "scopes": ["repo"] }
  },
  "alwaysRequested": [],                               // scopes every connection asks for (optional)
  "tolerated": [],                                     // scopes a token may carry beyond the sets (optional)
  "access": ["read", "write"]                          // what the proxy may do with the token (default read)
}
```

Rules, on top of the row rules of the registry design (`providers.*`):

- `authorizeUrl`, `tokenUrl` and `revokeUrl` are https URLs whose hosts pass the row host rules (public DNS, never the gateway's own hosts); the token and revoke hosts need not be in `hosts` (the proxy never forwards an app's call to them: `oauth.token-endpoints-only` holds for the token host, and the held-token branch of section 7 forwards to `hosts` only).
- `clientId` and `clientSecret` are setting names under the row's prefix (`providers.row-secret-is-its-own`).
- A scope set's `routes` are optional. A set with routes unlocks those paths (the matcher of the scopes design, `scopeRouteAllows`); a set without routes unlocks every path on `hosts` for its `access` (read: GET and HEAD; write: the provider's write methods too). A row may name `readMethods`/`writeMethods` as an API-key spec does.
- The scope dialects `space` and `comma` are new (`oauthScopes.ts`): a token response with no `scope` field is taken as granted-as-requested (RFC 6749 §5.1); `google`, `microsoft` and `slack` keep their parsers.
- `identity`: after the exchange the Gateway GETs the URL with the new token and reads `label` and `id` (dot paths) to name the connection ("ben" at GitHub, "ben@…" at Google). Absent: the connection is named by its provider.

A catalog OAuth entry gains an optional `flow` block in TypeScript carrying what the spec's `auth` carries beyond today's fields (`tokenUrl` is the first `token[]` endpoint with a string path; `pkce`, `scopeDialect`, `authorizeParams`, `tokenHeaders`, `identity`, `revoke`). An entry with `flow` supports the Gateway-owned flow; an entry without (the social networks, for now) keeps the app-driven flow only. `google-workspace`, `microsoft-365`, `slack` and `discord` get `flow` in the first PR. `scopePolicy` stays the catalog's source of scope sets; a row's `scopeSets` is parsed into a `scopePolicy` of the same type (dialect from `scopeDialect`, `grantTypes: ["authorization_code", "refresh_token"]`, `requestScope: "keep"`, `deniedSegments: []` plus the shared `batch` rules).

`providerBindingKey` covers an OAuth capability too: its authorize, token and revoke URLs, `hosts`, `inject` and the client setting names. A client uploaded for a row stays usable only while the row still has those (`providers.value-bound-to-hosts`, now `oauth.client-bound-to-endpoints`): an admin who re-points `tokenUrl` has to paste the secret again.

## 4. Presets

`packages/sdk/src/internal/oauthPresets.ts` holds `OAUTH_PRESETS`, JSON specs of section 3 (not TypeScript entries), one per provider: `github`, `notion`, `linear`, `gitlab`, `atlassian`, `hubspot`, `zoom`, `dropbox`, `spotify`, `x`. Each is parsed by `parseProviderSpec` in a test and documented on the generated catalog table. A preset becomes a row when added (`everyapp provider add --oauth github`, the UI, `everyapp_provider_add` with `{ preset: "github" }`), so the operator may `provider show github` and edit a copy: a preset is a starting point, never a hidden catalog entry. The catalog OAuth entries that have `flow` are offered in the same picker, marked "built in": adding one uploads the client only.

"Custom" is the picker's last choice: the fields of section 3 as a form (name, authorize URL, token URL, scopes as free text becoming one set, API hosts, inject, PKCE). The CLI takes the same as a JSON file: `everyapp provider add --oauth ./acme.json`.

X (OAuth 2 with PKCE, `x.com`'s `/2/oauth2/authorize`) is a preset here; X's OAuth 1.0a stays an app secret as before.

## 5. The flow

```
GET /connect/<id>?account=user|organization&return=<path or app URL>&sets=a,b
  → session required (the perimeter's; a Cloudflare Access ring in front stays)
  → `organization` needs owner or admin; `user` any member
  → the provider is an OAuth provider with a live client (env or D1), else 404/409 with why
  → sets: the ones named, else the union of the sets every active app that lists
    the provider declares, else every set the preset has; `identity` always
  → one `oauth_states` row: state (32 random bytes, base64url), PKCE verifier,
    who, which organization, account kind, the sets, where to return, 10 minutes
  → 302 to authorizeUrl with response_type=code, client_id, redirect_uri,
    scope (the union, in the dialect's separator), state, code_challenge(_method=S256),
    the preset's authorizeParams (Google: access_type=offline, prompt=consent)

GET /connect/<id>/callback?code&state           ← the redirect URI the admin registers
  → the state row exists, is this person's, is not expired; deleted at once (one use)
  → an `error` from the provider ends on a Gateway page, never redirected on
  → POST tokenUrl with code, redirect_uri, code_verifier, the client as `inject` says,
    tokenHeaders; 64 KiB answer cap; redirect: "manual"; never logged
  → granted scopes (the dialect) must cover the sets asked; excess beyond
    tolerated is refused, the tokens dropped (the scopes design's rules)
  → identity (section 3) names the account
  → one `provider_connections` row per (organization, provider, subject),
    replaced on reconnect; tokens encrypted (section 6)
  → provider.connected emitted with the actor
  → 302 to `return`: a path on the Gateway, or an https URL whose host is one of
    this gateway's app hosts (APP_BASE_DOMAIN, a registered app's host); in
    `GATEWAY_DEPLOYMENT_MODE=dev` also http://localhost:<port>. Anything else
    lands on Settings → Connected accounts.
```

Refresh: the proxy refreshes a connection whose `expires_at` is within 60 seconds, under a lease (`refreshing_until`, one conditional UPDATE) so parallel calls do not race; a refresh the provider refuses marks the connection `expired`, emits `provider.connection_expired` once, and the proxy answers `integration_not_connected` with `reconnect: true` until the person connects again.

Disconnect (Settings, Admin, `everyapp provider disconnect`, `everyapp_provider_disconnect`): deletes the row, emits `provider.disconnected`, and revokes at the provider only when the spec has `revokeUrl`. The Google preset has none on purpose: Google's revoke is per person per client and would also kill the tokens an app-driven OpenSEO holds under the same client; the Google tokens the Gateway drops die at their expiry. GitHub, GitLab, Dropbox and Zoom revoke.

Who may connect what: any member their own account; owner or admin the organization's account (`account=organization`, the one background work uses). Admin → Providers lists every connection in the organization (who, which provider, which sets, when last used) and may disconnect any; Settings → Connected accounts lists the person's own.

## 6. Storage and encryption

Migration 0015 (generated against main at merge time, never hand-written):

- `oauth_clients`: `provider_id` (PK), `client_id`, `client_secret_enc` (null for a public client), `bound_to`, `added_by`, `added_at`, `updated_at`. One client per provider per gateway, like a row's key. Read only when the Worker env lacks the provider's `clientId` setting: a CLI-set secret wins, so an operator can always rotate from the CLI.
- `provider_connections`: `id` (`conn_<uuid>`), `organization_id`, `provider_id`, `account_kind` (`user` | `organization`), `subject` (the user id, or `organization`), `user_id` (null for the organization's), `label`, `external_id`, `scope_sets` (JSON), `scopes` (JSON, as granted), `access_token_enc`, `refresh_token_enc`, `expires_at`, `status` (`active` | `expired`), `refreshing_until`, `created_at`, `updated_at`, `last_used_at`. Unique on (`organization_id`, `provider_id`, `subject`).
- `oauth_states`: `state` (PK), `provider_id`, `organization_id`, `user_id`, `account_kind`, `code_verifier`, `scope_sets`, `return_to`, `created_at`, `expires_at`. Expired rows are deleted whenever one is written.

Encryption (`apps/every-app-gateway/src/server/secrets/sealed.ts`): AES-256-GCM through WebCrypto, a random 96-bit nonce per value, the ciphertext stored as `v1.<nonce>.<ciphertext>` in base64url. The key is derived once per isolate with HKDF-SHA256 from `BETTER_AUTH_SECRET` (an install-owned secret every gateway has, so there is no new setup step) with the info string `everyapp:oauth:v1`; the `v1` prefix is the version to rotate under. A ciphertext that does not open is treated as a lost token: the connection reads as expired and the person connects again. The Gateway encrypts nothing else today; the events thread's subscription signing secret is the next user of this helper (its TODO). The threat model gets `oauth.tokens-sealed-at-rest` and `oauth.client-secret-sealed-at-rest`.

What never leaves the Gateway: the client secret, the refresh token, the access token (apps get calls completed, never the value), the PKCE verifier, the state. Logs name provider, organization, account kind, scope-set names and the error's name only.

## 7. The proxy with a held token

`/api/integrations/<id>/<host>/<path>` for an OAuth provider:

1. The host is one of the provider's token endpoints → today's branch (`handleOAuthClientCall`), unchanged.
2. The host is in `hosts` (`api`) → the held-token branch, in the order of the registry design's checks: active app; the app lists the provider (`capability_not_requested`); the method is allowed (`integration_method_not_allowed`: read methods on a read grant, write methods on `access: "write"` for a provider that offers it); the client is live (`integration_not_configured`); `admit()`, then an agent's read-only connection (`integration_read_only`); the connection: the header `x-everyapp-account: user | organization` (the SDK's `account` option; default `user` when a person is behind the call, `organization` for background work) picks it, missing or expired → `integration_not_connected` (409) with `{ connectPath: "/connect/<id>", reconnect }`; the app's declared sets ⊆ the connection's sets, else `integration_not_connected` with `reconnect: true` and the missing sets; the path: a declared set with routes must cover it, a declared set without routes covers its host (`integration_scope_not_allowed`, 403), and `deniedSegments` never pass; then refresh if due, inject `Authorization: Bearer`, strip the app's `Authorization`, cookies, `X-HTTP-Method-Override` and `access_token`/`token` query keys, forward with `redirect: "manual"`, drop `set-cookie`, count the call (`onCall`, Usage) and log `integration.proxy.call` with the set names.
3. Any other host → `invalid_integration_route`.

`GET /api/integrations/<id>` (status) for an OAuth provider gains `flow: "app" | "gateway" | "both"`, `connectPath`, and for the caller's account `connection: { account, label, scopeSets, ready, reconnect? } | null`. The dev twin (`everyapp dev`, no binding) reads `<PREFIX>_ACCESS_TOKEN` from `.dev.vars` (`GOOGLE_WORKSPACE_ACCESS_TOKEN`, `GITHUB_ACCESS_TOKEN`) as the held token and reports a connection when it is set.

The SDK: `integrationFetch(url, { env, provider, for, account? })`; `integrationStatus` returns the new fields; `connectUrl({ env, provider, returnTo?, account? })` builds `<gateway>/connect/<id>?return=…` from the gateway URL the app already knows (`EVERYAPP_GATEWAY_URL`, the identity issuer).

## 8. Scopes

As the scopes design says: a preset carries sets; an app declares the sets it needs under `scopes`; the strict validator refuses an unknown set name for a provider that has sets; a provider without sets takes no `scopes`. The consent asks the union (section 5). Enforcement at the proxy is the matcher the scopes design built, now live (section 7). The catalog's Google and Microsoft sets are untouched: a Gateway-owned Google connection asks `identity`, `search-console.read` and `analytics.read` for OpenSEO, the same strings as today's app-driven flow.

## 9. Events, Activity, surfaces

Events (`events.ts`, `catalogue.ts`, group `provider`): `provider.added` and `provider.removed` (kept; `data.provider.kind` added: `api_key` | `oauth`), `provider.updated` (a client replaced, a spec replaced), `provider.connected`, `provider.disconnected`, `provider.connection_expired`, each with `{ provider: { id, name }, account: { kind, label? }, scopeSets? }` and the actor; no key may match the never-log pattern. Calls through the held-token branch count in Usage like every proxied call; Activity stays the tools audit.

Surfaces, each a row of the parity matrix in the same PR:

| Action | UI | CLI | MCP |
| --- | --- | --- | --- |
| List providers (kind, client source, connections count) | Admin → Providers | `everyapp provider list` | `everyapp_provider_list` |
| Add an OAuth provider (preset or custom) | Add OAuth provider dialog | `everyapp provider add --oauth <preset \| file>` | `everyapp_provider_add` (`{ preset }` or a spec; names only) |
| Upload or replace the client | the same dialog, Replace client | `everyapp secret set <ID>_CLIENT_ID <ID>_CLIENT_SECRET` (binds) | no MCP: a secret never travels in a tool argument |
| Show the redirect URI | the dialog | `everyapp provider show <id>` | `everyapp_provider_list` carries `redirectUri` |
| Remove a provider | Remove | `everyapp provider remove <id>` | `everyapp_provider_remove` |
| Connect | Connect button (Settings, Admin, an app via `connectUrl`) | no CLI: a browser flow | no MCP: a browser flow (`connectPath` is reported) |
| List connections | Settings → Connected accounts (own), Admin → Providers (all) | `everyapp provider connections [--all]` | `everyapp_provider_connections` |
| Disconnect | Disconnect | `everyapp provider disconnect <id> [--user <email> \| --organization]` | `everyapp_provider_disconnect` |

The CLI uploads a client as Worker secrets (`secret set`, which it already does for rows); it cannot write the D1 ciphertext because the key lives in the Worker. `provider add --oauth` prints the redirect URI and the `secret set` line, or takes `--client-id` and the secret on stdin (`GITHUB_CLIENT_SECRET=…`, the `configure` convention) and sets both at once.

## 10. PRs

1. **SDK**: the `oauth2-user` spec kind, presets, `flow` on the four catalog entries, dialects `space`/`comma`, `providerBindingKey` for OAuth, `integrationFetch` `account`, `connectUrl`, status types, the dev twin's held token, the generated catalog tables.
2. **Gateway**: migration 0015, `sealed.ts`, the clients store, the connections store, `/connect/<id>` and its callback, refresh and revoke, the held-token proxy branch, status, events, server functions for Admin and Settings, tests with a fake provider.
3. **UI**: Admin → Providers (list, Add OAuth provider, Replace client, Remove, Connections), Settings → Connected accounts, the redirect URI shown.
4. **CLI and MCP**: `provider add --oauth`, `provider presets`, `provider connections`, `provider disconnect`, the tools, the parity matrix, `cli.md`.
5. **Docs**: `providers.md`, `secrets.md`, `mcp.md`, `events.md`, `errors.md`, `json.md`, the user page "Connect GitHub (or any OAuth provider)", the build skill's rule 7 and patterns rows, the threat model rows, TODO "OAuth providers (2026-10-25)".
6. **Proof**: OpenSEO on the port checkout reads Search Console through the proxy with the Gateway's Google connection (second path, the app-driven first path untouched); a vitest harness runs the whole flow against a fake provider; the browser reaches Google's and GitHub's consent screens with the right redirect URI and scopes.

## 11. Defaults taken for Ben

- Clients pasted in the UI live in D1, the secret sealed with a key derived from `BETTER_AUTH_SECRET`; a CLI-set Worker secret of the same name wins. Alternative: Worker secrets only (the UI would need a Cloudflare token).
- A client is gateway-wide, as a row's key is; connections are per organization and per person. Alternative: per-organization clients on hosted gateways (parked with the rest of hosted multi-tenancy).
- The callback lives at `/connect/<id>/callback` on the Gateway host, one per provider.
- Google is never revoked at Google on disconnect (section 5).
- Presets become rows when added (editable, visible in `provider show`); catalog OAuth entries stay entries and take a client only.
- Adding, replacing and removing a provider is owner or admin; connecting one's own account any member; the organization's account owner or admin.
- A token response with no `scope` is taken as granted-as-requested for the `space` and `comma` dialects.
- The CLI never writes the D1 ciphertext: it uploads a client as Worker secrets.
