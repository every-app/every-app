# Google (Search Console, Analytics) as a gateway integration: design

Written 2026-10-15. Four independent designs were judged by three panels, synthesized, attacked
by three reviewers (security, hosted tenancy and operations, OpenSEO buildability) and revised.
It is the brief for the Google stack in TODO.md and supersedes the Google parts of
[capabilities.md](../capabilities.md) (then `integrations.md`) and of the research design on `research/app-integrations`.
Paths prefixed `EA:` are in this repository, `OS:` in OpenSEO, `PoC:` on the
`poc/github-integration` branch. Line numbers are as of that date.

**Names since this was written.** Phase 0 landed on `main` (PR "Land phase 0, part 1") with the manifest key `capabilities` instead of `integrations`, each entry `{ access, why }` without `as` or `background`, the registry in `packages/sdk/src/internal/capabilities.ts` (`CAPABILITIES`, `CapabilityId`, `isCapabilityId`), the refusal `capability_not_requested` instead of `integration_not_requested` (and no `integration_needs_user`), `x-everyapp-error` owned by the SDK (`GATEWAY_ERROR_HEADER`, read with `gatewayRefusal()`), and `docs/integrations.md` renamed to [docs/capabilities.md](../capabilities.md). The route stays `/api/integrations/<id>/<host>/<path>` and the SDK calls stay `integrationFetch` and `integrationStatus`. Read the references below with those names; the line numbers are those of the uncommitted tree.

