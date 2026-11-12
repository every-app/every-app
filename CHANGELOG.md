# Changelog

## Unreleased

### Rename an app (`previousIds`)

An app can change its id and hostname and keep everything else. Change `id` in `everyapp.config.ts` and list the old one under `previousIds`:

```ts
export default defineConfig({ id: "scribe", previousIds: ["talk"], name: "Scribe" });
```

`everyapp deploy` (and `everyapp install` of a release) sees that the new id isn't registered and the old one is, shows what moves, and asks first (`--yes` for CI; unattended without it, `CONFIRMATION_REQUIRED`). The app keeps its registry row, its Worker and every resource named after it (D1, KV, R2, …), its secrets, and everything the Gateway holds for it: access, groups, tokens, AI connections, its access to people's OAuth connections, caps, usage, email setup. The old hostname keeps working. Page loads and shared links get a `308` to the new host once it answers; bearer API calls, other methods and WebSockets are served on the old host as before, and native sign-ins made there keep working. Its tools are named after the new id. Removing the old id from `previousIds` stops serving its hostname; the id stays the app's. An id in `previousIds` that no app has stops the deploy (`PREVIOUS_ID_UNKNOWN`) instead of creating a new app. Design: `docs/design/2026-11-app-rename.md`; how-to: [deploy](https://everyapp.com/docs/agent/deploy#renaming-an-app).

What you do: `pnpm everyapp update` brings the Gateway to migration `0033` (`app_previous_ids`). This everyapp refuses an older Gateway with `GATEWAY_OUTDATED` until you do.

### One OAuth connection per person per provider

