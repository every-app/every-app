# #888: background work on one member's OAuth connection

Superseded by docs/design/2026-11-oauth-simplify.md.

**Agent-assumed, pending Ben's review.** Decided 2026-11-01 by the decide-888 agent. Source: TODO.md, "OAuth provider gaps from OpenMail's Gmail POC (2026-10-31)", the first question. Not built.

Before the plan changed to "decide autonomously", Ben answered two rounds of questions in the question tool on 2026-11-01. He picked the recommended option on all eight, and those answers are what this file records. He never said them in his own words, so treat it as his first look, not a ruling.

## The question

Background work (a cron, a queue consumer, a Workflow step, an alarm, an agent's turn: no request, `for: { background: true }`) reaches only the organization's connection (`capabilities/heldToken.ts`, step 5: `account = asked ?? (user ? "user" : "organization")`, and `account: "user"` with no user is refused). A member's own token works only while that member's 120 s identity is live, which means they have the app open.

- **OpenMail** wants to sync a person's own Gmail and draft replies as mail arrives, with nobody looking.
- **Birds** (`docs/birds/EVERYAPP.md`, the "Background work on one member's OAuth connection" row) wants a member's personal Agent to keep working with that member's GitHub (and their Slack user token) while they're away. The org Slack bot and the org GitHub App already work; acting *as the person* doesn't.

## Decision

**Option A, with limits: a per-app, per-person background opt-in, scoped to the sets the manifest marks for background use, which lapses after 90 days in which the member never opens the app.**

1. **Consent.** The opt-in is a page the Gateway draws, which the app links to: `connectUrl(provider, { background: true })` opens `/connect/<id>/background?app=<app>` on the Gateway host. The page names the app, the provider account (its label), the background sets and the app's `why`. It says "can create and change" when a set has write routes. The buttons are Allow and Cancel. If the person isn't connected yet, the page runs after the normal connect flow. The app never draws this consent.
2. **Scope.** The capability entry declares `background: { scopes: [...], why }`, a subset of its `scopes`. The opt-in covers only those sets. A background call on the member's connection outside them is `403 integration_scope_not_allowed`. Turning on background use is a deliberate manifest line that a reviewer can see.
3. **Writes.** A background call may write if the background sets have write routes, under the same method rules as in-session calls (`access: "write"`). OpenMail's drafts and Birds' PRs both need writes.
4. **The call.** `for: { background: true, organizationId, userId }` (with `account` defaulting to `user` when `userId` is given). Every call re-checks: the member is active and in the organization, can open this app, the opt-in exists and hasn't lapsed, the connection holds the sets and the path is in a background set. If any check fails, the call is `409 integration_not_connected` with `background: true` and a `connectPath` pointing to the consent page.
5. **Lapse and revocation.** The opt-in ends when:
   - the member revokes it (Settings → Connected accounts, per app);
   - an owner or admin revokes it (Manage workspace → Providers; audit-logged);
   - the connection is disconnected;
   - the member loses access to the app or is deactivated;
   - the app is deleted or disabled;
   - 90 days pass with the member never opening the app. The perimeter touches `last_seen_at` on the member's app sessions, at most once a day.
6. **Attribution.** The call belongs to the app, on behalf of the member: the actor is the app (as background work is today) and `onBehalfOf: <userId>` goes on the log and events. Usage counts it as the app's. The app never receives an identity token for that person.
7. **Audit.** Grants, revocations and lapses get events: `provider.background_granted`, `provider.background_revoked` (with the actor) and `provider.background_lapsed` (with the reason). There is also one `connection.used` per opt-in per UTC day, deduplicated as linked dev does. `integration.proxy.call` carries `background: true` and the user. On Connected accounts the member sees "<app> can use this in the background", with the last time it did so.
8. **Scope of v1.** First-party organization apps only (`scope = 'org'`). Shared or hosted apps would need the organization chosen at consent, as linked dev and MCP consent do; that is a follow-up.

## Why

- **B doesn't serve either app's real goal.** "Sync only while active" is what OpenMail already does. Birds' personal Agent is defined by working while you're away. B is the status quo with a label on it.
- **Without consent, A is impersonation.** If an app could name any `userId` in the background, any code in any app Worker could act as any member at any time. The per-person, per-app opt-in recorded on the Gateway is what makes the capability safe. The Gateway is the only party that can show a consent page the app can't fake.
- **The limits shrink the blast radius from "every set, forever" to "the declared sets, for active users".** A compromised app Worker can still act as every opted-in member, but only within the background sets, and only for members who use the app. Each grant can be revoked separately and is visible to the member and to admins.
- **It reuses what exists.** The connection rows, scope sets, `heldTokenCallAllowed`, the consent-page pattern from native sign-in and linked dev, linked dev's daily `connection.used` deduplication, and the existing lapse paths (deactivation, app removal) all apply.
- **Admin revoke from day one** closes, for this kind of grant, the B5 gap that MCP, native and linked dev connections still have.

## Rejected alternatives

- **B, sync only while the person is active.** It costs nothing, but it leaves OpenMail's arrival-time drafting and Birds' away-mode personal Agent unbuilt.
- **A for reads only.** The blast radius is smaller, but both apps' main use is a write (Gmail drafts, GitHub PRs or comments, Slack posts).
- **A over the whole connection.** Every set an app holds would work unattended. An app asking `gmail.send` for an in-session button would get it in the background too.
- **An admin switch per app instead of per-person consent.** Someone else would be consenting for your mailbox.
- **No idle lapse.** Simpler, but someone who stopped using OpenMail months ago would still have their mail read.
- **A fixed 90-day re-approval.** Active users would keep re-consenting for no security gain over the idle lapse.
- **A checkbox on the connect page.** An existing connection would need a reconnect to opt in. The separate page works for both new and existing connections.
- **An event per call.** A mail sync makes hundreds of calls per person per day. A daily `connection.used` plus the per-call log line is the linked dev precedent.
- **Treat the call as the member's own** (an identity as if signed in). That blurs "the person did this" with "an app did this while they were away", and it would hand the app a person's identity with no person present.

## Confidence

- **High:** A over B, the Gateway-drawn consent and the per-call re-checks.
- **Medium:** the manifest `background` field as the scope limit, attribution as app-on-behalf, and allowing writes.
- **Low:** the 90-day idle window (the number is a guess) and the event names.

## What Ben should check

- Is a compromised app acting as every opted-in member, within the background sets, an acceptable residual risk? It is the inherent cost of A.
- Whether a Google refresh token used unattended needs anything more at Google: app verification for restricted Gmail scopes is already a requirement for OpenMail.
- The consent page's wording, especially for write sets. This is the line people actually read.
- That v1 is first-party organization apps only. Birds is one, so it is fine.
- Run `pnpm security-review` on the implementation PR: it touches OAuth, identity and consent.

## What would change it

- If Ben wants no unattended use of personal tokens at all, the answer is B, and Birds uses the org GitHub App and Slack bot only, with a person-run hand-off for anything that must be "as me".
- If Google or GitHub policy forbids it or makes it costly (offline access review for restricted scopes), that would push toward reads only, or toward B for that provider.
- If a real app needs the background on a shared or hosted app, the organization has to be chosen at consent (follow-up 8).
- If the idle lapse misfires (someone who "uses" OpenMail only through its drafts never opens the app), the window should be measured from the last background use with the member's approval, not from app opens. Revisit after OpenMail's first month.

## Implementation brief (5 lines)

1. Migration: a `provider_background_grants` table (connection id, app row id, user id, sets, granted_at, last_seen_at, revoked_at, reason). The manifest validator learns `background: { scopes, why }` (a subset of `scopes`).
2. Gateway: the `/connect/<id>/background` consent page and decision route; Connected accounts and Manage workspace → Providers list and revoke grants; the hourly maintenance lapses grants that are idle, have no app access, or whose member is deactivated; the perimeter touches `last_seen_at` daily.
3. `capabilities/heldToken.ts`: a background call naming `userId` takes the member's connection only after checking member live, app access, an active grant, sets held and the path in a background set; it logs `background: true` and `onBehalfOf`.
4. SDK: `for: { background: true, organizationId, userId }` in `attribution.ts` sends `x-everyapp-user`; `connectUrl(..., { background: true })`; `integrationStatus` reports `connection.background`. `everyapp dev` honours it in stub mode.
5. Events (`provider.background_granted|revoked|lapsed`, a daily `connection.used`), threat-model rows, the agent docs (`identity.md`, `providers.md`, `manifest.md`), tests, then `pnpm security-review`. OpenMail and Birds adopt it after it merges.

## Build assumptions

**Agent-assumed, pending Ben's review.** Made while building on `birds/888-background-oauth` (2026-11-01), where the decision above left a choice open.

1. **One row per (connection, app).** `provider_background_grants` keeps one row per pair. A grant made again after a revocation or lapse reuses the row and its id, and resets `granted_at` and `last_seen_at`. Revocation and lapse share `ended_at`, `ended_reason` and `ended_by`, instead of a separate `revoked_at`. Ended rows are kept, with no retention purge yet.
2. **A disconnect ends the grants at once** (`disconnected`), instead of waiting for the sweep. A reconnect after a disconnect is a new connection row, so it needs a new consent. A reconnect in place (same connection id) keeps the grant.
3. **"Opens the app" means a browser session** that passed the perimeter's access check for an organization app (`betterAuthAuthenticator.hasAppAccess`). A personal access token, MCP or native token's use doesn't count. The touch writes at most once a day per (member, app) per isolate, and only when the row's `last_seen_at` is a day old.
4. **The 90-day idle clock** starts at the grant and is reset by a seen touch or a new grant. A call also ends an idle grant itself, not only the hourly sweep.
5. **The grant records its sets.** A call needs the entry's current background sets to be within the grant's. If a later deploy adds a background set, the member consents again (409 with the consent page). If a deploy removes one, the grant still works for the rest.
6. **The consent POST must name exactly the sets** the deployed manifest marks at that moment, else the page is shown again. There is no per-render nonce: Sec-Fetch-Site same-origin (else Origin), the control-plane CSRF guard and the session are the checks, as on the MCP consent page.
7. **Write wording.** A set says "can read, create and change" when its `access` is `write`. Read sets say "can read". The decision said "has write routes"; the set's `access` is what the registry actually carries.
8. **Refusal codes.** Every per-call check failure is `409 integration_not_connected` with `background: true` and `connectPath` set to the consent page. An entry without `background` (or a Gateway without the port) is `403 integration_scope_not_allowed`. `x-everyapp-user` with a person's identity, with `account: "organization"`, or malformed (not `[A-Za-z0-9_-]{1,128}`) is `400 integration_body_invalid`.
9. **v1 eligibility** is an app with a registry row, `scope = 'org'` and tier `service_binding`. Linked dev never gets the background port. The hosted host-session authenticator doesn't touch `last_seen_at`, since its apps aren't eligible.
10. **The consent page is plain HTML** served from the worker (like the connect flow's error page), not a TanStack route.
11. **No connection yet.** The page sends the member to `/connect/<id>` without `sets`, so the connect asks the union every active app declares and doesn't drop another app's sets, then back once (`connected=1`). If the connection still lacks a set, the page says so instead of looping.
12. **`connection.used` for background** has `connection: { id: <grant id>, clientName: <provider label>, kind: "background" }`, plus `provider`, `app` and `user`, and the app as the actor. It is deduplicated by the key `background:used:<grant id>:<UTC day>` in `rate_limit_counters` (linked dev's mechanism), and it also sets `last_used_at` once a day.
13. **Revocation events.** `provider.background_revoked` carries `by: "member" | "admin"`, with the revoker as the actor. An owner or admin revoking their own grant counts as `member`. `provider.background_lapsed` reasons are `idle`, `no_access`, `member_inactive`, `app_removed` and `disconnected`.
14. **`connection.background` in the status** is reported only when a person is behind the status request. It runs the same check as a call, so a status request can end an idle grant.
15. **The SDK sends `x-everyapp-user`** on any gateway call made with `for: { background: true, userId }` (`applyAttribution`). The Gateway reads it only on the held-token branch and ignores it elsewhere, as the docs say.
16. **In `everyapp dev` stub mode**, the developer's token stands for the member's connection and their opt-in. No consent is simulated; calls are held to the entry's background sets.
17. **The sweep** ends at most 1000 grants a run.
18. **The UI** lists live grants only, under Settings → Connected accounts → Background use (the member's) and Manage workspace → Providers → Background use (everyone's), each with Revoke.
