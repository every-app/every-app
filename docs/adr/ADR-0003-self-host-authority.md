# ADR-0003: Self-Hosted Operator Authority Is Cloudflare Account Access

- Status: Accepted
- Date: 2026-10-15
- Supersedes: ADR-0002 Decisions 2 and 3 (ADR-0002 was deleted on 2026-10-24; git history at 5ef30882)

## Context

ADR-0002 moved the control plane toward an API-first contract and called
two things transitional: the CLI writing the gateway's D1 directly, and
Cloudflare-credential checks as proof of authority. In practice the
self-hosted CLI never stopped deriving its authority from the Cloudflare
login. `everyapp setup` writes the owner setup link straight into D1, and
the deploy token (`eak_`) that the deploy API required was itself minted
from that write. The token added a second credential with its own lifetime,
storage (`~/.everyapp/credentials.json`), admin UI and revocation rules,
without adding any power the Cloudflare login did not already have.

The project is a proof of concept with no users. The hosted tier (ADR-0001)
is not built, and its deploy API is disabled by `GATEWAY_DEPLOYMENT_MODE`.

## Decision

1. In `self_hosted` mode, write access to the gateway's D1 database in the
   gateway's Cloudflare account **is** operator authority. The CLI reads
   and writes the app registry (`apps`, `user_app_access`,
   `organization_keys`), the install row, the deploy lease, the resource
   ledger and the owner setup link through `cf d1 query`, with the
   operator's own Cloudflare login or API token. No gateway-issued deploy
   credential exists. Decision 6 narrows what else it writes.
2. The registration rules (reserved ids, Worker and resource names,
   hostnames, takeover checks against existing rows, initial access) live
   once, in `@every-app/perimeter/registry`, and run wherever a write
   happens: in the CLI for self-host, in a hosted API later.
3. The gateway has no deploy API in self-host (`/api/deploy/*` is removed).
   It activates an app on the first request that reaches a service binding
   to that app's Worker, and it syncs tool catalogs on first use, on drift
   and when the app's version changes.

   Since #371 the Gateway also installs a published release from the
   browser (`POST /api/admin/apps/install`, with the account token
   `CF_DEPLOY_TOKEN`; `docs/runbooks/gateway-app-installs.md`), since
   2026-10-24 only for the install organization's owners and admins (the
   token is the account's; `docs/security.md`, known gap 1).
4. Every deploy records its actor on the app row (`deployed_by_actor`): the
   Cloudflare login's email, or `api-token:<account id>` in CI.
5. The hosted tier gets its own HTTP control plane and credentials (a
   browser login to the gateway issuing an org-scoped session, and per-app
   CI credentials). Nothing in this ADR's trust model applies there.

6. **What the CLI writes (2026-11-02).** The Gateway's admin tools (the
   `everyapp_*` built-ins on its `/mcp`, which run through its real
   services) are the one admin API, for agents in chat and for the
   terminal alike. The CLI's admin commands (`workspace`, `events`, `ai`
   but `ai gateway`, and `everyapp call <tool> [json]`) are thin clients
   of those tools, run as the person: `EVERYAPP_TOKEN` (a personal access
   token) or an OAuth sign-in to `<gateway>/mcp` (`everyapp login
   --gateway`, the native sign-in flow linked dev uses, kept 0600 in
   `~/.config/everyapp/gateways.json`). They never touch D1, so their
   rules, roles and events are the Gateway's own.

   The CLI keeps direct D1 writes under the Cloudflare login only where
   nothing else can work:

   - **Bootstrap**: `setup` before an owner exists (the install row and
     the owner setup link in `owner_setup_tokens`).
   - **The deploy path**: the install row (`_everyapp_install`), the deploy
     lease (`_everyapp_deploy_lease`), the resource ledger (app resources),
     the `apps` row with its access and an app's own `app` event
     subscription, and the outbox row (`events`, `event_deliveries`) that
     records `app.installed`, `app.updated`, `app.email_changed` and
     `app.removed`. The deploy runs before and without a Gateway session
     (CI, a first install), and it uploads Workers, which only the
     Cloudflare credential can.
   - **The recovery link**: `workspace reset-link <email>`, a one-hour,
     single-use password reset (`verifications`) for an active member of
     the install organization alone. It is the way back in for an owner
     who can't sign in, so it can't need a Gateway credential.
   - **The invite link**: `workspace invite-link <email|id>`, a new link
     (`invitation_link_tokens`) for a pending invitation of the install
     organization, the CLI twin of Admin → Users → Copy invite link. The
     tools never return a credential to their caller (parity decision 2),
     and a Gateway that sends no email has no other way to hand an
     invitation over from the terminal.

   Still writing D1 directly at the time of writing, to move to the tools
   or to the Gateway's own encrypted settings next: the Worker-secret
   commands' rows and events (`secret`, `signin`, `access`, `email set`,
   `provider`, `mcp`; the remote MCP rows belong to the MCP-apps work).
   No new command may write D1 outside the list above; a command that
   needs a new admin action adds a Gateway tool and calls it.

ADR-0002's Decisions 1 and 4 to 6 stand for the hosted tier. Its Decisions
2 and 3 are superseded: direct D1 writes are the self-host design, not a
transitional path, and the Cloudflare credential is the self-host root of
trust, not compatibility behaviour.

## Rationale

- The authority already existed. Anyone who can write the gateway's D1 can
  create an owner link, redeploy the gateway Worker, or edit any row. A
  gateway-issued token could only ever confirm what the caller already
  had.
- One credential is the whole point for a self-hoster: nothing to create,
  paste, renew or revoke besides the Cloudflare login they need anyway to
  upload Workers.
- Rules in one shared package mean the gateway and the CLI cannot disagree
  about names or access, and a hosted API can call the same functions.
- Fewer routes on the public Worker: nine deploy routes and one setup route
  disappear, and with them a bearer scheme that had to be right.

## Consequences

Positive:

- Apps can be registered and deployed before the gateway has an owner, so
  a CI-first install works.
- For deploys the CLI keeps no state on the machine beyond the Cloudflare
  login; the admin commands keep the person's Gateway sign-in (decision 6),
  which revokes like any AI connection.
- No deploy-token lifecycle, admin UI or `app_tokens` table.

Negative, accepted for self-host:

- Revocation is Cloudflare's alone. Removing, banning or deactivating a
  gateway member does not stop them deploying while they still hold the
  Cloudflare login or a token for the account.
- Any Cloudflare API token with D1 write on the account is an operator,
  including the token every app's CI uses to upload Workers.
- The CLI and the gateway must agree on the D1 schema. They ship from one
  checkout, the CLI redeploys the gateway from that checkout whenever it
  has to rebind an app, and a checkout older than the live gateway refuses
  to deploy.

## Security Assumptions

- Compromise or misuse of the Cloudflare credential carries account-wide
  blast radius, as ADR-0002 already stated.
- This trust model is intentionally not valid for hosted multi-tenant
  operation. See `docs/security.md` for the boundaries.

## Follow-ups

- The hosted control plane design in `docs/architecture-v2-*.md` (deleted 2026-10-24; git history at 5ef30882) names the
  perimeter registry rules as its write path.