A person connects a provider once, to EveryApp, and each app then asks them for access (the OAuth bullets under "Unreleased: breaking", below). App code and `everyapp.config.ts` don't change: an app's Connect button and `connectUrl()` now lead to the provider or to EveryApp's Allow page. `everyapp provider connections` lists one row per person per provider, with the apps allowed. `everyapp provider disconnect` removes the connection, and with `--app <id>` takes only that app's access away. The `provider.disconnected` event no longer carries `app`, and `connection.used` is sent once per app per day. Design: `docs/design/2026-11-oauth-one-connection.md`; how-to: [Connect an OAuth provider](https://everyapp.com/docs/connect-oauth).

What you do: `pnpm everyapp update` brings the Gateway to migration `0034` (`oauth_one_connection`). This everyapp refuses an older Gateway with `GATEWAY_OUTDATED` until you do. Each person keeps one connection per provider: an active one before an expired one, then the one with the most scopes, then the newest. The tokens of their other connections are dropped, not revoked at the provider. An app that was connected to the kept account stays allowed. It keeps working if the kept connection holds its scopes, and otherwise sends the person through the provider once. An app that was connected to a different account asks the person again. While the update swaps the code, connecting and calls to OAuth providers fail for a few seconds.

## Unreleased: breaking

An app's setup is grouped into **features** (`features` in `everyapp.config.ts`): each a name, a why, numbered steps with URLs, and the secrets, settings, capabilities and providers it needs. `everyapp configure <app>` walks them; `everyapp status` shows each app's features in one line.

- `optional`, `anyOf` and a secret's `setup` guide are gone. Everything at the top level is required. Move what the app works without into an optional feature (all or nothing; `required: true` for one it can't open without). A capability or provider an optional feature lists stays declared under `capabilities` or `providers`.
- A value says `how` (where it is, what permission it needs). A secret may say `generate: true` (made for you; the deploy sets a top-level one) or `file: true` (the prompt takes a `.pem`'s path).
- An app deployed with `optional` still in its stored manifest reads those values as required: update its `everyapp.config.ts` and deploy it again.

OAuth providers are simpler (docs/design/2026-11-oauth-simplify.md, docs/design/2026-11-oauth-one-connection.md):

- An app's `everyapp.config.ts` lists the provider's own scopes (`gmail.modify`, `Mail.Read`, `chat:write`). Scope sets are gone.
- A person connects a provider **once**, to EveryApp. A connection belongs to one person, and holds every scope the organization's apps list for that provider. The Gateway adds the scopes that name the account (Google's `openid email`, Microsoft's `User.Read offline_access`). Apps never list them.
- Each app asks the person for access, and they select Allow on an EveryApp page. An app they haven't allowed can't use the connection. Connecting from inside an app allows that app in the same step.
- Allowing an app is a yes or no, not a limit on scopes: an allowed app can use every scope the connection holds. The provider's consent screen lists every app's scopes. A person has one account per provider.
- The Gateway refuses a token that carries more scopes than the organization's apps list at connect, or more than the connection holds at a refresh.
- An app the person allowed may use the connection at any time, in the background too. There is no second "allow in the background" step.
- `integrationFetch()` sends the person's token to the provider's API hosts only. There are no route, method or read/write rules: what an allowed app may do is what the connection's scopes allow.
- Google, Microsoft and Slack are JSON specs like any other provider. Nothing in the code is specific to one provider.

### What you do

1. Update the Gateway from a checkout: `pnpm everyapp update`.
2. Every connection made before migration 0025 is dropped. People connect again, once per provider, and allow each app.
3. Edit each app's `everyapp.config.ts` (below) and deploy it.
4. If you added an OAuth provider from a preset before this release, its row no longer parses (it has `scopeSets`), and the Gateway stops serving it. Write the new spec over it, then set its client again when asked (the setting names don't change):

   ```bash
   pnpm everyapp provider add --oauth github-oauth --replace
   ```

   A provider you wrote your own spec for: drop `scopeSets`, `alwaysRequested`, `access`, `readMethods` and `writeMethods`, move `tolerated` into `auth`, rename `auth.scopeDialect` to `auth.scopeSeparator` (`space` or `comma`; a prefix goes in `auth.scopePrefix`), put the scopes the identity URL needs in `auth.identity.scopes`, and add it again with `--replace`.

5. Microsoft and Slack can hand back every scope a person ever approved on one client. One connect asks for every scope the organization's apps list, so apps share a client. A token that carries a scope no app lists is refused: limit the client's scopes at the provider's console.

### `everyapp.config.ts`, before and after

An OAuth entry is `{ scopes, why }`. `why` is required. `scopes` lists the provider's own scope strings, short (joined onto the provider's prefix, `https://www.googleapis.com/auth/` for Google) or in full; `[]` for a provider with no scopes, such as Notion. `access`, `background`, `optionalScopes` and `redirectPaths` are refused on an OAuth entry, each with a message saying what to write instead. API-key providers keep `{ access, why }`.

OpenMail:

```ts
// before
"google-workspace": {
  access: "write",
  scopes: ["identity", "gmail.read", "gmail.modify", "gmail.send"],
  background: { scopes: [/* … */], why: "…" },
  why: "Mirrors your Gmail, writes reply drafts as mail arrives, and sends when you press Send.",
},
// after
"google-workspace": {
  scopes: ["gmail.modify", "gmail.send"],
  why: "Mirrors your Gmail, writes reply drafts as mail arrives, and sends when you press Send.",
},
```

OpenSEO: `scopes: ["identity", "search-console.read", "analytics.read"]` becomes `scopes: ["webmasters.readonly", "analytics.readonly"]`, and `access` goes.

CRM: Google `["identity", "gmail.read", "calendar.read"]` becomes `["gmail.readonly", "calendar.readonly"]`; Microsoft 365 `["identity", "mail.read"]` becomes `["Mail.Read"]`. `access` goes from both.

### Old scope sets and the provider scopes they asked for

| Provider | Old set | Write instead |
| --- | --- | --- |
| Google | `identity` | nothing: the Gateway adds `openid email` |
| Google | `gmail.read` | `gmail.readonly` |
| Google | `gmail.modify` | `gmail.modify` |
| Google | `gmail.send` | `gmail.send` |
| Google | `calendar.read` | `calendar.readonly` |
| Google | `search-console.read` | `webmasters.readonly` |
| Google | `analytics.read` | `analytics.readonly` |
| Microsoft 365 | `identity` | nothing: the Gateway adds `User.Read offline_access` |
| Microsoft 365 | `mail.read` | `Mail.Read` |
| Microsoft 365 | `calendar.read` | `Calendars.Read` |
| Slack | `channels.read` | `channels:read`, `groups:read` |
| Slack | `users.read` | `users:read` |
| Slack | `users.email` | `users:read.email` |
| Slack | `messages.write` | `chat:write`, `chat:write.public`, `chat:write.customize` |
| Slack | `channels.join` | `channels:join` |
| Slack | `channels.manage` | `channels:manage`, `groups:write`, `channels:write.invites`, `groups:write.invites`, `im:write` |
| Slack | `files.write` | `files:write` |
| Slack | `user-channels.manage` | gone: Slack uses the bot token only |

Add each scope your apps list to the provider's client too (Google's consent screen, the Entra app registration, the Slack app).

### SDK (`@every-app/sdk/server`)