**What this design is for.** Ben's direction: Google is a top-level gateway integration; an org admin connects it at the gateway; the operator holds the OAuth client; the org's connection is shared by its approved apps including background work; no backward compatibility. **Revised 2026-10-16** after Ben settled the hosted shape and after reading the hosted-platform research (`docs/research/2026-10-hosted-platform/README.md` on `research/hosted-platform`, PR #299): hosted has two kinds of apps. *First-party catalog apps* such as OpenSEO run as **one shared Worker per app** (the research's `tier='platform'`), multi-tenant over one Postgres, serving every organization on the gateway; that Worker carries no organization in its binding props, so the gateway learns the organization per call (§6, §7). *Third-party apps* (organization apps, forks, instance-per-organization catalog apps) run **one Worker per organization on Workers for Platforms** (`tier='dispatch'`), and the deploy service writes their binding props, so the organization comes from props as it does on self-host today. The first draft's "hosted v1 = `self_hosted` mode, the operator deploys per organization, about 200 organizations under the 500-Workers cap" framing is withdrawn: a shared Worker has no per-organization Worker count. §10 lists every point where this design and the research meet.

---

## 1. Model

| Object | Who creates it | Where it lives | Google | GitHub (later) | DataForSEO / Context | Slack (later) |
|---|---|---|---|---|---|---|
| **Provider pack** (code: `credential.kind`, hosts with scope and path prefixes, `readPosts`, scope catalog, `approval`) | us | `EA:packages/sdk/src/internal/integrations.ts` (apps, dev), per-provider entry schema in `EA:packages/perimeter/src/manifest/manifest.ts`, enforcement in `EA:apps/every-app-gateway/src/server/integrations/<provider>.ts` | `kind: "oauth"`, `approval: "admin"` | `kind: "github_app"`, `approval: "admin"` | `kind: "api_key"`, `approval: "deploy"` | `kind: "oauth"` |
| **Operator provider client** | the operator, once | gateway Worker secrets `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (`OPTIONAL_SECRETS`, `EA:apps/every-app-gateway/cloudflare.config.ts:27`; `SETTABLE_GATEWAY_SECRETS`, `EA:packages/cli/src/lib/gateway/secretsFile.ts:11`) | yes | decided when GitHub ships | the key itself | yes |
| **Organization account** (one connected identity, sealed credentials, status) | an org owner/admin via a connect link | D1 `integration_accounts`, sealed under the org's DEK | a Google `sub`; several per org | an installation | later: a pasted per-org key (`kind: "api_key"`, redesign #13) | a workspace bot token |
| **App grant** (app X may use provider P: `access`, `scopes`, optional `account_ids`) | the manifest asks at deploy; auto-approved for `approval: "deploy"` packs, else an admin decides | D1 `app_integration_grants` | admin | admin | auto (read) | admin |
| **Person** | invitation / Access | gateway `users`, `members(role)` (`EA:src/db/auth.schema.ts`) | `connected_by_user_id` for audit; the identity on a call | | | |
| **Caller identity** (`{ organizationId, appId, appRowId, workerName, orgSource }`) | resolved by the entrypoint | self-host and the dispatch tier: service-binding props, written by the operator's CLI or by the hosted deploy service; the platform tier: props name the app and Worker with `trust: "catalog"`, and the organization comes from the identity JWT or, for background work, from `x-everyapp-org` checked against the organization's install row (research H17a) | the key every account and grant query is scoped by; `appRowId` is the install row on the platform tier | | | |
| **App-side binding** (project → account id) | the app's own UI | the app's D1 (`OS:src/db/gsc.schema.ts:25` `gsc_account_id`) | the gateway never knows projects | | | |

**Aligned (#8):** the client is a Worker secret, not a D1 row: nothing under `organizationAdminMiddleware` (`EA:src/middleware/auth.ts:78-91`) can read a secret into a page, which is Ben's rule made structural. The PoC's per-org `integration_clients` (`PoC:src/db/integrations.schema.ts:26-47`) is not created. Names stay `GOOGLE_OAUTH_*` rather than the redesign's `GOOGLE_CLIENT_*` because OpenSEO's hosted social login reads `GOOGLE_CLIENT_ID` (`OS:src/lib/auth.ts`) and the dev gateway-lite will read the app root's `.dev.vars`.

**Aligned (#2):** the manifest entry loses `as` and `background`. An approval is of the app; attribution comes from the identity header; org connections always permit background use (Ben). `integration_needs_user` disappears. For write-capable packs later, an absent identity is read-only unless the admin ticks "allow background writes" (recorded in the approved JSON) — see §6.

**Aligned (#1):** Google lands on the single `ProviderPack` registry and the single `gatewayFetch`. The fold of `openai`/`openrouter` into the same pipeline is Stack 1 PR B of the redesign and is not re-estimated here; this stack only requires PR A (the `ProviderPack` interface with `credential.kind`).

---

## 2. Data

Migration `EA:apps/every-app-gateway/drizzle/0033_integrations.sql` (last is `0032_accounts_provider_account_unique.sql`; the PoC also carries a `0033` — the PoC branch is tagged `archive/poc-github-integration` and deleted after PR 6 lands, noted in TODO.md). Schema `src/db/integrations.schema.ts`, registered in `src/db/schema.ts`.

**`organizations`**: add `status TEXT NOT NULL DEFAULT 'active'` (`active | deleting`), read by `resolveOrgContext` and the proxy (§3.9).

**`integration_org_keys`**: `organization_id` PK FK cascade, `kek_id TEXT NOT NULL`, `wrapped_dek TEXT NOT NULL`, `created_at`, `rewrapped_at`.

**`integration_accounts`** (PoC: `id, organization_id, provider, external_id, label, account_type, status, updated_at`, no tokens): `id` (`iacc_` + 26 base32), `organization_id` FK cascade, `provider`, `kind` (`oauth | api_key | github_app`), `external_id` (Google `sub`), `label`, `email`, `connected_by_user_id` FK `users` SET NULL, **`client_id TEXT`** (the issuing client; **Changed:** detects client rotation), `granted_scopes TEXT NOT NULL DEFAULT '[]'`, `access_token_enc`, `access_token_expires_at`, `refresh_token_enc`, **`refresh_token_issued_at`**, `secret_enc` (api keys later), `key_id`, `token_version INTEGER NOT NULL DEFAULT 0`, `refresh_lease_until`, `refresh_failures INTEGER NOT NULL DEFAULT 0`, **`last_refresh_attempt_at`** (backoff), `status` (`active | needs_reauth | revoked`), `status_reason` (`invalid_grant | client_rotated | scope_lost | admin_removed | provider_revoked | org_deleted`), **`revoked_at_google INTEGER`** (boolean), **`reauth_notified_at`**, `created_at`, `updated_at`, `last_used_at` (10-minute resolution), `last_refreshed_at`, `revoked_at`. Unique `(organization_id, provider, external_id)`; index `(organization_id, provider, status)`; **index `(provider, external_id, status)`** for the shared-identity check (§3.7).

**`app_integration_grants`** (PoC `request`, `approved`, `status`, `requested_at`, `decided_by`, `decided_at`, unique `(organization_id, app_slug, provider)`): add **`request_hash TEXT NOT NULL`** (`sha256(request JSON)`, the TOCTOU guard), `account_ids TEXT` (JSON; null = all), `default_account_id` FK SET NULL, `revoked_at`.

**`integration_connect_links`** (replaces the PoC's stateless HMAC `setupState.ts`, which cannot be single-use): `id` (32 random bytes base64url = OAuth `state`), `organization_id`, `provider`, `user_id`, `app_slug` null, `scopes` JSON, `purpose` (`connect | reauth`), `reauth_account_id`, `return_to`, **`error_return_to`** (**Changed:** both validated at creation), `expires_at` (10 min), `consumed_at`. PKCE verifier = `base64url(HMAC-SHA256(HKDF(activeKEK, "every-app:integrations:pkce"), id))` (OpenSEO's trick, `OS:src/server/features/google/googleOAuthState.ts:36-56`). Consume: `UPDATE ... SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>? RETURNING *`. Insert deletes older unconsumed links of the same `(organization_id, user_id)` beyond 5.

**`integration_events`** (**Changed** for write volume): surrogate `id` PK, unique `(organization_id, provider, account_id, app_slug, actor_key, event, host, method, minute)`, `count`, `last_status`, `user_id`, `tool_call_id`, `worker_name`, `detail` JSON (never tokens), `created_at`, `updated_at`; indexes `(organization_id, updated_at)` and `(minute)` so a global prune uses an index. `actor_key` ∈ `user:<id>`, `agent:<act.sub>`, `background`, `expired`, `admin:<id>`. Events: `call`, `accounts_listed`, `refresh`, `refresh_failed`, `connect`, `reauth`, `scope_added`, `disconnect`, `grant_requested`, `grant_approved`, `grant_denied`, `grant_revoked`, `grant_narrowed`, `needs_reauth_notified`, `org_delete_revoke`.

**`integration_usage`**: PK `(organization_id, provider, account_id, app_slug, day)`, `calls`, `errors`, `cost_micros`. Kept: events say who, usage says how much and is what spend caps read (redesign #14).

**Encryption. Changed (keyring).** One Worker secret cannot be rotated in place: `cf deploy --secrets-file` replaces the named value (`EA:packages/cli/src/lib/cf/deploy.ts:153`), so a single `INTEGRATIONS_KEK` would orphan every wrapped DEK on rotation. The secret is a keyring: `INTEGRATIONS_KEKS` = JSON `{ "active": "k1", "keys": { "k1": "<base64 32 bytes>" } }`. `integration_org_keys.kek_id` picks the unwrap key; sealing always uses `active`; row ciphertext is `v2.<kek_id>.<iv>.<ct>` with AAD `${orgId}:${accountId}:${column}`. The DEK row is created with `INSERT OR IGNORE ... ; SELECT wrapped_dek` and the token is always sealed with the row's DEK (the create-on-first-use race cannot orphan a row). Unwrapped DEKs are cached per `(orgId, kek_id)` in the isolate. Rotation is cron-driven, no operator auth needed: the hourly maintenance run rewraps up to 500 `integration_org_keys` rows whose `kek_id != active`; `everyapp gateway integrations rewrap` adds `k2` as active, redeploys, polls `integration_org_keys` through the gateway D1 the CLI already locates (`findGatewayDatabase`, `EA:packages/cli/src/commands/app/deploy/deployApp.ts:553`) until no `k1` rows remain, then drops `k1` and redeploys. **Changed:** no `missingGeneratedSecrets` on the public `/api/deploy/status` (it would advertise which gateways lack the key); the CLI decides locally with `cf secret list` (names only) and generates the keyring when absent, both in `gateway upgrade` and in `firstDeploySecrets`; `secret set` refuses the name. Honest limit (§6): D1 Time Travel keeps deleted ciphertext restorable for 30 days, so the FK cascade is not a crypto-shred; revocation at Google is the shred, and dropping an old `kek_id` after rewrap is how backups die.

---

## 3. Flows

### 3.1 Operator sets up the Google client
Self-host: `/admin/integrations` shows the checklist only when `deploymentMode === "self_hosted"` and `env.GOOGLE_OAUTH_CLIENT_ID` is unset; `everyapp gateway integration setup google` prints the same text. **Changed (tenancy):** on a multi-org or hosted gateway the card reads "Google isn't enabled on this gateway yet" with a support link and no commands; proxy refusals carry codes and `adminUrl` only, never CLI text (today `EA:src/server/integration-proxy.ts:121-125` tells apps to run `everyapp gateway secret set`). Steps: (1) Cloud project; enable Search Console API, Analytics Admin API, Analytics Data API. (2) Consent screen: *Internal* only if every connecting identity is in that Workspace; else *External* and **publish** (Testing = listed test users only, 7-day refresh-token expiry; In production unverified = interstitial plus a 100-new-user cap until verified). (3) Web client, one redirect URI `${GATEWAY_URL}/api/integrations/google/callback`. (4) `pnpm everyapp gateway secret set GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=...`. Moving from OpenSEO's own client: do not reuse it (§7: that client also powers app.openseo.so sign-in, changing its redirect URIs re-runs brand verification, and Google enforces one brand per Cloud project); the gateway gets its own project and client, an admin connects once per org, and each project re-picks its property. Rotation runbook: rotate the **secret** (Google allows two active secrets), never the **id**; a new id invalidates every refresh token.

### 3.2 Org admin connects a Google account
1. Admin page "Connect Google" → `startIntegrationConnect({ provider: "google", scopes, returnTo?, errorReturnTo?, purpose?, reauthAccountId? })` under `organizationAdminMiddleware`; or an app's connect link lands the admin on `/integrations/connect/$linkId`. That page refuses unless `session.user.id === link.user_id` and **`requireLiveOrgRole(userId, orgId)`** (a direct `members` query; **Changed:** `resolveOrgContext` is cached 30 s per isolate, `EA:src/server/organization/orgContext.ts:16`) reports owner/admin; shows "OpenSEO asks to connect Google (Search Console, Analytics; read-only) for Acme"; a form POST starts the redirect (as `EA:src/routes/oauth/consent.tsx` does).
2. Redirect to `https://accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri`, `response_type=code`, `scope = openid email <scope URLs>`, `access_type=offline`, `include_granted_scopes=true`, `state=<linkId>`, `code_challenge` S256, `login_hint` on re-auth. **Changed:** `prompt=consent select_account` only when no refresh token is stored for `(org, sub)` or on explicit re-auth after `invalid_grant`; otherwise `prompt=select_account`, falling back to `prompt=consent` when Google's answer omits `refresh_token`. Each consent mints a new refresh token that counts toward Google's 100-per-(identity, client) cap across every org on the shared client.
3. `GET /api/integrations/google/callback?code&state` (`EA:src/routes/api/integrations/google/callback.ts`): consume the link atomically; session user = `link.user_id`; live role owner/admin; exchange at `https://oauth2.googleapis.com/token` with the verifier; verify `id_token` against Google's JWKS with `aud = client id` (port of `OS:googleIdToken.ts`, returning `sub` and `email`); omitted `scope` = full grant (`OS:googleOAuth.ts:294-303`), else `scope_not_granted`; on `purpose: "reauth"` with `sub !== account.external_id`: **Changed:** if that `sub` already has a row in this org, treat it as a normal connect for that row; otherwise `reauth_account_mismatch` and the stray token is revoked only if no org holds that `sub`; upsert on `(org, google, sub)` with `refresh_token_enc = coalesce(new, existing)`, `refresh_token_issued_at`, `client_id = env.GOOGLE_OAUTH_CLIENT_ID`, `granted_scopes = union`, `status = active`, `status_reason = NULL`, `token_version + 1`; event `connect | reauth | scope_added`.
4. Redirect: success → `return_to`; user-fixable failure → `error_return_to` (or `return_to`) with only `&error=<code>` appended (**Changed:** the gateway never emits OpenSEO's `google_link_error=<gsc|ga4>` key, `OS:src/client/features/integrations/googleLinkError.ts:24-25`; OpenSEO bakes it into `errorReturnTo`); invalid link → gateway error page. Codes: `access_denied`, `admin_policy_enforced`, `org_internal` (Internal client, outside identity), `scope_not_granted`, `state_mismatch`, `not_an_admin`, `reauth_account_mismatch`, `exchange_failed`.
5. **Incremental consent:** an approved grant needing a scope no account holds → status `reason: "needs_reauth"` with `missingScopes`, proxy `428 integration_account_scope_missing`, admin card "Add Analytics to <email>" → same flow, `purpose: "reauth"`, union of scopes.

### 3.3 An app asks; an admin approves
1. `everyapp app deploy` → `AppRegistrationService.markDeployed` (`EA:src/server/services/AppRegistrationService.ts:562-580`) → `IntegrationService.syncAppRequests` (ported from `PoC:IntegrationService.ts:268-301`, iterating every pack), in try/catch reporting `integrations: [{ provider, status: "error" }]` rather than aborting the upload. `saveRequest` writes `request_hash`; an unchanged hash leaves `status` and `requested_at` alone (a redeploy of the same request does not re-pend).
2. `statusForRequest`/`covers`/`effectiveGrant` (`PoC:grants.ts:24-89`) generalized to `scopes`. `approval: "deploy"` packs with `access: "read"` auto-approve; `approval: "admin"` packs pend. No creator-role auto-approval.
3. The CLI prints `INTEGRATION_NOT_APPROVED` with `${gatewayUrl}/admin/integrations` (`PoC:deployApp.ts:390-406`). Redesign #12 (readiness at `registerApp`) is a later unit.
4. On `/admin/integrations`: "OpenSEO wants Google: Search Console (read), Analytics (read), because: …; apps use the organization's connection, including without anyone signed in". **Changed (TOCTOU):** `getIntegrations` returns `requestHash` per request; `decideIntegrationRequest({ appSlug, provider, decision, requestHash })` runs `UPDATE ... SET status=?, approved=<the JSON the admin saw> WHERE organization_id=? AND app_slug=? AND provider=? AND request_hash=?`; 0 rows → `INTEGRATION_REQUEST_CHANGED`, UI "this app's request changed; review it again". Narrowing: `narrowIntegrationGrant`, `setGrantDefaultAccount`.

### 3.4 An app lists accounts and gets a fetch
1. `integrationStatus({ env, provider: "google" })` → `GET /api/integrations/google` over the binding → `{ ready, source, requested, approved, reason, missingScopes?, grant, accounts, adminUrl, deploymentMode }`. **Changed:** `accounts` is `[]` and `email`/`scopes` are omitted unless `approved === "approved"`; the status route runs the same caller and identity checks as a call (status-before-identity at `EA:integration-proxy.ts:70-82` goes); accounts are filtered to `account_ids` and to accounts whose `granted_scopes` **overlap** the grant (any, not all: an admin who connected from the Search Console card holds one scope and must still be listed); an `accounts_listed` event is written.
2. `gatewayFetch({ env, provider: "google", for, account })` sends `x-everyapp-integration-account: <id>` to `/api/integrations/google/<host>/<path>`. **Aligned (#5):** `for: Request | { background: true; organizationId? }` is required; a platform-tier app names the organization for background work and the SDK sends it as `x-everyapp-org` (§6).
3. Proxy order (`EA:src/server/integrations/proxy.ts`, `deps` seam): caller identity (entrypoint) → **organization resolution** (props on self-host and the dispatch tier; on the platform tier the identity JWT's `org_id`, else `x-everyapp-org` checked against the install row, else `400 integration_org_required`; a disagreeing header → `403 integration_org_mismatch`; `orgSource` logged, §6) → route: host in pack, then **`upstream.pathname` after `new URL` under the host's prefixes**, refusing raw `..`, `%2e`, `%2f` segments first (**Changed:** `parseIntegrationProxyPath`, `EA:packages/sdk/src/internal/integrations.ts:83-96`, checks only the host) → `403 integration_not_requested` → grant approved (10 s cache) else `403 integration_not_approved` → identity: present and forged (signature/audience/issuer/org) → `401 integration_identity_invalid`; well-formed but expired → continue as `attribution: "expired"`; absent → background → method: **"read-only" = GET/HEAD plus the pack's `readPosts`, for read grants and for `chan: "mcp"` without `mcp:write` alike** (**Changed:** the PoC's GET/HEAD-only rule at `PoC:proxy.ts:174` would 405 `searchAnalytics/query`, `index:inspect` and `:runReport`); other methods only for `access: "write"` with a non-agent or `mcp:write` identity → account: header id `WHERE organization_id = caller.organizationId AND id = ?` (foreign or forged → `404 integration_account_not_found`); none and one eligible → implicit; several → `409 integration_account_required` with labels → `needs_reauth` → `428 integration_needs_reauth { accountId, label, adminUrl }`; `revoked` → `409 integration_not_connected` → host's scope ∈ `granted_scopes ∩ approved.scopes` else `403 integration_scope_not_granted` → counters (read gates; increment in `waitUntil`) → token (3.5) → strip headers (`STRIPPED_HEADERS` **plus `x-everyapp-integration-account`**), set Bearer, `redirect: "manual"`, bodies ≤ 1 MiB buffered so one upstream 401 refreshes and retries once → strip `set-cookie` → `waitUntil`: event upsert, usage upsert, `last_used_at` at 10-minute resolution (`McpConnectionRepository`'s pattern, `EA:src/server/repositories/McpConnectionRepository.ts:52`). Per call: one counter read, one account read, one cached DEK; writes are one counter upsert, one event upsert, one usage upsert, and `last_used_at` at most every 10 minutes — recorded as a live-deploy check.

### 3.5 Token refresh
`EA:src/server/integrations/tokens.ts`, `accessTokenFor(account)`:
1. Per-isolate cache `Map<accountId, { token, expiresAt, tokenVersion }>`, **2,000 entries** with TTL (a hosted gateway holds on the order of 1,000 accounts).
2. Miss: read the row; `access_token_expires_at - now > 60 s` → open and use. **Changed (backoff):** if `refresh_failures > 0` and `now < last_refresh_attempt_at + min(2^failures, 300) s`, answer `502 integration_upstream_failed` without calling Google.
3. Lease: `UPDATE integration_accounts SET refresh_lease_until = now + 15 s, last_refresh_attempt_at = now WHERE id=? AND organization_id=? AND status='active' AND (refresh_lease_until IS NULL OR refresh_lease_until < now) RETURNING token_version, refresh_token_enc`. Not claimed → wait 250 ms with jitter, re-read, up to 3 times; then refresh anyway (Google does not rotate web-client refresh tokens).
4. `POST grant_type=refresh_token` → `UPDATE ... SET access_token_enc, access_token_expires_at, refresh_token_enc = coalesce(new, old), token_version+1, refresh_lease_until=NULL, refresh_failures=0 WHERE id=? AND token_version=?`.
5. **Changed (error map):** `400 invalid_grant` → if `row.client_id !== env.GOOGLE_OAUTH_CLIENT_ID` then `status_reason='client_rotated'` else `'invalid_grant'`; `status='needs_reauth'`, `access_token_enc=NULL`, CAS on `token_version`; event `refresh_failed`. `401 invalid_client` / `unauthorized_client` → `503 integration_not_configured`, status unchanged, logged at error (a secret-rotation window must never flip rows). 5xx/network → clear lease, `refresh_failures+1`, `502`.
6. **Changed (push):** inside the CAS that sets `needs_reauth`, when `reauth_notified_at IS NULL OR < revoked/transition time`, `waitUntil` one email to the org's owners and admins through `sendEmail` (`EA:src/server/email/sendEmail.ts:179-190`, `EMAIL` binding at `cloudflare.config.ts:135`) with the Reconnect link, set `reauth_notified_at`, event `needs_reauth_notified`; the gateway home shows an admin banner. The call still answers 428; status carries `status`.

### 3.6 Re-auth
Admin page or OpenSEO's in-picker "Reconnect" → 3.2 with `purpose: "reauth"`, `reauthAccountId`, `login_hint`, `prompt=consent`. Account ids are stable.

### 3.7 Disconnect
`disconnectIntegrationAccount({ accountId })`: **Changed (shared client):** Google revocation is per (user, project), not per token, so first `SELECT count(*) FROM integration_accounts WHERE provider=? AND external_id=? AND organization_id<>? AND status='active'`. If > 0: null both token columns, `status='revoked'`, `status_reason='admin_removed'`, `revoked_at_google=0`, and the admin sees "Google still lists Every App for <email> because another workspace uses it; the account holder can remove it at myaccount.google.com/permissions". If 0: `POST https://oauth2.googleapis.com/revoke` (400 `invalid_token` counts as done, `OS:src/server/gdpr/storage-erasure.ts:154-166`), then the same nulling with `revoked_at_google=1`. Event `disconnect`. Grants stay; apps get `409 integration_not_connected`; OpenSEO keeps the project row (§5). Revoked rows purge after 30 days.

### 3.8 The member who connected leaves
Nothing changes: the account is the org's; `connected_by_user_id` goes null; the admin page says "connected by a former member". Google cutting their access → `invalid_grant` → `needs_reauth` → email → another admin reconnects. This answers `EA:TODO.md:46`: yes to the workspace and yes to background.

### 3.9 Organization deleted
**Changed (two-phase):** `OrganizationService.delete(orgId)`: (1) `UPDATE organizations SET status='deleting'`; `resolveOrgContext` and the proxy refuse the org (`caller_not_active`); (2) synchronously, before any DELETE, read and open every active account, apply the §3.7 shared-identity rule, revoke at Google where this org held the identity's last row, null token columns, write `org_delete_revoke` events, retry failures up to 3 times; (3) only then `OrganizationRepository.deleteById` (`EA:src/server/repositories/OrganizationRepository.ts:54-57`) and the FK cascade. A `waitUntil` revoke after the cascade would find no DEK to open and leave live tokens at Google forever.

### 3.10 Agents through MCP
ToolBus mints `chan: "mcp"`, `scopes`, `tc` (`EA:packages/toolbus/src/execute.ts:212-226`). **Aligned (#5):** OpenSEO seeds an `AsyncLocalStorage` request scope from the SDK's verified `{ user, request }` in `everyAppTool` handlers (`OS:src/server/everyapp/tools.ts:88`) and in `handleEveryAppRequest`; Google calls pass `for: currentRequest() ?? { background: true }`. The proxy applies read-only (moot for Google) and writes `actor_key = agent:<act.sub>`, `tool_call_id` joining `mcp_tool_calls.id`. SAM has no request (`OS:SamChatAgent.ts:357-367`) and runs as `background`. `inspect_urls` caps at 10 URLs (`OS:search-console-tools.ts:485`), inside the 120 s identity TTL. Background fan-out: the SDK jitters `{ background: true }` scheduled work by `hash(orgId) mod 300 s`, documented for crons.

---

## 4. Interfaces

**Manifest entry** (`EA:packages/perimeter/src/manifest/manifest.ts`, replacing `:136-150`); **Aligned (#2):**

```ts
export const IntegrationRequestSchema = z.object({
  access: z.enum(["read", "write"]).default("read"),
  why: z.string().min(1).max(300).optional(),
});
export const GoogleIntegrationRequestSchema = IntegrationRequestSchema.extend({
  /** Google scopes by short name. */
  scopes: z.array(z.enum(["webmasters.readonly", "analytics.readonly"])).min(1),
});
// IntegrationsSchemaStrict = z.record(id, entrySchemaFor(id)); unknown ids refused as today (:158-170).
```
OpenSEO (`OS:everyapp.config.ts`): `google: { access: "read", scopes: ["webmasters.readonly", "analytics.readonly"], why: "Search Console performance and URL inspection, and Analytics reports, for each project's site." }`.

**Provider pack** (`EA:packages/sdk/src/internal/integrations.ts`):

```ts
export type ApiKeyIntegrationId = "dataforseo" | "context";
export type OAuthIntegrationId = "google";
export interface OAuthProviderPack {
  credential: { kind: "oauth" };
  label: string;
  approval: "admin";
  hosts: Record<string, { scope: string | null; paths: readonly string[] }>;
  readPosts: readonly RegExp[];
  scopes: Record<string, { url: string; label: string }>;
  baseScopes: readonly string[];
  dev: { clientId: string; clientSecret: string; refreshToken: string };
}
google: {
  credential: { kind: "oauth" }, label: "Google", approval: "admin",
  hosts: {
    "www.googleapis.com":            { scope: "webmasters.readonly", paths: ["/webmasters/v3/"] },
    "searchconsole.googleapis.com":  { scope: "webmasters.readonly", paths: ["/v1/urlInspection/"] },
    "analyticsadmin.googleapis.com": { scope: "analytics.readonly",  paths: ["/v1beta/", "/v1alpha/"] },
    "analyticsdata.googleapis.com":  { scope: "analytics.readonly",  paths: ["/v1beta/"] },
    "openidconnect.googleapis.com":  { scope: null,                  paths: ["/v1/userinfo"] },
  },
  readPosts: [/\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/, /\/v1\/urlInspection\/index:inspect$/,
              /:runReport$/, /:batchRunReports$/, /:runRealtimeReport$/, /:runPivotReport$/, /:checkCompatibility$/],
  scopes: { "webmasters.readonly": { url: "https://www.googleapis.com/auth/webmasters.readonly", label: "Search Console" },
            "analytics.readonly":  { url: "https://www.googleapis.com/auth/analytics.readonly",  label: "Google Analytics" } },
  baseScopes: ["openid", "email"],
  dev: { clientId: "GOOGLE_OAUTH_CLIENT_ID", clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET", refreshToken: "EVERYAPP_DEV_GOOGLE_REFRESH_TOKEN" },
}
export const INTEGRATION_ACCOUNT_HEADER = "x-everyapp-integration-account";
export const GATEWAY_ERROR_HEADER = "x-everyapp-error";
export const INTEGRATION_REFUSALS: Record<IntegrationErrorCode, { status: number; kind: "identity" | "app_manifest" | "approval" | "connection" | "transient" | "gateway_setup" }>;
export function requiredScopeFor(id: IntegrationId, upstream: URL): string | null | undefined; // undefined = path not allowed
```
Hosts are those `OS:src/server/lib/gscClient.ts:7-8` and `OS:ga4Client.ts:12-16` call. Token, revoke and JWKS code lives in `EA:src/server/integrations/google/oauth.ts`, not the SDK.

**SDK** (`EA:packages/sdk/src/server/gatewayFetch.ts`; `integrationFetch.ts` and `createGatewayFetch` are removed, **Aligned (#1, #5, #9)**):

```ts
gatewayFetch({ env, provider, for: Request | { background: true; organizationId?: string }, account?: string }): typeof fetch  // organizationId: required for background work on the platform tier
integrationStatus({ env, provider, for }): Promise<IntegrationStatus>      // throws IntegrationError on refusal
integrationConnectLink({ env, provider, for: Request, scopes?, returnTo, errorReturnTo?, reauthAccountId? }):
  Promise<{ url: string; expiresAt: string } | { adminRequired: true; adminUrl: string | null; hint?: string }>
class IntegrationError extends Error { code: IntegrationErrorCode; status: number; kind: RefusalKind; accountId?: string; adminUrl?: string | null }
readGatewayRefusal(response: Response): Promise<IntegrationError | null>
type OrgRole = "owner" | "admin" | "member";   // re-exported, redesign #4
interface IntegrationStatus {
  ready: boolean; source: "operator_default" | "organization" | null; requested: boolean;
  approved: "approved" | "pending" | "denied" | "none"; deploymentMode: "self_hosted" | "hosted";
  reason: "not_requested" | "needs_approval" | "not_configured" | "needs_account" | "needs_reauth" | "org_required" | null;
  missingScopes?: string[]; grant: { access: "read" | "write"; scopes: string[] } | null;
  accounts: IntegrationAccount[]; adminUrl: string | null;
}
interface IntegrationAccount { id: string; label: string; email: string | null; scopes: string[]; status: "active" | "needs_reauth"; updatedAt: string }
```

**Error vocabulary** (header + `{ error, code, kind, message, ... }`): `invalid_integration_route` 400 · `integration_identity_invalid` 401 · `integration_not_requested`, `integration_not_approved`, `integration_admin_required`, `integration_read_only`, `integration_scope_not_granted` 403 · `integration_account_not_found` 404 · `integration_method_not_allowed` 405 · `integration_account_required`, `integration_not_connected` 409 · `integration_needs_reauth`, `integration_account_scope_missing` 428 · `integration_rate_limited` 429 · `integration_upstream_failed` 502 · `integration_not_configured` 503 · `integration_org_required` 400 · `integration_org_mismatch` 403. Google's own 4xx/429 pass through with `Retry-After`.

**AppGateway binding routes**: `GET /api/integrations/<id>` (status); `POST /api/integrations/<id>/connect-links` (identity required, `chan === "web"`, live owner/admin, else `integration_admin_required`; **Changed:** agents refused since they cannot complete OAuth; 20 creations per `(org, app, hour)` in `rate_limit_counters` else `integration_rate_limited`); `ANY /api/integrations/<id>/<host>/<path>`.

**Gateway host**: `GET /api/integrations/google/callback`; `/integrations/connect/$linkId`; `/admin/integrations` tab (`EA:src/routes/admin.tsx:16-20`). Server functions (`src/serverFunctions/integrations.ts`, `organizationAdminMiddleware`): `getIntegrations`, `startIntegrationConnect`, `disconnectIntegrationAccount`, `decideIntegrationRequest({ appSlug, provider, decision, requestHash })`, `narrowIntegrationGrant`, `setGrantDefaultAccount`, `getIntegrationActivity`, `getIntegrationUsage`.

**CLI**: `everyapp gateway secret set NAME=VALUE [NAME=VALUE...]`; `everyapp gateway integration setup google`; `everyapp gateway upgrade` generates `INTEGRATIONS_KEKS` when `cf secret list` lacks it; `everyapp gateway integrations rewrap`; `everyapp app deploy` prints grant statuses; `everyapp dev google connect [--port 8788]`.

**`everyapp dev`. Aligned (#10), Changed:** the SDK's direct-to-provider fallback is deleted; the gateway-lite (`EA:packages/perimeter/src/dev/devGateway.ts`, which today serves no `/api/integrations`) runs the stateless proxy core from `@every-app/perimeter/integrations` with the app root's `.dev.vars` as credential source, on a loopback listener guarded by a per-run `EVERYAPP_DEV_GATEWAY_TOKEN`. For Google the team keeps **one Desktop-type client** (installed-app secrets are non-confidential; loopback redirects accept the fixed port 8788) with a **published** consent screen (no 7-day expiry), in `.dev.vars.example`/the password manager. `everyapp dev google connect --port 8788` listens on `http://127.0.0.1:8788/callback`, exchanges the code and writes `EVERYAPP_DEV_GOOGLE_REFRESH_TOKEN` via a new `upsertDevVar(appDir, key, value)` in `EA:packages/cli/src/commands/dev/devEnv.ts` (today's `upsertDevVars(appDir, publicKeyPem)` at `:66` is specialized). The lite refreshes in-process; on `invalid_grant` it answers `integration_needs_reauth` with `hint: "Run everyapp dev google connect again; the dev refresh token expired"`; `integrationConnectLink` in dev returns `{ adminRequired: true, adminUrl: null, hint }`, and OpenSEO renders the hint when `adminUrl` is null. `DEV_GATEWAY_KEYS` and `devGatewayKeys()` are deleted (`EA:packages/sdk/src/cloudflare/worker.ts:173-180`).

---

## 5. OpenSEO changes

**SDK bump first (Changed).** PR 8a opens by narrowing `KEY_ENV` (`OS:src/server/lib/provider-access.ts:73-76`) to `Record<ApiKeyIntegrationId, string>` and making `hasProviderAccess` catch `IntegrationError` → `false` (it must not throw on a gateway 5xx, which gates `SamSetupGate`); `provider-access.ts` and `openrouter.ts` move to `gatewayFetch` with `for`.

**The seam, `OS:src/server/features/google/googleAccess.ts`** (**Aligned #11**):

```ts
export type GoogleProduct = "gsc" | "ga4";
export interface GoogleAccess {
  mode: "own_client" | "gateway";
  configured(): Promise<boolean>;
  listAccounts(i: { userId: string; product: GoogleProduct }): Promise<Array<{ accountId: string; email: string | null; status: "active" | "needs_reauth"; updatedAt: string | null }>>;
  fetchFor(ref: { accountId: string; userId: string | null }, product: GoogleProduct): typeof fetch;  // reads currentRequest() itself
  connectUrl(i: { product: GoogleProduct; userId: string; callbackURL: string; reauthAccountId?: string }):
    Promise<{ url: string } | { adminRequired: true; adminUrl: string | null; hint?: string }>;
  canConnect(role: OrgRole): boolean;
  manageAccountsUrl(): string | null;
}
export async function getGoogleAccess(): Promise<GoogleAccess>;
```
`ownClientGoogleAccess.fetchFor` memoizes the token promise for the lifetime of the returned fetch (one mint per client instance, preserving `memoizedGa4AccessToken`, `OS:ga4Client.ts:158-164`; `listProperties` pages up to 100 times) and wraps every mint failure in the product's `TokenError` as `OS:gscClient.ts:87-100` does; a parity test asserts one `getGoogleAccessToken` call across N requests. `gatewayGoogleAccess.fetchFor` → `gatewayFetch({ env, provider: "google", account, for: currentRequest() ?? { background: true } })`.

**Error table (Changed; the "works verbatim" claim was false).** The wrapper throws typed errors on a refusal header; **both GA4 catch blocks** (`OS:ga4Client.ts:176-186`, `:422-437`) rethrow `Ga4TokenError`, `GoogleAccessError` and `AppError` instead of converting to status-0. Mapping in `googleAccess.ts`: `integration_needs_reauth`, `integration_not_connected`, `integration_account_scope_missing` → `GscTokenError`/`Ga4TokenError` (reconnect copy); `integration_account_not_found` → `GoogleAccessError("account_unavailable")` (copy "removed or narrowed on the gateway; choose another"); `integration_not_configured`, `integration_not_approved`, `integration_identity_invalid`, `integration_scope_not_granted`, `integration_org_required`, `integration_org_mismatch` → `GoogleAccessError(code)`; `integration_rate_limited` → `GscApiError(429)`/`Ga4DataApiError(429)` with `Retry-After`; anything else → `GscApiError(status)`. `isExpectedGrantFailure` (`OS:GscService.ts:86-92`), `Ga4Service.requiresReconnect` (`:34-39`), `mapGa4ReportError` and `DashboardSiteService`'s `connected:false` catch (`:132-138`) all treat `GoogleAccessError` as expected (no fault log, `connected:false`). Tests: one 428 refusal per client; `DashboardSiteService` and `GscService` with `not_approved`.

**Clients take a fetch.** `createGscClient({ fetch })`, `createGa4AdminClient({ fetch })`, `createGa4DataClient({ fetch, propertyId })`; `getToken`/`Authorization` leave both files.

**Request threading (PR 8b, Changed estimate).** No service input carries a request today (`Ga4ReportInput`, `OS:Ga4ReportingService.ts:28-43`; `inspectUrls`; `getMeasurementHealth(projectId)`). Instead of threading 22 call sites, `OS:src/server/request-context.ts` holds `requestScope = new AsyncLocalStorage<{ request: Request; identity: EveryAppUser | null }>()`, seeded in `handleEveryAppRequest` and `everyAppTool` (the `pgClientStore` pattern, `OS:src/db/pg/client.ts:25`); `fetchFor` reads it. `withMcpProjectAuth` (`OS:src/server/mcp/project-auth.ts:59-66`) and `ToolContext` need no shape change.

**Account ids.** `gsc_connections.gsc_account_id` becomes NOT NULL and `ga4_connections.ga4_account_id` holds the gateway `iacc_…` id; `connected_by_user_id` nullable, "who picked the property"; `connected_account_email` from the label. `getGscConnection`/`getGa4Connection` (`OS:src/serverFunctions/gsc.ts:38-56`) call `integrationStatus` **once** and derive `hasAccount`, `canConnect` (owner/admin and approved), `accountsManagedAt` (adminUrl), `gateway: { reason, adminUrl, hint }`, and **`accountStatus: "active" | "needs_reauth" | "unavailable"`** by cross-checking the bound id against `status.accounts` (**Changed:** a revoked or narrowed account otherwise vanishes from the picker with nothing to click). `DashboardSiteService` cache params add the account's `updatedAt`.

**UI.** `GoogleProjectEmptyState` and `GoogleConnectedState` use `canConnect` for Connect/"Manage Google accounts" (today `hasGrant` drives both, `OS:GoogleProjectEmptyState.tsx:35-58`, `GoogleConnectedState.tsx:41-50`); `GooglePropertyPicker` gains `canManageAccounts`, `manageAccountsUrl` and `onReconnect: (accountId?: string) => void` (**Changed:** today `() => void`, `:75`), hiding Remove/Add for members (`:224-233`, `:329-340`); `useGooglePickerResume.linkAccount(callbackURL, reauthAccountId?)` → `startGoogleLink(provider, callbackURL, reauthAccountId?)` handles `{ adminRequired }` with a toast and link (today it navigates to `url`, `OS:startGoogleLink.ts:55-57`); `startLinkSchema` adds `reauthAccountId?`. `errorReturnTo = callbackURL + "?google_link_error=<gsc|ga4>"` keeps `googleLinkError.ts` untouched. `GoogleConnectedState` banner for `needs_reauth` (Reconnect, admins) and `unavailable`. States: (1) not configured → `GoogleOAuthSetupWarning` everyapp branch keyed on `deploymentMode`: self-host "the gateway operator sets up Google at <adminUrl>", hosted "Google isn't available on this gateway yet"; (2) not approved → "An admin approves OpenSEO's Google access at <adminUrl>"; (3)–(8) as before with the gating above. `googleAuthErrorCopy.ts` gains `reauth_account_mismatch`, `not_an_admin`, `admin_policy_enforced`, `org_internal`. `GSC_API_DISABLED_MESSAGE` (`OS:src/server/lib/gscErrors.ts:1-2`) branches on `access.mode` and `setupDocsUrl` points at `adminUrl` in gateway mode.

**Bypassed in everyapp mode, kept for hosted/Access/local**: `googleOAuth.ts`, `googleOAuthState.ts`, `googleIdToken.ts`, `oauth-config.ts` (lazily imported by `ownClientGoogleAccess`); `/api/gsc/oauth/callback`, `/api/ga4/oauth/callback` 404; `GoogleAccountService/Repository`; `storage-erasure.ts` Google revocation (hosted only). `BETTER_AUTH_SECRET` stops being required for Google here.

**Preflight, status, MCP.** `selfhost-preflight.ts:137-147` gains the everyapp branch for `gsc` ("Held by the Every App gateway; an admin connects Google at <adminUrl>"); `setup-status.ts` ignores `GOOGLE_CLIENT_ID` here; `missingSelfHostedGoogleClientResponse` keeps `reason: "gsc_oauth_not_configured"` (contract kept; **Changed** from the rename) and adds `google_not_connected` with `actionUrl`. SAM: background. Secret names `GOOGLE_OAUTH_*` avoid OpenSEO's `GOOGLE_CLIENT_ID`. `docs/maintainers/every-app.md` and `.env.example` document the three dev vars and the migration from OpenSEO's own client.

---

## 6. Security

**Invariants.**
1. *Tokens and the client secret never leave the gateway.* Only `tokens.ts` opens ciphertext; no route returns one; the proxy strips `authorization`, `cookie`, identity, hop and account headers and sets its own; `set-cookie` dropped; `redirect: "manual"`.
2. *Only Google API hosts, https, allowed normalized paths.* Host allowlist, then `upstream.pathname` under the host's prefixes after WHATWG parsing, raw dot-segment encodings refused; the token endpoints are gateway code. A traversal test per host.
3. *Read-only by construction.* GET/HEAD plus `readPosts`; every catalog scope is `*.readonly`, so Google enforces it too.
4. *Scopes per app.* Approval covers scopes; host → required scope; `account_ids` narrowing. Honest limit: Google issues one access token with the account's whole scope set; per-app narrowing is gateway-enforced.
5. *Agents' read-only carry-through — bounded.* `chan === "mcp"` without `mcp:write` → GET/HEAD + `readPosts`. **Changed:** this holds only for calls that carry the identity; an app may call with `{ background: true }` and the event says `background`. For write-capable packs the proxy treats an absent identity as read-only unless the approved JSON carries `backgroundWrites: true`, ticked separately by the admin. Helpers are told apart once they present their own `workerName` (redesign #3), recorded on the event.
6. *Refresh under lease, CAS on write, backoff on failure, `needs_reauth` only on `invalid_grant`, `invalid_client` never flips rows, a null refresh token never overwrites a real one.*
7. *Audit.* Per-minute events for token use and account listing, one row per management action, no bodies or paths; `integration_usage` per day.
8. *Revocation.* Account removal revokes at Google only when this org held the identity's last row (shared-client rule); grant denial within 10 s; org deletion revokes synchronously before the cascade.
9. *Identity verified or refused.* A present forged header is 401; an expired one is background with `attribution: "expired"`.
10. *Approval is of what was shown.* `request_hash` in the decide UPDATE.

**Who the caller is, per tier (Revised 2026-10-16).** Service-binding `props` are written by whoever uploads the calling Worker (`gatewayBinding`, `EA:packages/sdk/src/cloudflare/worker.ts:544-559`), and the registry check (`EA:app-gateway-entrypoint.ts:109-119`) proves the (org, app) row exists, not that the caller is that Worker. That is fine wherever the uploader is trusted, which is every case we ship: on self-host the operator's CLI uploads every app; on the hosted dispatch tier the deploy service (research H10) builds the binding from the registry and tenants never write Worker metadata; on the hosted platform tier the Worker is ours. So there is **no multi-organization gate** and no `INTEGRATIONS_TRUSTED_DEPLOYERS` switch. What the platform tier needs instead is organization resolution per call: its props carry `{ appId, workerName, trust: "catalog" }` and no organization; for a call that carries an identity JWT the organization is the token's `org_id`; for background work the app sends `x-everyapp-org`, and the gateway accepts it only when that organization has an install row for the app (research H17a) and the grant covers the call; a header that disagrees with props or with the token is `403 integration_org_mismatch`, a platform-tier background call without one is `400 integration_org_required`; every event records `orgSource: "props" | "identity" | "asserted"`. A platform-tier app asserting an organization is trusted the way the gateway trusts its own code, which is why only first-party apps run on that tier (the hosted validator refuses `trust: "catalog"` for anything else). The gateway-issued HMAC caller credential from the first draft (`EVERY_APP_CALLER_SECRET`, `x-everyapp-caller`) is kept in TODO.md as a later hardening for a self-host gateway where several people deploy for several organizations; nothing in this stack depends on it.

**Threats on hosted.**
- *One org reaching another's account.* Every account and grant query is keyed by the verified `CallerIdentity.organizationId`; the identity JWT's `org_id` must match; a forged account id is 404; the DEK is per org with AAD, so moved ciphertext is unreadable even with D1 access.
- *Shared client, shared identity.* One Google identity connected in orgs A and B shares one project-level authorization: A's Remove would cut B. The §3.7 rule and `revoked_at_google` make this explicit; the residual is that a departing identity stays authorized at Google until its last org removes it or the person revokes it at Google.
- *Connect link.* Bound to one admin and one org, 10 minutes, consumed in one UPDATE, web channel only, rate-limited, live role check from `members` (not the 30 s cache) on both the consent page and the callback; the redirect starts from a form POST.
- *CSRF/state.* `state` is the server-side link id; PKCE S256 from an HMAC of the id.
- *Open redirects.* `return_to` and `error_return_to` are validated at creation: a gateway-origin path, or `https://<apps.hostname>` of the calling app in the same org (`EA:src/db/apps.schema.ts:27`); anything else → `/admin/integrations`; re-parsed to defeat protocol-relative tricks.
- *Approval race.* A deploy landing while the admin reads the request changes `request_hash`, so the click fails closed.
- *A malicious approved app can* read what its scopes and accounts allow, at any time; burn quota; see account emails. *It cannot* obtain a token or the client secret, reach another host or path, write, use accounts outside its narrowing, widen scopes without a redeploy that re-pends, act as another organization (a dispatch app's organization is fixed by props the deploy service wrote; a platform-tier app can only name organizations that installed it), or hide.
- *The operator.* **Changed:** the operator can decrypt every org's tokens (KEK and client in the Worker) and can mint identities (`JWT_PRIVATE_KEY`, `EA:cloudflare.config.ts:165`; `mintIdentityJwt` takes any subject, `EA:packages/sdk/src/internal/protocol.ts:257-285`); the hosted terms disclose this; every use leaves an org-visible event row; scopes are data-read only. Deleted-org ciphertext is restorable from D1 Time Travel for 30 days; revocation at Google (3.9) is the real erasure, and dropping a `kek_id` after rewrap shreds backups.

---

## 7. Hosted considerations

- **Two kinds of apps (Revised 2026-10-16).** First-party catalog apps run as one shared Worker per app (`tier='platform'`, for example `everyapp-cat-openseo`) with an install row per organization and no per-organization Cloudflare resources; third-party apps run one Worker per organization in a Workers for Platforms namespace (`tier='dispatch'`). Google accounts and grants are per organization on both tiers; what differs is how the organization is learned (§6). OpenSEO in Every App is a platform-tier app over its own multi-tenant Postgres, and its crons, Workflows and SAM run as background calls that name the organization.
- **One callback URL.** The consent flow starts and ends on the control-plane host (`/api/integrations/google/callback` on the gateway): one exact redirect URI, which is what Google requires; per-organization app hosts never see a Google callback. The research's relay through `app.openseo.so` (its H18 and H38) exists only for OpenSEO's own-client mode and is not needed once Google is a gateway integration.
- **Verification and publishing (Changed).** Two states, two caps: *Testing* = listed test users only, 7-day token expiry; *In production, unverified* = interstitial and 100 new users until verification. Hosted must publish before any admin connects without being hand-added, and each connecting admin counts toward the 100 until brand and scope review completes (sensitive scopes, no CASA). Submit verification before PR 5 starts: it is the external critical path. Use a Google Cloud project and OAuth client owned by the gateway's operator, separate from OpenSEO's verified client: adding the gateway's redirect URI to that client may trigger re-verification of its sensitive scopes (research R39, unverified). `access_denied` on the callback covers cancel, not-a-test-user and Workspace admin policy (`admin_policy_enforced`); the operator checklist distinguishes them.
- **Internal vs External.** Internal only when every connecting identity is in that Cloud Organization (breaks agencies connecting client Gmail accounts).
- **Forks (added 2026-10-16).** Ben ruled that organizations may deploy forks of OpenSEO as third-party apps on the dispatch tier, with Google still held by the gateway. Google's consent branding is per Cloud project and must name the entity that manages the application, so a fork's consent screen says "Every App" too; the fork's UI says "Connect Google via Every App" and the gateway admin page runs the flow, as on the platform tier. Every App carries the Limited Use obligations for whatever a fork does with the data, so fork terms pass Limited Use through, scopes stay read-only, and tokens never leave the gateway (the proxy, never a token handout). Business Profile scopes stay off the shared client: Google's Business Profile API policy forbids third parties using one project indirectly, and OpenSEO reads that data through DataForSEO anyway.
- **Refresh-token cap.** Google keeps 100 refresh tokens per (identity, client); each consent mints one; the oldest is silently invalidated. The gateway always holds the newest for its row, so that is harmless; `prompt=consent` only when needed (3.2) keeps the count low.
- **Client rotation.** Rotate the secret, never the id; `client_id` on rows reports `client_rotated` and an operator-wide count in logs.
- **Quota (published figures as the tenancy attacker read Google's pages; confirm before coding).** Search Analytics: 1,200 QPM per site and per user, 40,000 QPM / 30M QPD per project. URL Inspection: 600 QPM and 2,000 QPD per site, 15,000 QPM / 10M QPD per project. GA4 Data API per-property budgets are effectively per org. The shared pools are the per-project QPM figures. Counters in `rate_limit_counters` (`EA:src/server/repositories/RateLimitCounterRepository.ts`): per `(org, provider, minute)`; per `(account, minute)` 600 and `(account, day)` 2,000 for inspections; **gateway-wide `google:<host>:<minute>`** with budgets under Google's (30,000 for `www.googleapis.com`, 10,000 for `searchconsole.googleapis.com`) and a fair-share rule above 80 %: refuse only callers over their per-org share. `429 integration_rate_limited` with `Retry-After`; Google's own 429 passes through. `deleteExpired` (`:34-40`) is batched.
- **Write budget.** Per call ≤ 3 upserts plus a 10-minute `last_used_at`; events, usage, links, counters and revoked accounts prune in bounded batches with their own budgets and a `behind` log field (the MCP pattern, `EA:src/server/repositories/McpToolCallRepository.ts:7-13`). Live-deploy check: measure row writes per 1,000 proxied calls on thecomeup.cc.
- **Push, not pull.** `needs_reauth` emails owners/admins and banners the gateway home; without it a client rotation or Testing-mode expiry silently kills every org's background work.
- **Abuse.** Approval per app, narrowing, per-app counters, the activity page, `caller_not_active`; connect-link creation limited.
- **Spend caps.** Google is free. When keys go per org (redesign #13), `spend_cap_micros_month` on the account plus `cost_micros` in `integration_usage` → `429 integration_spend_cap_reached`.
- **Deploying.** A platform-tier app deploys once for every organization (the hosted release pipeline, research H27 and H17a); dispatch apps go through the deploy service (H10). Nothing in this stack deploys per organization.

---

## 8. Build plan

**The PoC is not merged as-is** (its entrypoint predates `routeFromPath`, its SDK has no host segment, `syncAppRequests` reads only `github`, `decide` is `z.literal("github")`). Named pieces (`grants.ts`, `IntegrationRepository`, `syncAppRequests`/`decide`, the `markDeployed` hook, `AppRepository.tombstone` grant deletion, the admin skeleton, the CLI warning) are ported by hand onto phase 0's route, registry and header. **Changed:** PR 0 rebases phase 0 onto `main` and merges it first so every agent branches from `main`, not a working tree. **Revised 2026-10-16:** `main` moved under the branch (the CLI redesign, PRs #284 to #298: `deployApp.ts` now lives under `commands/deploy/`, the deploy API and deploy tokens are gone, `orgContext.ts` is gone), and a trial merge conflicts in 11 files, so PR 0 is about a day, not a quarter.

Stack (details in the PR stack): PR 0 phase 0 → PR 1 contracts (pack, entry schema, typed refusals, `CallerIdentity` seam with tier-aware organization resolution, forged/expired split, path normalization, account-header strip) → {PR 2 data/keyring/repo/grants, PR 3 SDK `gatewayFetch`, PR 3b gateway-lite integrations proxy, PR 4 CLI} → {PR 5 OAuth/links/tokens/service/email, PR 6 proxy OAuth path/sync/counters/prune} → PR 7 admin UI; OpenSEO PR 8a from PR 3, PR 8b and PR 9 after; PR 10 two-phase org delete; PR 11 readiness at register (redesign #12). Redesign Stack 2 (#3 props pin, #4 `aud = workerName`) runs in parallel; the hosted platform tier itself (research H17a) is the prerequisite for Google in hosted, not this stack. Critical path PR 0 (1) → PR 1 (1.25) → PR 2 (2) → PR 5 (2.5) → PR 7 (1.5) ≈ 8 agent-days; ≈ 19 agent-days total; 7–8 wall-clock days with four subagents, plus Google verification lead time.

---

## 9. Open decisions for Ben

1. **Hosted shape (settled by Ben, 2026-10-16).** Two kinds of apps: first-party catalog apps as one shared Worker per app on the platform tier, third-party apps as one Worker per organization on Workers for Platforms. Matches the hosted research's D2 and H17a; nothing left to decide here except the vocabulary in §10.
2. **Caller credential.** No multi-organization gate (§6). The HMAC caller credential is recorded in TODO.md as a later hardening for self-host gateways where several people deploy for several organizations. Recommend leaving it there.
3. **Keyring secret `INTEGRATIONS_KEKS`** with cron-driven rewrap vs single `INTEGRATIONS_KEK`. Recommend keyring; a single value cannot be rotated.
4. **Shared-identity revocation rule** (skip Google revoke when another org holds the identity). Recommend yes; the alternative knocks out other tenants.
5. **Two-phase org deletion** with synchronous revoke. Recommend yes.
6. **Email on `needs_reauth`** to owners/admins. Recommend yes; otherwise background work dies silently.
7. **Manifest entry drops `as` and `background`** (redesign #2). Recommend yes; background writes get an explicit admin checkbox later.
8. **Scope short names.** Recommend yes.
9. **`request_hash` on approval.** Recommend yes.
10. **Dev story: gateway-lite proxy + team Desktop client + `everyapp dev google connect --port 8788`**, SDK fallback deleted. Recommend yes; it is the only dev story that survives OAuth.
11. **Counters first, gateway-wide pools, binding later.** Recommend counters.
12. **Who may connect: owners and admins.** Recommend yes.
13. **OpenSEO keeps `*_connections` rows and shows `accountStatus`.** Recommend yes.
14. **Keep `gsc_oauth_not_configured` as the MCP reason code.** Recommend keep.
15. **Audit retention shares `MCP_AUDIT_RETENTION_DAYS`.** Recommend share.
16. **Hosted terms disclose operator access and Time Travel retention.** Recommend yes.
17. **Google verification submitted now**, before PR 5. Recommend yes; it is the external critical path.

---

## 10. Alignment with the hosted-platform research (2026-10-16)

The research on `research/hosted-platform` (`docs/research/2026-10-hosted-platform/README.md`, PR #299, written in the "Design a Multi-Tenant Hosted App Platform" thread) and this design were produced in parallel. They agree on the shape. These are the points where one should change for the other.

**This design takes from the research.**
- The two tiers (D2, H17a): platform tier for first-party catalog apps, dispatch tier for everything else. §1, §6 and §7 are revised accordingly and the "hosted v1" framing is withdrawn.
- Organization resolution on the platform tier (H17a): identity JWT, else `x-everyapp-org` checked against the install row, `org_source` recorded. The SDK's `for: { background: true, organizationId }` is the app-side half.
- Names: the manifest key `capabilities` and the table `app_capability_grants` keyed by `app_row_id` (H14) replace this design's `integrations` and `app_integration_grants`; per-organization data keys live on `organization_data_keys` (H20), and the keyring `INTEGRATIONS_KEKS` is that table's KEK. Grants stay one row per (install, provider) with `scopes` and `account_ids` as pack dimensions.
- `aud = workerName` (H2), with the platform-tier SDK check being "the token's `org_id` has an install row for this app" rather than `org_id === EVERYAPP_ORG_ID` (redesign review #4, amended).
- Typed refusals: the research's `needs_account {connectUrl}` and `grant_pending {approveUrl}` and this design's `INTEGRATION_REFUSALS` become one vocabulary in PR 1.

**The research should take from this design.**
- Google is a gateway capability with the operator's client (`credential.kind: "oauth"`), per-organization `integration_accounts`, account selection per call (`x-everyapp-integration-account`), read-only by method plus `readPosts`, refresh under lease. H14's pack dimensions need `scopes` and `account_ids`.
- The OAuth callback is one exact URI on the control-plane host. H18's "GSC/GA callbacks relayed through `app.openseo.so` by `state` prefix" and H38's passthrough of `/api/gsc/oauth/callback` and `/api/ga4/oauth/callback` are needed only if the Every App deployment of OpenSEO keeps its own Google client, which this design replaces.
- H35's "GSC/GA grants stay in OpenSEO" becomes a phase-3 choice: re-seal OpenSEO's Google refresh tokens into the organization's `integration_accounts` at cutover (decrypt with OpenSEO's `BETTER_AUTH_SECRET`, wrap under the organization's data key), or ask admins to reconnect once. Default: reconnect; it is one click per organization and moves no secrets.
- R39: the gateway uses a Google Cloud project and OAuth client of its own rather than new redirect URIs on OpenSEO's verified client; verification is submitted now (§9 item 17).
- Platform-tier background calls are OpenSEO's normal case (crons, Workflows, SAM). H17a's "install-scoped background grants" are exactly this design's grants with the organization asserted.
- The 500-Workers ceiling appears in neither design any more: the research withdrew its "500-script count" argument in A1, and this design withdraws "about 200 organizations".

**Open between the two.** One route name (`/api/integrations/<id>/<host>/<path>` here, `/v1/<pack>/...` in H18), settled in PR 1. OpenSEO needs no tier-specific SDK code: `gatewayFetch` always forwards the identity for `for: Request` and sends `x-everyapp-org` when given, and the gateway decides by props, so the same build runs on a self-host gateway (`tier='service_binding'`, one organization) and on the hosted platform tier.

---

## Appendix A: PR stack

Base: `main` after PR 0. Estimates are agent-days for one Opus subagent including tests. ∥ = can run in parallel once its dependency has merged. Redesign Stack 2 (#3 props pin, #4 `aud = workerName`) and Stack 1 PR B (AI fold) run beside this stack and are not estimated here.

## PR 0 — Rebase phase 0 onto `main`, commit and merge · 1 d · Every App
Depends on: nothing. Rebases the uncommitted `t3/port-openseo-to-gateway` tree (`integration-proxy.ts`, `packages/sdk/src/internal/integrations.ts`, `integrationFetch.ts`, `docs/integrations.md`, CLI/perimeter/SDK edits) onto `main` after the CLI redesign (#284 to #298): the helper-Worker deploy changes move from `commands/app/deploy/deployApp.ts` to `commands/deploy/deployApp.ts`, and `policy.ts`, `resources.ts`, `manifest.ts`, `worker.ts`, `fakeCloudflare.ts` and TODO.md take manual merges (a trial `git merge-tree` on 2026-10-16 listed 11 conflicting files, two of them deleted upstream). Then commits so PR 1–4 branch from `main`. Tags `poc/github-integration` as `archive/poc-github-integration`; the branch is deleted after PR 6.

## PR 1 — Contracts, caller seam, organization resolution, fail-closed identity · 1.25 d · Every App
Depends on: PR 0. Everything else imports these types.
- `packages/sdk/src/internal/integrations.ts` (+test): `ProviderPack` union (`credential.kind: api_key | oauth`), `ApiKeyIntegrationId`/`OAuthIntegrationId`, `google` pack (hosts + scope + path prefixes, `readPosts`, scope catalog, `baseScopes`, `approval`, dev names), `requiredScopeFor`, `INTEGRATION_REFUSALS` with `kind`, `IntegrationErrorCode`, `GATEWAY_ERROR_HEADER`, `INTEGRATION_ACCOUNT_HEADER`, `INTEGRATION_ORG_HEADER` (`x-everyapp-org`, research H17a); `parseIntegrationProxyPath` checks `upstream.pathname` against prefixes and refuses dot-segment encodings.
- `packages/perimeter/src/manifest/manifest.ts` (+test): `IntegrationRequestSchema = { access default read, why ≤ 300 }`, `GoogleIntegrationRequestSchema` with `scopes`; `integrations` validated as `z.record(id, entrySchemaFor(id))`; `as`/`background` removed.
- `packages/sdk/src/server/index.ts`: re-export `GATEWAY_ERROR_HEADER`, `IntegrationErrorCode`, `readGatewayRefusal`, `OrgRole`.
- `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts` (+test): `CallerIdentity { organizationId, appId, appRowId, workerName, orgSource }` seam, resolved per tier (props; on `trust: "catalog"` props the JWT's `org_id`, else `x-everyapp-org` checked against the install row, else `400 integration_org_required`; a disagreeing header → `403 integration_org_mismatch`); forged identity → `401 integration_identity_invalid`, expired → `attribution: "expired"`; passes `env`, `ctx`.
- `apps/every-app-gateway/src/server/integrations/proxy.ts` (moved from `integration-proxy.ts`, +test): typed `refusal()`; status route behind caller/identity checks; `INTEGRATION_ACCOUNT_HEADER` and `INTEGRATION_ORG_HEADER` consumed and stripped before upstream; refusal messages carry `adminUrl`, never CLI text.
- `apps/every-app-gateway/cloudflare.config.ts`, `src/env.d.ts`, `packages/cli/src/lib/gateway/secretsFile.ts`: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` settable; `INTEGRATIONS_KEKS` optional, never settable.
- `docs/integrations.md`: split "For a self-hosting operator" / "For an organization admin"; Google section; error table.

## PR 2 ∥ — Data, keyring crypto, repository, grants · 2 d · Every App
Depends on: PR 1.
- `apps/every-app-gateway/drizzle/0033_integrations.sql` + meta, `src/db/integrations.schema.ts`, `src/db/schema.ts`, `src/db/auth.schema.ts` (`organizations.status`): `integration_org_keys`, `integration_accounts` (incl. `client_id`, `refresh_token_issued_at`, `last_refresh_attempt_at`, `revoked_at_google`, `reauth_notified_at`), `app_integration_grants` (+`request_hash`, `account_ids`, `default_account_id`), `integration_connect_links` (+`error_return_to`), `integration_events` (surrogate id, unique natural key, `(minute)` index), `integration_usage`.
- `src/server/integrations/crypto.ts` (+test): keyring parse, `v2.<kek_id>` envelope, `INSERT OR IGNORE` DEK creation, DEK cache per `(org, kek_id)`, AAD, `rewrapPending(limit)`.
- `src/server/integrations/grants.ts` (+test): `covers/effectiveGrant/statusForRequest` on scopes; `approval: "deploy"` auto-approve; `requestHash`.
- `src/server/repositories/IntegrationRepository.ts` (+sqlite test): accounts (lease claim, CAS, backoff fields, shared-identity count, 10-minute `last_used_at`), grants (`decide` WHERE `request_hash`), links (atomic consume, per-user cap), events, usage, org keys.
- `src/server/mcp-auth/maintenance.ts`: rewrap batch; bounded prunes with per-table budgets and `behind`; batched `RateLimitCounterRepository.deleteExpired`.
- `packages/cli/src/lib/gateway/{secretsFile,apply}.ts`, `packages/cli/src/commands/gateway/upgrade/*`: generate `INTEGRATIONS_KEKS` when `cf secret list` lacks it (first deploy and upgrade); no public status field.

## PR 3 ∥ — SDK `gatewayFetch`, status, connect link · 1 d · Every App
Depends on: PR 1.
- `packages/sdk/src/server/gatewayFetch.ts` (+test): `gatewayFetch({ env, provider, for, account? })`, `integrationStatus` (throws `IntegrationError`), `integrationConnectLink` (`returnTo`, `errorReturnTo`, `reauthAccountId`; `{ adminRequired, adminUrl: string | null, hint? }`), `readGatewayRefusal`; delete `integrationFetch.ts`, `createGatewayFetch` and the direct-to-provider dev fallback; background jitter helper.
- `packages/sdk/src/cloudflare/worker.ts` (+test): delete `DEV_GATEWAY_KEYS`/`devGatewayKeys`; declare `EVERYAPP_DEV_GATEWAY_URL`/`EVERYAPP_DEV_GATEWAY_TOKEN` for app and helpers.
- `packages/sdk/README.md`.

## PR 3b ∥ — Gateway-lite integrations proxy (dev) · 1.5 d · Every App
Depends on: PR 1 (shares the proxy core with PR 6; the core is extracted here and PR 6 consumes it).
- `packages/perimeter/src/integrations/*` (new, +test): stateless core (route parse, grant/method checks, header strip, `redirect: manual`, meter, status) with an injected credential source.
- `packages/perimeter/src/dev/devGateway.ts`, `packages/cli/src/commands/dev/{index,devAppGateway,devEnv}.ts`: loopback listener guarded by `EVERYAPP_DEV_GATEWAY_TOKEN`; `.dev.vars` credential source (API keys; Google refresh via the dev client, `invalid_grant` → `integration_needs_reauth` with hint).
- Smoke test: a Worker with `global_fetch_strictly_public` reaches 127.0.0.1 under `cf dev` (live check).

## PR 4 ∥ — CLI · 1.25 d · Every App
Depends on: PR 1.
- `packages/cli/src/commands/app/deploy/deployApp.ts` (+test, `src/test/fakeGateway.ts`): `INTEGRATION_NOT_APPROVED` warnings with scopes and `${gatewayUrl}/admin/integrations`; tolerate `status: "error"`.
- `packages/cli/src/commands/gateway/secret/*`: several `NAME=VALUE` per redeploy; refuse `INTEGRATIONS_KEKS`.
- `packages/cli/src/commands/gateway/integration/{setup,rewrap}.ts` (new): checklist with redirect URI; rewrap runbook (add key, redeploy, poll `integration_org_keys` via the gateway D1, drop old key, redeploy).
- `packages/cli/src/commands/dev/googleConnect.ts` (new, +test): `everyapp dev google connect --port 8788`, `upsertDevVar(appDir, key, value)` in `devEnv.ts`.

## PR 5 — Google OAuth, connect links, token broker, service, email · 2.5 d · Every App
Depends on: PR 2.
- `src/server/integrations/google/oauth.ts` (+test, fake token endpoint + JWKS): authorize URL (`prompt` rule), exchange, id_token (`sub`, `email`), omitted-scope rule, revoke, `invalid_client` mapping.
- `src/server/integrations/connectLinks.ts` (+test): create (both return URLs validated), PKCE from HMAC, atomic consume, `requireLiveOrgRole`, web-channel-only, per-(org, app, hour) limit.
- `src/server/integrations/tokens.ts` (+test): 2,000-entry cache, backoff, lease, refresh-anyway, CAS, `invalid_grant`/`client_rotated`/`invalid_client`/5xx branches, `needs_reauth` email via `sendEmail`.
- `src/server/services/IntegrationService.ts`: `overview`, `startConnect`, `completeGoogleCallback` (reauth mismatch → upsert or refuse), `disconnect` (shared-identity rule), `decide(requestHash)`, `narrowGrant`, `setDefaultAccount`, `revokeAllForOrganization` (synchronous), `listAccountsForApp`, `connectLinkForApp`.
- `src/server/organization/orgContext.ts`: `requireLiveOrgRole`; refuse `status='deleting'`.
- Routes `src/routes/api/integrations/google/callback.ts`, `src/routes/integrations/connect.$linkId.tsx`, `src/serverFunctions/integrationConnect.ts`; `src/server/errors.ts`, `src/client/errors.ts`: `INTEGRATION_LINK_INVALID`, `INTEGRATION_WRONG_ACCOUNT`, `INTEGRATION_REQUEST_CHANGED`.

## PR 6 ∥ — Proxy OAuth path, grants sync, binding routes, counters · 2 d · Every App
Depends on: PR 2 and PR 3b (service types from PR 5 agreed up front).
- `src/server/integrations/proxy.ts` (+test): `kind: "oauth"` branch in the full §3.4 order on the perimeter core; account resolution; scope-per-host; read-only = GET/HEAD + `readPosts` (test: `chan: mcp` without `mcp:write` can POST `searchAnalytics/query`, cannot POST a non-`readPosts` path); traversal test per host; ≤1 MiB buffered 401 retry; events/usage/`last_used_at` in `waitUntil`; counters per `(org, provider, minute)`, `(account, minute|day)` for inspections, gateway-wide `google:<host>:<minute>` with fair share; status with accounts gated on approval and `accounts_listed` event.
- `src/server/app-gateway-entrypoint.ts`: `GET /api/integrations/<id>`, `POST /api/integrations/<id>/connect-links`.
- `src/server/services/AppRegistrationService.ts`: `markDeployed` → `syncAppRequests` in try/catch; `src/server/repositories/AppRepository.ts`: `tombstone` deletes grants.

## PR 7 — Admin UI · 1.5 d · Every App
Depends on: PR 5 (PR 6 for activity/usage).
- `src/routes/admin.tsx` tab; `src/routes/admin/integrations.tsx`: Google card branching on `deploymentMode` (checklist with copy buttons vs "not enabled yet"), accounts (email, scopes, status, connected-by, `revoked_at_google` note, Reconnect, Add scope, Remove with shared-identity copy), requests table with `requestHash`-bound Approve/Deny/Revoke, narrowing, default account, activity table, usage per app, `needs_reauth` banner on gateway home.
- `src/serverFunctions/integrations.ts`, `routeTree.gen.ts`.

## PR 8a ∥ — OpenSEO: SDK bump, seam, token-free clients · 1.5 d · OpenSEO (`t3/every-app-mode`)
Depends on: PR 3 linked; PR 6 to run end to end.
- `src/server/lib/provider-access.ts` (`Record<ApiKeyIntegrationId, string>`, catch `IntegrationError`), `src/server/lib/openrouter.ts` (`gatewayFetch` + `for`).
- `src/server/features/google/googleAccess.ts` (+test): `ownClientGoogleAccess` (memoized token per fetch, TokenError wrap, parity test), `gatewayGoogleAccess`, full error table incl. `GoogleAccessError`.
- `src/server/lib/gscClient.ts`, `ga4Client.ts` (+tests rewritten for fetch injection: `gscClient.test.ts`, `ga4Client.test.ts`, `googleAccessToken.test.ts`): injected `fetch`; GA4 catch blocks rethrow `Ga4TokenError`/`GoogleAccessError`/`AppError`; one 428-refusal test per client.
- `src/server/request-context.ts` (new), `src/server.ts`, `src/server/everyapp/tools.ts`: `AsyncLocalStorage` request scope seeded from the SDK's verified user.

## PR 8b — OpenSEO: services on the seam · 1 d · OpenSEO
Depends on: PR 8a.
- `GscService.ts`, `Ga4Service.ts`, `Ga4ReportingService.ts`, `Ga4OrganicOverviewService.ts`, `Ga4MeasurementHealthService.ts`, `SearchOpportunityService.ts`, `DashboardSiteService.ts` (cache params gain account `updatedAt`; `GoogleAccessError` treated as expected); `isExpectedGrantFailure`/`requiresReconnect`/`mapGa4ReportError` extended; tests for `not_approved` in `DashboardSiteService` and `GscService`.
- `src/db/{gsc,ga4}.schema.ts` (+pg twins): `gsc_account_id` NOT NULL, `connected_by_user_id` nullable.

## PR 9 — OpenSEO: server functions, UI, mode plumbing · 2 d · OpenSEO
Depends on: PR 8b.
- `src/serverFunctions/gsc.ts`, `ga4.ts`, `googleAccounts.ts`: one `integrationStatus` call; `hasAccount`, `canConnect`, `accountsManagedAt`, `accountStatus`, `gateway` block; `startLinkSchema.reauthAccountId`; callbacks 404 in everyapp mode.
- Client: `GoogleOAuthSetupWarning.tsx` (two copies keyed on `deploymentMode`, hint when `adminUrl` null), `GoogleConnectionCard.tsx`, `GoogleProjectEmptyState.tsx`, `GoogleConnectedState.tsx` (status banners), `GooglePropertyPicker.tsx` (`canManageAccounts`, `manageAccountsUrl`, `onReconnect(accountId?)`), `useGooglePickerResume.ts`, `startGoogleLink.ts` (`adminRequired` branch, `errorReturnTo`), `googleAuthErrorCopy.ts` (+4 codes), `SearchConsoleOnboardingStep.tsx`; `googleSetupState.test.ts` member + hasAccount cases; a picker gating test.
- `everyapp.config.ts` `google` entry (no `as`/`background`); `selfhost-preflight.ts`, `setup-status.ts`, `gscErrors.ts` mode branch, `search-console-tools.ts`, `google-analytics-tools.ts`; `docs/maintainers/every-app.md` (migration from own client, dev client), `.env.example`.

## PR 10 — Two-phase org delete · 0.75 d · Every App
Depends on: PR 6, PR 7.
- The HMAC caller credential from the first draft is out of the stack (§6); TODO.md keeps it as a later hardening for self-host gateways with several deployers and several organizations.
- `OrganizationService.delete`: `status='deleting'`, synchronous revoke with shared-identity rule, then cascade.
- AI proxy adopts the same forged/expired identity rule.

## PR 11 ∥ — Readiness at register, `everyapp app status` (redesign #12) · 1 d · Every App
Depends on: PR 6. `RegisterAppResponse.readiness`, additive grant upsert at register, `INTEGRATION_NOT_READY` printed before build, `--require-integrations`, new `app status` command.

## Order and parallelism
PR 0 → PR 1 → {PR 2, PR 3, PR 3b, PR 4} → {PR 5, PR 6} → PR 7 → PR 10; PR 8a after PR 3, PR 8b, PR 9 in sequence; PR 11 after PR 6. Critical path PR 0 (1) → PR 1 (1.25) → PR 2 (2) → PR 5 (2.5) → PR 7 (1.5) ≈ 8 agent-days; ≈ 19 agent-days total; 7–8 wall-clock days with four subagents. External critical path: Google OAuth verification submitted before PR 5. Merge hotspots: `app-gateway-entrypoint.ts` and `integrations/proxy.ts` (PR 1, PR 6): land PR 1 before PR 6 starts.

## Later (TODO.md)
- Per-org API keys as `integration_accounts` rows with `kind: "api_key"`, spend caps over `integration_usage` (redesign #13/#14).
- GitHub as a `github_app` pack; decide its client's home then.
- Hosted wiring from the research: platform-tier install rows and `x-everyapp-org` (H17a), the deploy service writing dispatch bindings (H10), data keys on `organization_data_keys` (H20); the HMAC caller credential for self-host gateways with several deployers.
- AI fold into the same registry and route (redesign #1 PR B).

---

## Appendix B: decisions with recommendations

- Hosted shape. Settled by Ben on 2026-10-16 and matching the hosted research's D2: first-party catalog apps are one shared Worker per app (platform tier); third-party apps are one Worker per organization on Workers for Platforms (dispatch tier). The first draft's option (a), a `self_hosted` gateway with the operator deploying per organization under a 500-Workers ceiling, is withdrawn.

- Caller identity trust. Every uploader we ship is trusted (the operator's CLI on self-host, the deploy service on the dispatch tier, our own code on the platform tier), so there is no multi-organization gate. Options for the rest: (a) tier-aware organization resolution in PR 1 and nothing else; (b) also an HMAC caller credential for self-host gateways where several people deploy for several organizations. Recommendation: (a) now, (b) in TODO.md.

- Key encryption secret shape. Options: (a) a keyring INTEGRATIONS_KEKS = {active, keys} with cron-driven rewrap and a CLI runbook; (b) a single INTEGRATIONS_KEK. Recommendation: (a). A single Worker secret is replaced wholesale on deploy, so (b) can never be rotated without every org reconnecting Google; the keyring costs one JSON parse and a kek_id column.

- Google revocation with a shared client. Google revokes per (user, project), so Remove in one org would cut the same identity in every other org. Options: (a) revoke at Google only when this org held the identity's last active row, otherwise null the tokens and tell the admin; (b) always revoke. Recommendation: (a), with revoked_at_google recorded and the residual stated in the hosted terms.

- Organization deletion. Options: (a) two-phase: mark deleting, synchronously revoke every account before the FK cascade; (b) best-effort revoke in waitUntil after the delete. Recommendation: (a). After the cascade the DEK is gone and nothing can revoke; D1 Time Travel also keeps deleted ciphertext for 30 days, so revocation is the only real erasure.

- Propagating needs_reauth. Options: (a) email owners/admins on the active to needs_reauth transition (gateway EMAIL binding exists) plus a gateway-home banner; (b) pull-only via 428 and the OpenSEO card. Recommendation: (a). SAM and crons run with nobody signed in; a client rotation or Testing-mode expiry would otherwise silently stop every org's background Google work.

- Manifest entry shape. Options: (a) drop as and background per the redesign review: an approval is of the app, attribution comes from the identity header, org connections always permit background; (b) keep both fields. Recommendation: (a), with a later admin checkbox for background writes on write-capable packs so the agent read-only rule stays meaningful.

- Approval race. Options: (a) decideIntegrationRequest carries the request hash the admin saw and the UPDATE is conditional on it; (b) the PoC's re-read-and-approve. Recommendation: (a); a deploy landing during review otherwise widens what the admin approved.

- Dev story. Options: (a) delete the SDK's direct-to-provider fallback; the dev gateway-lite proxies /api/integrations from .dev.vars; one team Desktop-type Google client with a published consent screen and a fixed loopback port 8788; everyapp dev google connect writes the refresh token; (b) keep a per-developer fallback in the SDK with each developer's own Web client. Recommendation: (a). Web clients need the exact redirect URI registered and Testing-mode tokens expire weekly; (b) does not survive a team.

- Rate limiting. Options: (a) rate_limit_counters per (org, provider, minute), per (account, minute|day) for URL inspection, and gateway-wide per-host pools with fair share above 80 percent; (b) a Cloudflare Rate Limiting binding. Recommendation: (a) first; the per-project Search Console pools are shared by every org on the one client and need a gateway-wide counter, which a binding cannot key per org and host at once.

- Scope names in the manifest: Google short names (webmasters.readonly, analytics.readonly) vs product names. Recommendation: short names; one vocabulary mapping 1:1 to Google's scope URLs.

- Who may connect Google: owners and admins only (members get ask-an-admin with adminUrl) vs any member. Recommendation: owners and admins; agents are refused connect-link creation outright since they cannot complete OAuth.

- OpenSEO behaviour when the gateway reports an account revoked, narrowed or needing re-auth. Options: (a) keep the project's *_connections row and surface accountStatus active | needs_reauth | unavailable with Reconnect or choose-another; (b) delete the row. Recommendation: (a); deletes lose which property the project used and the account id is stable across re-auth.

- MCP reason code for a missing Google client. Options: keep gsc_oauth_not_configured (contract MCP clients and skills already read) vs rename to google_not_configured. Recommendation: keep, adding google_not_connected for the not-connected case.

- Audit retention and metering: per-minute integration_events sharing MCP_AUDIT_RETENTION_DAYS plus a daily integration_usage row, both with bounded batched prunes, vs log lines only. Recommendation: both tables; events answer who, usage answers how much and is what spend caps read.

- Hosted terms and verification. Recommendation: submit Google OAuth verification for the one External client now (it gates connecting more than 100 admins), publish to production before the first org connects, and have the hosted terms disclose that the operator can decrypt tokens and mint identities and that deleted-org ciphertext is restorable from D1 Time Travel for 30 days.
