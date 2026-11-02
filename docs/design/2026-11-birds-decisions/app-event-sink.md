# §1.13 The `app` event sink: what was built, and what was assumed

Written 2026-11-01 on `birds/app-event-sink`, from main at `4a319e33`. The brief is entry 5 in `docs/design/2026-11-birds-decisions/forcing-function.md` (on `birds/decisions-forcing-function`), which follows §1.13 of `docs/design/2026-11-birds-forcing-function.md` except on the families: an **allowlist**, not the doc's deny-list. The bus it extends is `docs/design/2026-10-events-out.md`; the agent reference is `landing-page/content/agent/events.md` ("The app sink").

Every entry under "Assumptions" is **Agent-assumed, pending Ben's review**.

## What was built

- **Manifest.** A top-level `events: { subscribe, why }` (`packages/perimeter/src/manifest/manifest.ts`, `EventsSchema` for the tolerant schema, `EventsSchemaStrict` for the deploy's; the SDK's hand-written `EveryAppManifest` has it too). The strict schema checks each pattern with `appSinkPatternProblem`.
- **Allowlist** (`packages/sdk/src/internal/events.ts`): `APP_SINK_EVENT_FAMILIES` = `member`, `group`, `app`, `mcp_app`, `connection`, `tool`; `APP_SINK_EXCLUDED_TYPES` = `member.password_reset`. `appSinkTypeAllowed(type)` is checked at deploy (via the pattern check), when the Gateway's bus and the CLI's outbox queue a delivery to an `app` row, and before each attempt.
- **Table.** `event_subscriptions.app_row_id` (migration `0023_app_event_sink.sql`), sink `"app"`.
- **Deploy reconcile** (`packages/cli/src/lib/gateway/events.ts`, `appSubscriptionStatements`; called from `markDeployed` in the same batch that records the upload). Insert on first subscribe, replace patterns and description on each deploy (a pause kept), delete when the manifest drops `events`. `deleteApp` (CLI) and `AppRepository.tombstone` (Gateway) delete it with the app.
- **Delivery** (`apps/every-app-gateway/src/server/events/app-sink.ts`). `POST /__everyapp/events` over the app's binding (`appFetcherFor`, the catalog sync's seam), the webhook envelope as the body, a 60 s system token `purpose: "events.deliver"`, `aud` = the Worker name, and a new `bh` claim = SHA-256 of the body. Retries, dead state and the log are deliver.ts's.
- **Perimeter.** `isReservedEventsPath` (`publicRoutes.ts`), refused next to the tools path in `gateway.ts` (one condition widened, nothing else touched).
- **SDK.** `everyApp(handler, { events: { on } })` (`packages/sdk/src/server/eventsEndpoint.ts`). It verifies the token and the body hash, then checks the envelope's organization against `EVERY_APP_ORG_ID`, then runs `on` under `withOrganization()`.
- **Admin surfaces.** An `app` row is listed like the others. `update` refuses to change its `events`; `remove` pauses it, as for a built-in row.

## Assumptions (Agent-assumed, pending Ben's review)

1. **The allowlist is the brief's, unchanged.** `connection.used` and every `tool.*` type are offered; `app.*` includes every app's own `app.<id>.*` events, not only the subscriber's. The brief asked Ben to look at these.
2. **A body-bound token (`bh`).** The brief names only purpose `events.deliver`. I added a `bh` claim (the SHA-256 of the body), required for that purpose by both the minter and `assertSystemClaims`, so one token opens one delivery. A 60 s `tools.list` token was already unbound, but it only reads a catalog. An `events.deliver` token makes the app act.
3. **No self-delivery.** An app never receives its own `app.<id>.*` events back (the bus skips them when the event's `appRowId` is the subscriber's), so an `on` that emits can't loop. The 600/hour emit cap would have bounded a loop anyway.
4. **The subscription belongs to the manifest.** Admins can pause, rename, test and redeliver it. Changing its events is refused (`INVALID_INPUT`, no new error code). Remove pauses it instead, since the next deploy would make it again. A redeploy keeps a pause.
5. **The organization is the app row's own** (`apps.organization_id`). A shared app (`scope: "shared"`) therefore receives its registering (platform) organization's events only, not those of every organization that uses it. Fanning out to every organization was out of scope and would need its own design.
6. **The app sink doesn't count toward the 25 subscriptions** an organization may add by hand. The deploy writes the row directly and doesn't check the cap.
7. **SDK answers.** An event with no handler gets 200 (acknowledged and dropped). A Worker without `events` gets 404 `no_handler`, which is retried, so the deliveries arrive once the code ships. A throwing `on` gets 500 (retried). An event for another organization gets 403 (retried, then dead). `on` is one function or a record keyed by exact type (no patterns).
8. **Liveness.** An app that isn't `active` (binding, disabled) is a failed attempt (`app_not_live`), retried on the webhook schedule. A deleted app, a provider/MCP row, or a row without a Worker is dead at once.
9. **Migration number 0023.** `birds/888-background-oauth` also adds a `0023_*`. Whichever lands second renumbers to 0024 and regenerates its snapshot's `prevId` and journal entry.
10. **An old Gateway.** A deploy whose manifest declares `events` to a Gateway without the column fails with `GATEWAY_OUTDATED` before writing. Without `events`, nothing changes.
11. **Dev.** `everyapp dev`'s gateway-lite doesn't deliver events. An app tests `on` by calling it directly, or against a live Gateway. That's a follow-up.
12. **UI.** No new UI. The Events tab shows the row as "App → its own Worker". The edit dialog still offers the event picker for it, and the server refuses the change. Hiding the picker there is a small follow-up.
13. **The user docs** (`landing-page/content/docs`) are unchanged. The agent references (events.md, manifest.md, identity.md) carry it.

## What would change it

- An app that needs `provider.*`, `cap.*` or `organization.*`: add the family to `APP_SINK_EVENT_FAMILIES`, deliberately.
- A decision that `app.*` should mean the subscriber's own app only: narrow `appSinkTypeAllowed` for `app.<other id>.*`.
- Shared apps needing per-organization events: one subscription per organization the app is granted to, made when it is granted.