- `connectUrl({ env, provider, returnTo? })` always sends the app: `<gateway>/connect/<id>?app=<app id>&return=…`. It needs `EVERYAPP_APP_ID`, which the deploy and `everyapp dev` set. `account`, `sets` and `background` are gone.
- `integrationFetch()` drops `account`. For an OAuth provider it reaches the provider's API hosts only; any other host, the token endpoint included, throws a `TypeError`.
- `for: { background: true, userId }` names **any** member's connection to this app, at any time, even while serving another member's request. OpenSEO reads a project's Search Console with the connection of the member who picked the property, whoever is viewing. The call carries that member (`x-everyapp-user`), never the identity of the person being served. Only an organization's own app may name a member, and only one who may still open the app. A shared app or `everyapp dev --gateway` naming a member gets 403 `integration_user_not_allowed` (new code); a member who left, was deactivated or lost the app gets 409 `integration_not_connected`, and their connection in the app is deleted.
- `integrationStatus()` for an OAuth provider is `{ requested, configured, ready, scopes, connectPath, connection: { label, scopes, ready, missingScopes?, reconnect? } | null }` plus the setup fields. `clientId`, `scopeSets`, `userScopes`, `flow`, `connection.account`, `connection.scopeSets` and `connection.background` are gone.
- `authorizeUrl()` is removed, with the app-driven flow: `integrationFetch()` no longer completes a provider's token endpoint with the Gateway's client. Send people to `connectUrl()` and call the API with `integrationFetch()`.
- `ConnectionAccount` is no longer exported. `EveryAppCapabilityEntry` is now a union of `EveryAppKeyCapabilityEntry` (`{ access, … }`) and `EveryAppOAuthCapabilityEntry` (`{ scopes, why, … }`).
- `everyapp dev`: `<PREFIX>_ACCESS_TOKEN` in `.dev.vars` (`GOOGLE_WORKSPACE_ACCESS_TOKEN`) is a token you got yourself, used as the bearer. Dev checks hosts only. Without it a call answers the Gateway's 409 `integration_not_connected`, with `connectPath` `/connect/<id>?app=<app id>`.

### Removed

- CLI: `everyapp provider scope-set add` and `provider scope-set remove`; `provider disconnect --organization`. `provider connections` and `provider disconnect` take `--app <id>`.
- MCP tools: `everyapp_provider_scope_set_add`, `everyapp_provider_scope_set_remove`.
- Gateway: "Connect for the organization" (`account: "organization"`), the background consent page (`/connect/<id>/background`) and the 90-day idle lapse, the scope-set overlays (Manage workspace → Providers → Scope sets), `/connect/<id>` without `?app=`.
- Manifest keys on OAuth entries: `access`, `background`, `optionalScopes`, `redirectPaths`.
- Provider spec fields: `scopeSets`, `alwaysRequested`, top-level `tolerated` (it is `auth.tolerated`), OAuth `access`, `readMethods` and `writeMethods`; `auth.scopeDialect` is `auth.scopeSeparator` (`space` or `comma`) with `auth.scopePrefix`.
- Presets for social networks: `x-oauth`, `linkedin`, `facebook`, `instagram`, `threads`, `youtube`, `reddit`, `pinterest`, `discord`, `kick`, `twitch`, `tumblr`.
- Gateway error codes: `integration_scope_not_allowed`, `integration_scope_not_granted`, `integration_scopes_undeclared`, `integration_scope_exceeded`, `integration_scope_unverified`, `integration_grant_not_allowed`, `integration_response_invalid`. OAuth provider calls no longer answer `integration_method_not_allowed` or `integration_read_only` (API-key providers and Gateway services still do).
- CLI error codes: `SCOPE_SET_BUILTIN`, `SCOPE_SET_EXISTS`, `SCOPE_SET_IN_USE`, `SCOPE_SET_INVALID`, `SCOPE_SET_NOT_FOUND`, `SCOPE_SET_PROVIDER_UNKNOWN`.
- Events: `provider.background_granted`, `provider.background_revoked`, `provider.background_lapsed`. `provider.connected` now carries `app` and `scopes`; payloads no longer carry `scopeSets` or `account.kind: "organization"`. A connection's first held-token call each UTC day emits `connection.used`.
- The `x-everyapp-account` header.

### Dead surface removed (2026-11-02)

No app used any of these:

- SDK (`@every-app/sdk/server`): `fromMcpTools()`, `gatewayEmailBinding()` (call `sendEmail()`), `currentUser()` and `requireCurrentUser()` (use `getEveryAppUser(request, env)` / `requireEveryAppUser()`), `withOrganization()` (background work passes `for: { background: true }`), the `IdentityError`, `RequestContextError` and `OrganizationMismatchError` exports (their `code` stays on the error), and `everyApp(handler, manifest, options)`: pass `everyApp(handler, options)`.
- Manifest fields: `main`, `devPort`, `serverFnGuard`, `serverFnBase` and `mcp`. The strict schema refuses them. The server-function guard always covers `/_serverFn`. An app host serves no MCP: the Gateway's `/mcp` is the one connector, and Cloudflare Access bypasses no app host's `/mcp`.
- `deploy --json` and `status --json` drop `mcp`; `status` drops `MCP /mcp (…)` from the PUBLIC column.
