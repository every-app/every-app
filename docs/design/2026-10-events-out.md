# Events out: the gateway's event bus and signed outbound webhooks

Written 2026-10-25 for the launch on Monday 2026-10-27. Ben's mandate for the batch: "assume we want all of this and build the best, most robust thing we're going to want long term, so that when we launch on Monday people can just run with it and they're not waiting on us for PRs." This document is the contract the build lanes read: the catalogue, the envelope, the tables, delivery and signing, the CLI, the admin MCP tools, the UI, the SDK, and where each event is emitted. What it decides without Ben is listed under "Defaults for Ben" at the end and in TODO.md.

## 0. Summary

Everything the gateway already knows about (a member joins, an app is installed, a cap is hit, an agent's tool call is blocked, a token is revoked) becomes one typed event on an **event bus inside the gateway**. An owner or admin **subscribes** a URL (Slack's incoming webhook, Zapier, n8n, Linear's webhook catcher, their own agent) or the organization's **owners and admins by email** to a list of event types. The gateway **delivers** each event as a signed JSON POST (HMAC-SHA256 over a timestamp and the body, Stripe-style), retries with backoff for about 35 hours, keeps a 30-day delivery log with a visible dead-letter state, and lets an admin redeliver. Apps emit their own events through the SDK (`app.<id>.<name>`), attributed like every other gateway call. Nothing in an event is ever a secret, a tool argument or a tool result: the Activity rule holds on the bus.

The bus needs no new Cloudflare resource: events, subscriptions and deliveries are D1 rows; the first attempt runs right after the event under `waitUntil`; retries run from a per-minute cron trigger on the gateway Worker. Section 4 says why not a Durable Object or a Queue.

## 1. The catalogue

Every event has a stable `type`, a `version` (an integer per type; a breaking change to a type's `data` bumps it and the old version keeps being documented), a one-line human summary (used by the email sink and the UI), and a `data` shape. The list is a TypeScript module the gateway, the docs drift test and the UI read from one place: `apps/every-app-gateway/src/server/events/catalogue.ts` (exported for the docs test through `@every-app/sdk/internal` as `EVENT_TYPES`, see section 9).

Common objects, used by several types:

- `user`: `{ id, email, name }` of the member the event is about (`name` and `email` may be null for a person who has since left; never a password hash, token or session).
- `actor`: who caused it: `{ kind: "user" | "agent" | "app" | "operator" | "gateway", id?: string, email?: string, name?: string }`. `operator` is the Cloudflare login that ran the CLI (`deployed_by_actor` style: the email, or `api-token:<account id>`); `agent` is an MCP caller (its connection's client name as `name`); `gateway` is a cron or an internal rule.
- `app`: `{ id, rowId, name }` (the manifest id, the registry row id, the display name).

| Type | v | Summary | `data` |
|---|---|---|---|
| `member.invited` | 1 | "Ada invited jo@acme.com as member" | `{ invitation: { id, email, role, expiresAt }, emailSent: boolean }` (never the link) |
| `member.joined` | 1 | "jo@acme.com joined as member" | `{ user, role, via: "invitation" \| "access" \| "setup" \| "member_add" }` |
| `member.role_changed` | 1 | "jo@acme.com is now admin" | `{ user, role, previousRole }` |
| `member.deactivated` | 1 | "jo@acme.com was deactivated" | `{ user, reason?: string }` |
| `member.reactivated` | 1 | "jo@acme.com was reactivated" | `{ user }` |
| `member.removed` | 1 | "jo@acme.com was removed" | `{ user, accountDeleted: boolean }` |
| `member.password_reset` | 1 | "jo@acme.com reset their password" | `{ user, by: "self" \| "admin_link" \| "admin_email" }` (emitted when the reset completes; if Better Auth 1.7.7 offers no completion hook, emit `member.reset_link_created` `{ user }` from `MembershipService.createPasswordResetLink` instead and document that) |
| `app.installed` | 1 | "crm was installed" | `{ app, version?: string, hostname?: string, scope: "org" \| "shared", source: "cli" \| "browser" \| "release" }` |
| `app.updated` | 1 | "crm was redeployed (version …)" | `{ app, version?: string, previousVersion?: string }` |
| `app.removed` | 1 | "crm was removed" | `{ app, purged: boolean }` |
| `app.needs_setup` | 1 | "crm needs setup: OPENROUTER_API_KEY" | `{ app, unmet: string[] }` (setting names only, never values) |
| `app.ready` | 1 | "crm is ready" | `{ app }` |
| `app.paused_cap` | 1 | "crm is paused: monthly cap of 1,000 reached" | `{ app, cap, calls, month, source: "app" \| "default" }` |
| `app.tools_changed` | 1 | "crm's tools changed: 12 tools (was 11)" | `{ app, kind: "app" \| "builtin" \| "remote", toolCount, previousToolCount, added: string[], removed: string[] }` (names only, capped at 50 each; MCP apps of both kinds go through the same catalog sync, so this is their event too) |
| `cap.warning` | 1 | "crm is at 80% of its monthly cap (800 of 1,000)" | `{ app, cap, calls, month, threshold: 80, source }` |
| `cap.reached` | 1 | "crm reached its monthly cap (1,000)" | `{ app, cap, calls, month, source }` |
| `cap.raised` | 1 | "crm's cap raised from 1,000 to 5,000" | `{ app, cap: number \| null, previousCap: number \| null, source }` (`cap: null` = no cap now) |
| `tool.blocked` | 1 | "Claude's call to crm_delete_contact was blocked: destructive" | `{ tool, app?, user, client?: { kind, name?, id }, risk?, reason, callId }` |
| `tool.error` | 1 | "crm_list_contacts failed for Claude: app_error" | `{ tool, app?, user, client?, risk?, outcome, callId, durationMs }` |
| `connection.created` | 1 | "Ada connected Claude (read & write, all apps)" | `{ connection: { id, clientName, clientDomain?, access, appScope }, user }` |
| `connection.revoked` | 1 | "Ada's Claude connection was revoked (user)" | `{ connection: { id, clientName }, user, reason }` |
| `token.created` | 1 | "Ada created the token ci-deploy" | `{ id, name, scopes, appId?, expiresAt?, user }` (the token's row id and name, flat: a key named `token` is one section 7's credential rule refuses, and the gateway's own events keep that rule; never the value or its hash) |
| `token.revoked` | 1 | "Ada revoked the token ci-deploy" | `{ id, name, user }` (flat, as above) |
| `access.changed` | 1 | "Cloudflare Access was turned on" | `{ access: "on" \| "off", teamDomain?: string, emailDomains?: string[] }` |
| `mcp_app.added` | 1 | "DataForSEO was added as an MCP app" | `{ app, kind: "builtin" \| "remote" }` (`everyapp mcp add <url>`, or a built-in's first `mcp on`) |
| `mcp_app.removed` | 1 | "DataForSEO was removed" | `{ app, kind }` (`everyapp mcp remove`, the tombstone) |
| `mcp_app.enabled` | 1 | "DataForSEO is being served again" | `{ app, kind }` (`everyapp mcp on` on an existing row: status disabled → active) |
| `mcp_app.disabled` | 1 | "DataForSEO stopped being served" | `{ app, kind }` (`everyapp mcp off`: status active → disabled, access kept; the MCP-by-URL thread's semantics) |
| `provider.added` | 1 | reserved: the Provider registry thread | `{ provider: { id, name } }` |
| `provider.removed` | 1 | reserved: the Provider registry thread | `{ provider: { id, name } }` |
| `ping` | 1 | "Test event from Every App" | `{ subscription: { id, name }, message }` (delivered only to the subscription under test) |
| `app.<id>.<name>` | app's | "crm: invoice.paid" | whatever the app sent (section 7); the catalogue records the pattern, not each name |

Not in the catalogue, on purpose: anything that would carry a secret (the invitation link, a reset link, a token value, an OAuth code), a tool's arguments or result (the audit table holds neither; the bus holds neither), an email body, a provider's response. The catalogue module has a unit test that every documented type's `data` builder refuses keys named like credentials (section 7's rule applies to the gateway's own events too).

Subscriptions match types by exact name or by prefix pattern: `member.*`, `cap.*`, `app.*` (which also matches `app.crm.invoice.paid`), `app.crm.*`, or `*`. A subscription with no list gets everything but `ping` (a ping goes only to the subscription under test).

## 2. The envelope

Every delivery body is one JSON object:

```json
{
  "id": "evt_01M5S4KHM0WG4B9YKWMCYDPHVZ",
  "type": "member.joined",
  "version": 1,
  "summary": "jo@acme.com joined as member",
  "time": "2026-10-25T09:15:03.412Z",
  "gateway": "https://apps.acme.com",
  "organization": { "id": "org_…", "slug": "acme", "name": "Acme" },
  "actor": { "kind": "user", "id": "usr_…", "email": "ada@acme.com", "name": "Ada" },
  "data": { … }
}
```

`summary` is the catalogue's one line for the event, so a receiver that can only read top-level string keys (Slack's Workflow Builder webhook trigger, a Zapier "Catch Hook" step, Make) can post something a person understands without parsing `data`; `type`, `gateway` and `summary` are the three to map. `id` is `evt_` + 26 characters that sort by time (the gateway's own ULID: 10 characters of uppercase Crockford base32 time, 16 of randomness; the CLI writes the same shape). At-least-once delivery means a receiver may see the same `id` twice; it deduplicates on `id`. No ordering is promised between events; `time` and `id` order them.

Headers on every delivery:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `every-app-gateway/<release version>` |
| `X-EveryApp-Event` | the type |
| `X-EveryApp-Event-Id` | the event id |
| `X-EveryApp-Delivery` | the delivery id (`dlv_…`), new per subscription and stable across retries |
| `X-EveryApp-Attempt` | 1, 2, … |
| `X-EveryApp-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |

The signature is HMAC-SHA256 with the subscription's secret over the UTF-8 bytes of `<t>.<body>` where `<t>` is the timestamp in the header and `<body>` is the exact request body. Receivers recompute it, compare in constant time, and refuse a `t` more than five minutes from their clock. The docs carry the verification in Node.js, Python and Go (section 9). No signature means no delivery: every webhook subscription has a secret (generated when none is given).

## 3. Tables

Migration `0009_events.sql` (expand only; the `release-migrations` test holds). Three tables, all keyed by organization; no foreign keys from the log tables to apps or users, so the trail outlives both (as `mcp_tool_calls` does); subscriptions cascade with their organization.

**`event_subscriptions`** (`apps/every-app-gateway/src/db/events.schema.ts`)

| Column | Type | Meaning |
|---|---|---|
| `id` | text PK | `sub_` + 24 hex |
| `organization_id` | text, FK organizations cascade | whose |
| `name` | text | what a person calls it ("Slack #ops"); defaults to the URL's host or "Email owners and admins" |
| `sink` | text | `webhook` \| `email` |
| `url` | text, nullable | the webhook URL (null for `email`) |
| `secret` | text, nullable | the signing secret as written (null for `email`); see "Defaults for Ben" on storage |
| `recipients` | text, nullable | `owners` \| `admins` for `email` (admins = owners and admins) |
| `events` | text | JSON string[] of types or patterns; `["*"]` for everything |
| `enabled` | integer, default 1 | 0 = paused: events are not queued for it |
| `builtin` | text, nullable | `cap_alerts` for the one the gateway creates (section 6); null for a person's |
| `description` | text, nullable | free text |
| `created_at`, `updated_at` | integer ms | |
| `created_by` | text, nullable | user id, or `operator:<actor>` for the CLI, or `agent:<connection id>` |
| `last_delivery_at` | integer ms, nullable | the last attempt on any delivery of this subscription |
| `last_delivery_status` | text, nullable | `delivered` \| `failed` \| `dead` |
| `consecutive_failures` | integer, default 0 | reset on a delivered attempt; the UI shows it |

Index: `(organization_id)`.

**`events`**

| Column | Type | Meaning |
|---|---|---|
| `id` | text PK | `evt_…` |
| `organization_id` | text | |
| `type` | text | |
| `version` | integer | |
| `time` | integer ms | when it happened |
| `actor` | text | JSON |
| `data` | text | JSON, at most 16 KiB (8 KiB for an app's own event) |
| `app_row_id` | text, nullable | for filters |
| `dedupe_key` | text, nullable, UNIQUE | `cap.warning:<org>:<app row>:<month>:<cap>` and the like; an insert that collides is dropped and nothing is delivered |
| `created_at` | integer ms | |

Indexes: `(organization_id, time)`, `(time)` for pruning.

**`event_deliveries`**

| Column | Type | Meaning |
|---|---|---|
| `id` | text PK | `dlv_` + 24 hex |
| `event_id` | text | |
| `subscription_id` | text | |
| `organization_id` | text | |
| `status` | text | `pending` \| `delivered` \| `dead` |
| `attempts` | integer, default 0 | attempts made |
| `next_attempt_at` | integer ms, nullable | when `pending`; null once delivered or dead |
| `claimed_until` | integer ms, nullable | a worker holds the row until then |
| `last_attempt_at` | integer ms, nullable | |
| `last_status_code` | integer, nullable | the HTTP status; for `email`, the number of recipients mailed |
| `last_error` | text, nullable | a code (`timeout`, `connection`, `redirect`, `status_500`, `target_refused`, `email_not_configured`, `email_budget_exhausted`) and up to 200 characters of what the receiver answered, never the request body |
| `delivered_at` | integer ms, nullable | |
| `redelivered_at` | integer ms, nullable | the last manual redeliver |
| `created_at` | integer ms | |

Indexes: `(status, next_attempt_at)` for the sweep, `(subscription_id, created_at)` for the UI, `(organization_id, created_at)`, `(event_id)`.

Retention: the hourly maintenance (`mcp-auth/maintenance.ts`) deletes `events` and `event_deliveries` rows older than 30 days (`EVENTS_RETENTION_DAYS` is a constant, not a setting, this week), 10,000 rows a run.

## 4. Delivery

**Why D1 and a cron, not a Durable Object or a Queue.** The gateway Worker has neither today: its bindings are D1, KV, the email binding, rate limiters and one hourly cron (`apps/every-app-gateway/cloudflare.config.ts`). A Queue needs a queue created per install and the Workers Paid plan's Queues product; a Durable Object needs a class migration in the release's Build Output that `everyapp setup`'s patcher and the `cf deploy --dry-run` check have never carried, and a test harness the gateway suite (Node, no workerd) doesn't have; either is new surface two days before launch for every self-hosted install. The delivery log has to be in D1 anyway (the UI reads it, the CLI reads it under the Cloudflare login, ADR-0003). So: the row is the queue. The first attempt runs at once under `waitUntil`; a per-minute cron (`* * * * *`, free, next to the hourly `17 * * * *`) sweeps `pending` rows whose `next_attempt_at` has come. Retry resolution is one minute, which the schedule below is coarser than. A Durable Object (per subscription, with alarms, strict ordering) is the upgrade path once there is a reason; it changes nothing in the tables or the contract.

**Queueing.** `emit(event)` in the gateway (section 5) does, in one D1 batch: insert the `events` row (with `dedupe_key` when the type has one; a conflict means "already emitted", nothing more happens), read the organization's enabled subscriptions whose `events` match (patterns are matched in code after reading the organization's rows: an organization has a handful), insert one `event_deliveries` row per match with `status = pending`, `next_attempt_at = now`. Then, under `waitUntil`, attempt those deliveries at once. An emit from the CLI (section 8, written straight into D1) has no `waitUntil`; the cron picks it up within a minute, which the CLI says.

**Attempting.** `deliverOnce(delivery)`:

1. Claim: `UPDATE event_deliveries SET claimed_until = now + 60s, attempts = attempts + 1, last_attempt_at = now WHERE id = ? AND status = 'pending' AND (claimed_until IS NULL OR claimed_until < now) RETURNING id`. No row: someone else has it.
2. Load the event and the subscription. A subscription gone, or disabled for anything but a `ping`: the delivery becomes `dead` with `last_error = subscription_gone`. A URL the target rules now refuse (a setting changed) is a retried failure `target_refused: <reason>`, not dead, since the setting may come back.
3. Webhook: build the body (section 2), sign, `fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10_000) })`. Success is a 2xx. A 3xx is a failure (`redirect`): the gateway never follows a redirect, so a target can't send it anywhere else with the body. The response body is read up to 1 KiB and the first 200 characters kept in `last_error` on failure. Email: section 6.
4. On success: `status = delivered`, `delivered_at`, `claimed_until = null`, `last_status_code`, and on the subscription `last_delivery_at/status = delivered`, `consecutive_failures = 0`.
5. On failure: `attempts < 7` → `status = pending`, `next_attempt_at = now + backoff(attempts)`, `claimed_until = null`; else `status = dead`, `next_attempt_at = null`. Subscription: `last_delivery_status = failed | dead`, `consecutive_failures + 1`.

Backoff after attempt n (the first attempt is immediate): 1 min, 5 min, 30 min, 2 h, 8 h, 24 h; the seventh failure is dead (about 35 hours in all). Targets answering 410 Gone are dead at once.

**The sweep** (`server/events/deliver.ts`, called from the `scheduled` handler when `controller.cron === "* * * * *"`): select up to 50 `pending` rows with `next_attempt_at <= now` and no live claim, ordered by `next_attempt_at`, attempt them six at a time, stop after 25 seconds of wall clock and leave the rest for the next minute. The hourly cron runs the sweep too before its maintenance, so a gateway whose per-minute trigger was never published (an install that predates it and hasn't run `everyapp update`) still delivers hourly.

**Targets** (`server/events/target.ts`, checked at `add` and again before every attempt, since a setting may have changed): `https:` only; a hostname, not an IP literal; not `localhost`, `*.localhost`, `*.local`, `*.localdomain`, `*.internal`, `*.intranet`, `*.lan`, `*.corp`, `*.private`, `*.home.arpa`, `*.onion`, nor a hostname without a dot; not the gateway's own host, an app host under `APP_BASE_DOMAIN`, or a third-party host (`gatewayHosts` in `server/outbound.ts` is the list to reuse); no userinfo, no fragment, at most 2,048 characters. The Gateway setting `EVENTS_ALLOW_PRIVATE_TARGETS=true` (an optional secret in `cloudflare.config.ts`, documented as self-host only) lets `http:`, IP literals and the private host classes through for an operator wiring an internal n8n; note that an RFC 1918 or loopback address is not routable from Cloudflare's edge in any case, so the flag buys an operator `http:` and internal hostnames that resolve publicly, nothing more. The gateway's own hosts are refused even with the flag (no loops).

**Bounds.** A subscription's URL is pinned at `add`: a delivery goes to the stored URL as stored (no per-event override, no redirect). Request bodies are at most 64 KiB. One organization may have at most 25 subscriptions. Deliveries are counted in the usage tables? No: not provider calls, not counted, not capped.

## 5. The bus inside the gateway

`apps/every-app-gateway/src/server/events/`:

- `catalogue.ts`: the types, versions, summaries, `data` builders and dedupe keys; `matches(pattern, type)`.
- `bus.ts`: `emit(input: EmitInput): Promise<void>`: resolves the organization's name and slug and the subject's `user`/`app` names (one D1 read each, cached per isolate for 30 s), builds the envelope, writes the rows, schedules the first attempts under `waitUntil` (`cloudflare:workers`). Never throws to the caller: an emit that fails is logged (`events.emit_failed`) and swallowed, because a webhook must never break the action that caused it. Tests call `emitForTests` to await the queued deliveries.
- `deliver.ts`: `deliverOnce`, `sweep`, `backoff`, the signing (`sign(secret, t, body)` and `verify` for tests), the email rendering call.
- `target.ts`: URL rules.
- `ids.ts`: ULIDs and prefixed ids.
- `subscriptions.ts` (repository + service): list, add (validates the URL, generates a secret when none, refuses the 26th), update (enable/disable, events, name), remove, `test` (emits a `ping` scoped to one subscription; a ping reaches a paused subscription too, so a paused hook can be tested, while other events skip disabled rows), `deliveries` (page, dead filter), `redeliver` (resets one pending or dead delivery to `pending` with `attempts = 0`, `next_attempt_at = now`, `redelivered_at`, then attempts it under `waitUntil`; a delivered row is left alone).

Server functions (`src/serverFunctions/events.ts`, admin middleware; the `methods.test.ts` READS list gets the GETs): `listEventSubscriptions` (GET), `createEventSubscription` (POST; returns the secret once when it generated one), `updateEventSubscription` (POST), `deleteEventSubscription` (POST), `testEventSubscription` (POST), `listEventDeliveries` (GET; `{ subscriptionId?, status?: "dead", before?, limit }`), `redeliverEvent` (POST), `listEventTypes` (GET; the catalogue for the Add dialog).

**Emit points** (each is one call; the service keeps doing what it does):

| Event | Where |
|---|---|
| `member.invited` | `InvitationService.invite` (and `inviteWithoutSession` once #614 lands) |
| `member.joined` | `auth/config.ts` organization hooks `afterAcceptInvitation` (via `invitation`) and `afterAddMember` (via `member_add`), and the Access auto-join inserts in `auth/cloudflare-access/membership.ts` (via `access`); the setup claim's owner (via `setup`) from `SetupService` |
| `member.role_changed` | `MembershipService.changeRole` |
| `member.deactivated` / `reactivated` | `MembershipService.deactivate` / `reactivate`; `AdminService.deleteUser`'s deactivate branch (reason `deleted_with_access_auto_join`) |
| `member.removed` | `AdminService.deleteUser`'s remove branch |
| `member.password_reset` | Better Auth's password reset completion hook if the version has one, else `member.reset_link_created` from `createPasswordResetLink` and `sendPasswordResetEmail` |
| `app.installed` / `app.updated` | the CLI's `markDeployed` in `packages/cli/src/lib/gateway/registry.ts`: the first recorded upload of a pending row is `installed` (a registration whose first deploy fails announces nothing), a later upload with a new version is `updated` (`version` and `previousVersion` are Worker version ids, the only version the registry holds); an outbox insert in the same D1 batch (section 8); `everyapp install` is `source: "release"`; the gateway's own deploy pipeline (`server/deploy/run.ts`) emits at the same moments from its upload record, for the hosted Deploy API (a deploy key's deploy, `everyapp deploy --gateway` and CI: source `cli`) and the browser install (source `browser`) |
| `app.removed` | the CLI's `deleteApp`; `AppService.delete` |
| `app.needs_setup` / `app.ready` | `apps.setup_state` (new column in the same migration: `ready` \| `needs_setup` \| null = never evaluated). The gateway writes it wherever it evaluates readiness (`listedAppSetup`, `refuseUnreadyApp`, activation) and emits on a transition (`needs_setup` carries the unmet names from the report); the CLI writes it after `configure`, `secret set|unset` and `deploy` compute `setup` (`appSetupFrom`), with the outbox row on a transition. A first evaluation (null → anything) emits only `needs_setup`, never `ready`. |
| `app.paused_cap` + `cap.reached` | `enforceCap` in `app-gateway-entrypoint.ts` when `exceeded`, and the provider-app call path (`provider-apps/call.ts`) which enforces the same cap; dedupe key per type: `<type>:<org>:<app row>:<month>:<cap>` |
| `cap.warning` | the same `enforceCap`, when `calls >= 0.8 * cap` and not exceeded (`checkMonthlyCap` is extended to return `cap`, `calls`, `month`, `source` whenever a cap is set, not only when exceeded); dedupe key as above with the threshold |
| `cap.raised` | `AppCapService.setMonthlyCap` when the new cap is higher or null (removed); the CLI's cap verbs (#617) once they land |
| `app.tools_changed` | `toolbus/catalog-sync.ts` when a sync stores a catalog whose tool names differ from the previous snapshot |
| `tool.blocked` / `tool.error` | `auditToolCall` in `toolbus/runtime.ts`: `decision === "blocked"` → blocked; `decision === "allowed" && outcome !== "ok"` → error. The same `waitUntil` the audit row rides. |
| `connection.created` / `revoked` | `McpConnectionRepository.create` (from `mcp-auth/authorize.ts`) / `McpConnectionService.markRevoked` (every reason) |
| `token.created` / `revoked` | `UserPatService.create` / `revoke` |
| `access.changed` | the CLI's `access on` / `access off`, outbox insert after the Gateway settings are written |
| `mcp_app.added` / `removed` / `enabled` / `disabled` | the CLI's `mcp on` (a new row → added with kind `builtin`; an existing disabled row → enabled), `mcp off` (disabled), `mcp remove` (removed) in `lib/gateway/providerApps.ts` and the MCP-by-URL thread's `remoteMcpApps.ts` (kind `remote`), outbox; `AppService.delete` of a `provider` row; the MCP-by-URL thread leaves `// events: mcp_app.…` comments at its write sites and the events thread wires them |
| `ping` | `subscriptions.test` |

The Caps thread's branch (`t3/caps-core`, unmerged on 2026-10-25, in `/tmp/ea-caps/core`) sends cap mails from `usage-cap-notices.ts` with a `usage_cap_notices` table. That path is replaced by this: `cap.warning` and `cap.reached` on the bus, delivered by the built-in email subscription of section 6. When that branch is rebased, its `noticeCapUsage`, `UsageCapNoticeRepository`, `capNoticeEmail` and the `usage_cap_notices` table go; its default cap, `unlimited` and Paused UI stay and emit `cap.raised` through the service.

## 6. Built-in sinks: email

A subscription with `sink = "email"` delivers each event as one mail per recipient to the organization's live owners (`recipients = "owners"`) or owners and admins (`"admins"`), through the gateway's own sender (`server/email/sendEmail.ts`, `kind: "notice"`, a new `MailKind` with daily budgets: self-hosted 50 per address and 2,000 per gateway, hosted 20 and 2,000). Recipients are always members: the sink never takes an address, so the gateway never mails outside the organization. The mail is rendered from the catalogue's summary and `data` (`server/email/templates.ts` `eventEmail`): subject `[<organization>] <summary>`, a short text and HTML body listing the data fields a person reads (the app, the cap, the member, the tool; never ids alone when a name exists), and one link to the right admin page (`/admin/usage` for `cap.*`, `/admin/users` for `member.*`, `/admin/activity` for `tool.*`, `/admin/events` for `ping`). A failed or budget-refused send is a failed delivery (`last_error = email_budget_exhausted` and so on) with the same retries; `email_not_configured` is dead at once with that code, and the UI says to set `EMAIL_FROM`.

**Cap alerts.** When an organization sets its first cap (`AppCapService.setMonthlyCap` with a number, and the organization has no subscription with `builtin = "cap_alerts"`), the gateway creates one: name "Cap alerts", sink email, recipients admins, events `["cap.warning", "cap.reached"]`. The Usage page's cap dialog says so in one line ("Owners and admins get an email at 80% and at the cap; change it under Events."). Turning it off is disabling it (the Events tab's switch; `everyapp events disable <id>`); removing a built-in row disables it rather than deleting it, so it is never recreated behind the person's back. Owners and admins who want Slack too add a webhook subscription for `cap.*`.

## 7. Apps emit their own events

`@every-app/sdk/server` exports `emit`:

```ts
import { emit } from "@every-app/sdk/server";

await emit({
  env,
  for: request,                       // or { background: true, organizationId }
  event: "invoice.paid",              // becomes app.<id>.invoice.paid
  data: { invoiceId: "inv_42", total: 1200 },
});
```

Rules the gateway enforces at `POST /api/events/emit` over the `EVERY_APP_GATEWAY` binding (`app-gateway-entrypoint.ts` gets a third route kind, `events`; attribution as for email: the request's identity or background work's organization; a shared app must say whom it is for):

- `event`: `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`, at most 64 characters; the gateway prefixes `app.<app id>.`. An app can't emit a gateway type (`member.joined`): the prefix makes that impossible.
- `data`: a JSON object, at most 8 KiB serialized, nesting at most 8 deep; any key, at any depth, matching `/secret|token|password|passwd|authorization|api[_-]?key|private[_-]?key|credential|cookie|session/i` is refused with `400 event_data_refused` naming the key, so a payload can't carry a credential by accident.
- `actor`: `{ kind: "user", id, email, name }` from the identity when there is one, else `{ kind: "app", id: <app id> }`.
- Rate: 600 emits per app per hour (`rate_limit_counters`, `events:emit:<app row>:<hour>`); past it `429 event_rate_limited` with `Retry-After`. Not a provider call: not counted in usage, not capped by the monthly cap.
- Nothing is declared in the manifest. An app that emits is like an app that logs; the subscriber chooses `app.crm.*`. (Ben's call: a `events: [...]` manifest list that the UI could show. Default: none this week.)

The SDK's `emit` throws `GatewayRefusalError` with the code on refusal; in local dev (`everyapp dev`, no binding) it validates the same way, prints `[everyapp dev] event app.<id>.<name>` and returns `{ id: "dev-…" }`. The starter emits `todo.completed` when a todo is marked done, in one line with a comment.

## 8. The CLI: `everyapp events …`

A top-level group like `email`, `access` and `mcp` (not under `workspace`: the parity thread's group is the UI's "Manage workspace" actions; events are also an app-developer concern and the brief names `everyapp events`). Every command takes `--gateway`, `--account-id`, `--json`, `--verbose`, and `--org <slug|id|name>` (the install organization by default, as `workspace` does). Written straight into the Gateway's D1 under the Cloudflare login (ADR-0003), mirroring the service's checks (`lib/gateway/events.ts`); the Gateway reads a new subscription on the next event (no cache).

| Command | Does |
|---|---|
| `events add <url> [--events <type,…>] [--name <text>] [--secret]` | adds a webhook subscription. `--events` is a comma list (repeatable); none means everything. `--secret` reads the signing secret from a hidden prompt (or stdin under `--json`, or `--secret-from-env VAR`), 16 to 128 characters; without it the CLI generates one and prints it once (`data.secret` under `--json`), saying it is shown once. Refuses a URL the target rules refuse (`EVENT_TARGET_REFUSED`) and the 26th subscription (`EVENT_SUBSCRIPTIONS_LIMIT`). |
| `events add --email owners\|admins [--events …] [--name …]` | adds an email subscription (no URL, no secret). |
| `events list` | the organization's subscriptions: id, name, sink and target (a URL's host and path, or "email → owners and admins"), events, enabled, last delivery and its status, consecutive failures. |
| `events remove <id>` | removes one (a built-in one is disabled instead and the output says so). |
| `events enable <id>` / `events disable <id>` | pause and resume. |
| `events test <id>` | queues a `ping` to that subscription, then waits up to 90 seconds for the delivery row to settle (the Gateway's per-minute sweep delivers it) and reports `delivered`/`failed` with the status code or error; `--no-wait` returns at once. |
| `events deliveries [<subscription id>] [--dead] [--limit n]` | the last deliveries (30 days): event type and id, attempts, status, last error, next attempt. |
| `events redeliver <delivery id>` | resets a delivery to pending; the sweep sends it within a minute. |
| `events types` | prints the catalogue (type, version, summary), for `--events`. |

Outbox inserts from other commands (section 5's table): a shared helper `queueEventFromCli(db, { organizationId, type, actor, data, appRowId?, dedupeKey? })` in `lib/gateway/events.ts` that inserts the `events` row and the matching `event_deliveries` rows in the command's own D1 batch, so an `app.installed` is queued atomically with the registration. A Gateway whose D1 predates migration 0009 has no `events` table: the helper checks once (`PRAGMA table_info(events)`, like `hasSecretNamesColumn`) and skips the insert silently for the outbox, and refuses `events add` with `GATEWAY_OUTDATED` ("the Gateway predates events; run `pnpm everyapp update`").

Error codes (documented on errors.md): `EVENT_TARGET_REFUSED`, `EVENT_SUBSCRIPTIONS_LIMIT`, `EVENT_SUBSCRIPTION_NOT_FOUND`, `EVENT_DELIVERY_NOT_FOUND`, `EVENT_TYPE_UNKNOWN` (a `--events` entry that matches nothing in the catalogue and isn't a pattern), `EVENT_SECRET_INVALID`, `EVENT_SINK_CONFLICT` (both a URL and `--email`), `EVENT_TEST_TIMEOUT`.

## 9. The admin MCP tools

On #614's `WORKSPACE_TOOLS` (`packages/toolbus/src/workspace.ts`, handlers in `apps/every-app-gateway/src/server/toolbus/workspace-tools.ts`), once it is on main; the same services as the server functions:

| Tool | Role | Input |
|---|---|---|
| `everyapp_workspace_events` | admin, read | `{}` → subscriptions with their last delivery |
| `everyapp_workspace_events_add` | admin, write | `{ url?, email?: "owners" \| "admins", events?: string[], name?, secret? }`; when `url` is given and `secret` isn't, the gateway generates one and returns it once in the result (this is the one credential a workspace tool returns, and only the one it just made for a target the caller chose; the design's decision 2 was about credentials that open the gateway) |
| `everyapp_workspace_events_remove` | admin, write, irreversible | `{ subscription, confirm: true }` |
| `everyapp_workspace_events_set` | admin, write | `{ subscription, enabled?, events?, name? }` |
| `everyapp_workspace_events_test` | admin, write | `{ subscription }` → the delivery's outcome after the immediate attempt |
| `everyapp_workspace_event_deliveries` | admin, read | `{ subscription?, dead?: boolean, limit? }` |
| `everyapp_workspace_event_redeliver` | admin, write | `{ delivery }` |

Each call is an audited tool call under `appId: "everyapp"` like the rest of #614. The parity matrix (`docs/design/2026-10-agent-parity.md`, when it lands) gets one row per server function above.

## 10. The UI: Manage workspace → Events

A seventh tab (`/admin/events`, icon `Webhook`), after Activity. Owners and admins.

- The list: name, target (host and path, or "Email → owners and admins"), events (chips, "Everything" for `*`), last delivery (time + status badge: Delivered, Failed, Dead), consecutive failures as a warning count, enabled switch. Row menu: Send test, Deliveries, Edit, Disable/Enable, Remove (ConfirmDialog; a built-in row says it will be turned off, not removed).
- Add subscription dialog: Kind (Webhook / Email), URL, Name, Events (grouped checkboxes by prefix with "Everything"; custom app events as a text field for a pattern), Secret (optional; "Leave blank to generate one"), for Email: Recipients (Owners / Owners and admins). On create with a generated secret: a reveal dialog like `UserTokenRevealModal` ("Copy it now; it isn't shown again").
- Deliveries sheet (per subscription, or all with a Dead filter): event type, time, attempts, status, last error, next attempt; Redeliver on failed and dead rows; "Show payload" opens the event's envelope (it holds nothing secret by construction).
- Empty state: what events are, the three things people wire (Slack, Zapier/n8n, their own agent), the docs link, and the CLI line.
- The Usage page's cap dialog gets the one line from section 6.

Screenshots light and dark in the PR, from the seeded local gateway (`scripts/seed-local.mjs`) with a few subscriptions and deliveries seeded (`seed-local` gains them).

## 11. Docs, skill, drift tests

- `landing-page/content/docs/events.mdx` (human): what it is in three sentences; add a webhook (CLI and UI); the Slack recipe without an app: Slack's Workflow Builder, "Starts with a webhook" trigger, variables `summary` and `type` (top-level string keys of the envelope), a "Send a message" step posting `{{summary}}`; say plainly that a classic Slack incoming webhook expects `{"text": …}` and so needs a relay (Zapier "Catch Hook", n8n Webhook node, Make) and give that as the second recipe; email alerts; verify the signature (Node, Python, Go); retries and the dead-letter view; the event list (from the catalogue).
- `landing-page/content/agent/events.md` (agent reference): the envelope, every type with its `data` shape and version, patterns, delivery and retries, the signature with the three snippets, the target rules and the private-targets setting, the SDK `emit` with the refusals, every `everyapp events` command and flag, the MCP tools, the error codes, limits, security. Listed in `meta.json` and on `index.md`'s table ("Get notified when …; wire Slack, Zapier, n8n; emit from an app").
- Drift test (`packages/cli/src/docs/agentDocs.test.ts`): `events.md` must name in backticks every type in `EVENT_TYPES` (exported from `@every-app/sdk/internal` so the CLI test can read it without the gateway), every `everyapp events` flag, every error code above, the three headers and the setting; `identity.md` names `emit` (the existing SDK-exports check does that once `emit` is exported).
- The everyapp skill: an `Events:` line in `SKILL.md`; `cli.md` regenerated; `errors.md` gains the codes; `secrets.md` gains `EVENTS_ALLOW_PRIVATE_TARGETS`.
- `docs/capabilities.md`: a short "Events" entry under gateway services (emit).

## 12. Threat model

A new boundary section **B9. Gateway → subscriber: outbound webhooks and the email sink** in `docs/threat-model.md`, rows in `docs/threat-model-invariants.md`, each pinned by a named test:

| Id | Invariant |
|---|---|
| `events.no-secrets-no-tool-io` | No event carries a credential, a tool's arguments or result, a mail body or a provider response: the catalogue's builders are the only writers of `data`, and a key named like a credential is refused for the gateway's own events and for an app's. |
| `events.signed-with-timestamp` | Every webhook delivery carries `X-EveryApp-Signature: t=…,v1=…`, HMAC-SHA256 over `<t>.<body>` with the subscription's secret; a subscription without a secret cannot exist. |
| `events.target-rules` | A subscription's URL is `https:`, a hostname (not an IP literal), not a loopback/private/internal name, not the gateway's own or an app's host, with no userinfo; `http:` and private names only under `EVENTS_ALLOW_PRIVATE_TARGETS=true`; the gateway's hosts never. Checked at add and before each attempt. |
| `events.no-redirect-pinned-url` | A delivery goes to the stored URL only, follows no redirect (`redirect: "manual"`, a 3xx is a failure), times out at 10 s, reads at most 1 KiB of the answer. |
| `events.org-scoped` | Subscriptions, events and deliveries are read and written under the acting organization only; an admin of one organization can't list, test or redeliver another's; the CLI's writes carry the organization id on every statement. |
| `events.admin-only` | The server functions and the MCP tools require owner or admin; the MCP tools require write access for writes; members and agents with read-only connections get nothing. |
| `events.app-emit-attributed-and-bounded` | An app's emit is attributed like every gateway call (the identity or a named organization; a shared app must say), prefixed `app.<id>.`, at most 8 KiB, credential-named keys refused, 600 per app per hour. |
| `events.email-sink-members-only` | The email sink mails the organization's live owners and admins only, by the gateway's sender, within the `notice` budgets; it takes no address. |
| `events.retention` | Events and deliveries older than 30 days are deleted by the hourly maintenance. |
| `events.secret-shown-once` | A generated secret is returned once (CLI output, the create dialog, the MCP tool's result) and never listed again by any surface. |

Gap to record honestly: the signing secret is stored as written in D1 (the CLI writes D1 directly and has no key to wrap it with; the operator's D1 is root per ADR-0003). What it protects against is a forged webhook to the subscriber's endpoint, not access to the gateway. A later key wrap is possible once a gateway-held key is the only writer (TODO).

## 13. Lanes and order

1. **Contract** (this document, the schema and migration 0009, the catalogue module skeleton): on `t3/events-out-2026-10-25`, pushed, before any lane starts.
2. **Core** (gateway): bus, delivery, targets, email sink, cron, maintenance, server functions, emit points, the app emit route, `apps.setup_state`, tests. One PR against main. Merges first.
3. In parallel with core, from the contract commit: **CLI** (`events` group, outbox helper, the outbox inserts in register/markDeployed/deleteApp/access/mcp, tests against the fake account), **SDK** (`emit`, dev behaviour, tests, the starter's line), **docs draft** (both pages, the recipes, the snippets; finalized after core), **threat-model draft**.
4. After core merges: **UI** (the tab), **MCP twins** (after #614), docs and threat-model finalized with line numbers and test names, `cli.md` regenerated, TODO section. Each a PR against main, merged green.

## 14. Defaults for Ben (also in TODO.md)

- **The scheduler is D1 plus a per-minute cron**, not a Durable Object or a Queue (section 4). Walk-back: a per-subscription Durable Object with alarms, same tables.
- **The signing secret is stored as written in D1** (section 12's gap). Walk-back: wrap with a gateway-held key once the CLI stops writing subscriptions directly.
- **Cap alerts are a built-in email subscription created with the first cap**, on by default, disabled from the Events tab or the CLI (section 6). Walk-back: never create it; the Usage page offers "Email me" instead.
- **Retention is 30 days, 25 subscriptions per organization, 600 app emits per hour, 8 KiB per app event, seven attempts over about 35 hours.**
- **Apps declare nothing in the manifest to emit.** Walk-back: an `events` list in `everyapp.config.ts` the UI shows.
- **`everyapp events` is a top-level group**, not `workspace events`.
- **Private targets** need `EVENTS_ALLOW_PRIVATE_TARGETS=true`; the gateway's own hosts are never a target.
- **`member.password_reset` or `member.reset_link_created`**: whichever Better Auth 1.7.7 allows (section 5).
- **No event for sign-ins** (`member.signed_in`): a session is not an event people wire today, and it would be the chattiest; add it when asked.
