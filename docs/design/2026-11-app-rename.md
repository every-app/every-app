# Renaming an app: `previousIds`

Written 2026-11-07 for Ben. Built in the same PR. The question: can an app change its id and hostname gracefully, without a fresh deploy, so it keeps its old resources? The case is `talk`, which becomes Scribe (`scribe`).

## 0. The short answer

Yes, and it's cheap. The id was never what names the resources. Registration names an app's Worker once and stores it (`apps.worker_name`). Every D1, KV, R2 and other resource is named after that Worker, never after the id. Every per-app row on the Gateway (grants, groups, tokens, OAuth connections, tools, caps, usage, events) is keyed by the app's row id, not its slug. So a rename changes two columns of one row (`app_slug`, `hostname`), records the old pair, and leaves everything else alone. No data is copied and no resource is created.

```ts
// everyapp.config.ts
export default defineConfig({ id: "scribe", previousIds: ["talk"], name: "Scribe", /* … */ });
```

`everyapp deploy` sees that `scribe` isn't registered and `talk` is. It shows what moves, asks, renames the app, then deploys as usual. `talk.<base>` keeps working.

## 1. What the id names today, and what a rename changes

| Thing | Derived from | After `talk` → `scribe` |
|---|---|---|
| Registry row (`apps.id`) and everything keyed by it | random UUID | **kept** |
| Worker name (`apps.worker_name`) | first id, once, at registration | **kept**: `every-<orgKey>-talk` |
| D1 / KV / R2 / queues / … | the Worker name | **kept**: e.g. `every-<orgKey>-talk--updates` |
| The app Worker's secrets | live on the Worker | **kept** |
| Identity JWT audience | the Worker name | **kept** (old code keeps verifying) |
| `apps.app_slug` | the id | `scribe` |
| Hostname | the id | `scribe.<base>`; `talk.<base>` served as below |
| `AppGateway` binding props `appId` | the id, at upload | `scribe` from the next upload; the old Worker's `talk` is still accepted (§4) |
| MCP tool names on the Gateway's `/mcp` | the id | `scribe_*` (clients re-list) |
| Linked dev resource (`/linked-dev/<id>`) | the id | `everyapp dev --linked` signs in again |
| Local `everyapp dev` D1 | the id | a new, empty local database (re-seed) |

Rejected alternatives:

- **Pinning resource names in the manifest** (`resources.d1: [{ binding: "DB", name: "every-talk" }]`). That's not needed, since names already follow the Worker. It would also let a manifest bind any resource in the account by name, which the registry exists to prevent.
- **A new app plus a data copy.** It costs a migration window and loses every per-app row (grants, tokens, connections).
- **A hostname alias only, keeping the id.** It wouldn't give the app the new id its tools, events and CLI commands use.

## 2. Data model

A new table, `app_previous_ids` (migration `0033`):

| Column | |
|---|---|
| `organization_id`, `app_slug` | primary key: the previous id, per organization |
| `app_row_id` | the app it belongs to (cascade on delete) |
| `hostname` | the hostname the app had under that id; unique |
| `renamed_at` | when |
| `moved_at` | when the new hostname first answered; page loads redirect only from then on |
| `retired_at` | when the id left `previousIds`; the hostname is no longer served |

A previous id is the app's for good. Its Worker still carries that id, so no new app may take the id (`APP_ID_RENAMED`), and the Worker-name rule (`isRegistryWorkerName`) accepts a Worker named after any of the app's ids (`previousAppIds`). The gateway's bind list (`desiredState`) and the registration rules both pass them.

The rules are pure functions beside `planRegistration` (`packages/perimeter/src/registry/registration.ts`): `planRename` and `previousIdChanges`. The CLI does the reads and writes (`packages/cli/src/lib/gateway/rename.ts`).

## 3. The deploy flow

`planRenameFor` decides before anything is registered:

| `id` registered? | `previousIds` names | Result |
|---|---|---|
| no | one app (by its id, or an id it had) | **rename** that app |
| no | nothing | `PREVIOUS_ID_UNKNOWN`: never a new app |
| no | two apps | `RENAME_AMBIGUOUS` |
| yes | only its own previous ids | a normal deploy |
| yes | another live app | `RENAME_TARGET_EXISTS` (no merging) |
| yes | an id it never had | `PREVIOUS_ID_UNKNOWN` |
| deleted (tombstone) | a live app | `RENAME_TARGET_EXISTS` (the id stays reserved) |

On a rename:

1. `app.rename` (start) carries the plan. A person sees it above the question. `--yes` answers for CI, and unattended without it the run stops with `CONFIRMATION_REQUIRED` (rerun with `--yes`, `authorize: true`). A shared app takes a platform owner or admin, as its deploy does.
2. One D1 batch: the row takes the new id and hostname (only while it still has the old id), and a previous-id row is inserted. Then the ordinary pipeline runs and finds the app registered under `scribe`.
3. After the upload, `previousIds` is synced: an id it dropped is retired, and one it lists again is served again.
4. `app.bind` redeploys the Gateway when the published hostnames changed. That publishes `scribe.<base>` and keeps `talk.<base>`.
5. Once `https://scribe.<base>` answers over HTTPS, `moved_at` is set and page loads on `talk.<base>` start redirecting. Until then, or with `--no-wait`, the old host serves the app in full (`RENAME_NOT_MOVED`, a warning), so nobody is sent to a host still waiting for its certificate. The next deploy finishes it.

What a person sees (from the test harness):

```
scribe lists talk under previousIds, so this deploy renames talk on example.com:
  Id         talk → scribe
  Hostname   https://talk.example.com → https://scribe.example.com
  Old host   keeps working: page loads and shared links redirect (308) to the new host once it answers;
             API calls with a bearer token, and every non-GET request, are served there as before
  Kept       the Worker every-acme-talk and its secrets, D1 every-acme-talk, KV every-acme-talk, and everything else named after it
  Moves      who can open it, groups, tokens, AI and OAuth connections, caps, usage, email setup
  Changes    its AI tools are named scribe_* (were talk_*); linked dev signs in again
? Rename talk to scribe? (y/N) y
Renamed talk to scribe ✓
  https://talk.example.com keeps working; the app is at https://scribe.example.com
Deploying scribe to example.com (Acme)
…
Uploaded ✓
Added to the Gateway ✓
talk.example.com now redirects page loads to scribe.example.com ✓
```

## 4. The old hostname

`DrizzleAppRegistry.findByHostname` falls back to a served previous hostname. It returns the same app with `hostname` set to the old host and, once moved, `movedTo` set to the new one. The perimeter (`handleGatewayRequest`) then:

| Request on `talk.<base>` | Answer |
|---|---|
| GET/HEAD, no bearer, not a WebSocket (page loads, `/s/:token`, bookmarks) | `308` to the same path and query on `scribe.<base>`, `cache-control: no-store` (so renaming back never leaves browsers looping) |
| Anything with a bearer (`/api/v1/**` from the desktop app) | served there, as before. A cross-host redirect would drop `Authorization` |
| POST/PUT/… (webhooks, forms), WebSockets | served there |
| `/.well-known/oauth-protected-resource` | names `https://talk.<base>` as the resource (RFC 9728 requires the URL the client used) |

Because the app is served with `hostname` = the old host, the native-token check (`boundToAnotherApp`: the token's audience host must be the served host) holds unchanged. The Gateway's OAuth resource list (`currentAppResources`), a native grant's refresh (`grantStands` → `findAppResources`) and consent (`findActiveAppByHostname`) all include served previous hostnames. A desktop app signed in on `talk.<base>` keeps its token and keeps refreshing it. A `/s/:token` link redirects and works on the new host, since it is the same app with the same public routes.

Behind Cloudflare Access, `readPublicSurfaces` lists previous hostnames with the app's public and bearer routes, and a deploy that changes hostnames reruns the Access recipe.

The `AppGateway` entrypoint: until its next upload, the old Worker's binding props still say `appId: "talk"`. `findByOrgPreviousApp` finds the app by its previous id, and the call is accepted only when the props' Worker name is the row's. It is then handled as `scribe`. So AI, email and integration calls don't break between the rename write and the upload, or after a failed build.

## 5. Lifecycle: removing a previous id

The old hostname is served while its id is in `previousIds`. A deploy without it retires the hostname (`retired_at`), the Gateway stops publishing it, and native tokens issued for it stop validating. Putting it back serves it again. The id itself stays the app's either way, because the Worker is named after it. Deleting the app retires its previous hostnames; reviving it doesn't bring them back. Renaming back (`id: "talk", previousIds: ["scribe"]`) reclaims `talk`'s own row.

Not supported: renaming a dispatch-tier (hosted third-party) app, whose Worker must carry its id (`RENAME_UNSUPPORTED`). The hosted deploy API and browser installs refuse a manifest that would rename (`RENAME_UNSUPPORTED`), and send it to `everyapp deploy`/`install`.

## 6. Security

- No new authority: only a deploy (the Cloudflare login, ADR-0003) renames, a shared app takes a platform owner or admin, and the rename is confirmed.
- A previous hostname serves exactly the app its row names, under the same perimeter (session, access, CSRF, setup gate). Redirects only go to the app's registered hostname, never anywhere a request names.
- B4 (`docs/security.md`): a caller is still the registry row whose Worker and organization its props name. A previous id widens the match only to the same Worker's own former id.
- A native token is still good only on the host it was issued for; the host list now includes served previous hostnames.

## 7. Renaming `talk` → `scribe`

Not run by this PR. Once it ships:

1. **Release it.** Ben runs `pnpm publish:rc` (CLI, SDK and the Gateway release with migration `0033`).
2. **Update the Gateway** talk runs on, before any app deploy: `pnpm everyapp update`. A newer CLI refuses an older Gateway with `GATEWAY_OUTDATED` anyway. This applies `0033` and ships the new perimeter. Nothing changes for any app yet.
3. **In the app repository** (private-open-scribe):
   - pin the new `everyapp` and `@every-app/sdk` versions (`docs/runbooks/app-releases.md`);
   - in `everyapp.config.ts`, set `id: "scribe"`, `previousIds: ["talk"]` and `name: "Scribe"`. Leave `resources` as they are: `DB` and `UPDATES` keep binding `every-<orgKey>-talk` and `every-<orgKey>-talk--updates`;
   - search the code for the old id or hostname it builds URLs from (`talk.`, `"talk"`). `EVERYAPP_APP_ID` becomes `scribe`.
4. **Deploy** from the app's directory: `pnpm run deploy` (or `pnpm everyapp deploy`). Read the plan and answer `y`. In CI, use `pnpm everyapp deploy --yes`.
5. **Check:**
   - `pnpm everyapp status` lists `scribe`, live, at `https://scribe.<base>`;
   - `curl -sI https://talk.<base>/` answers `308` with `location: https://scribe.<base>/`;
   - the desktop app works unchanged: its `/api/v1` calls with its token on `talk.<base>` are served there;
   - an old `/s/<token>` link opens, after one redirect.
   If the deploy ended with `RENAME_NOT_MOVED` (the new certificate was slow), `talk.<base>` still serves Scribe in full. Deploy again later to turn the redirect on.
6. **Later, optional:** point the desktop app at `scribe.<base>`. Once no client uses `talk.<base>`, drop `previousIds` and deploy to stop serving it. Anyone signed in to the desktop app on the old host then signs in again. Nothing requires this; keeping `previousIds: ["talk"]` costs nothing.
