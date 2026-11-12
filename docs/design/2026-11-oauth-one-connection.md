# One connection per person per provider

Date: 2026-11-10. Status: **built in this change.** It replaces the per-app connection of `2026-11-oauth-simplify.md` (2026-11-02), and keeps the rest of that design: provider scopes named directly in `everyapp.config.ts`, no scope sets, no separate background consent, the mint check, nothing provider-specific in code.

## The rule

1. A person connects a provider once, to EveryApp and not to an app. The provider is asked for every scope that any app in their organization lists for it.
2. Each app then asks the person for access. The person allows it on an EveryApp page that names the app, the account and the scopes the app lists. There is no trip to the provider, because the connection already holds those scopes.
3. An app the person hasn't allowed can't use their connection, in the foreground or the background.
4. A connection is never used for another person.
5. An app deployed later may list a scope the connection doesn't hold. Allowing that app goes through the provider once, to add it.
6. The Gateway still refuses a token that carries more than was asked (the mint check).

Connecting from inside an app allows that app in the same step, so the first app costs one screen and not two.

## What a person sees

- They select Connect Google in OpenMail. Google lists the scopes of every app in the organization, such as mail for OpenMail and Search Console for OpenSEO.
- They open OpenSEO and select its Connect button. EveryApp asks whether OpenSEO may use their Google account, and shows the scopes OpenSEO lists. They select Allow and never leave EveryApp.
- An app they never allow never uses the connection.
- An app that requires a provider (one no optional feature of the app lists, as the settings model reads it: OpenSEO's Google and OpenCRM's Google and Microsoft 365 are optional) doesn't open for them until they have connected it and allowed the app. Opening it lands on the launcher's setup dialog, the same one that waits for an admin's settings, with one button per provider: **Connect**, **Allow** or **Reconnect**, each through the app's connect link and back to the app. The app's own Connect button keeps working.
- Connected accounts lists each connection once, with the apps allowed to use it. Disconnect stops every app at once. One app's access can be removed on its own.
- When an app they allowed needs more (the connection expired, lacks a scope the app lists now, or the app lists more than they allowed it), Connected accounts says **Needs reconnect** and shows **Reconnect**. One Reconnect covers every app they allowed: through the provider when the connection lacks something, otherwise on the spot.

## What we give up

- **Allowing an app is a yes or no, not a limit on scopes.** The one token holds every scope, and the Gateway can't narrow a token. An app the person allowed for Search Console could also call Gmail. The Allow page shows only the scopes the app lists; Your connections → Accounts lists every scope the connection holds. The model before 2026-11-02 guarded this with scope sets and per-URL allowlists; they are not coming back.
- **The provider's screen asks for more.** Someone connecting for one app approves the scopes of every app in the organization, including apps they may never open.
- **One account per provider per person.** Someone can't use a work Google account in one app and a personal one in another. Connecting a different account replaces the connection, and the other apps ask for access again, because the person allowed them a different account.

Two edges:

- A person can untick a scope on the provider's screen where the provider lets them. The connection keeps what was granted. An app that needs the missing scope shows Reconnect, and so does Connected accounts; either sends them through the provider again.
- A provider that doesn't name the account (its spec has no identity URL) can't show that an account changed, so its apps stay allowed across a reconnect. Where the provider does name accounts and the name can't be read this time, the other apps ask again.

## How it is stored

- `provider_connections`: one row per (organization, provider, person). The tokens, sealed, and the scopes the token holds. No app.
- `provider_app_access` (new): one row per (organization, provider, person, app), with the scopes the app listed when the person allowed it. An app that lists more than it did then asks again.
- `oauth_states.purpose`: `authorize` for a state the provider's callback spends, `allow` for one the Allow page's form spends. Neither route takes the other's.

## The flow

`GET /connect/<provider>?app=<app>&return=…` picks one of three:

| The person's connection | What happens |
| --- | --- |
| Holds what the app lists, and they allowed the app for all of it | Back to `return`. Nothing to do. |
| Holds what the app lists, and they haven't allowed the app (or it lists more now) | The Allow page, `/oauth/app-access?state=…`. |
| Missing, expired, or lacks a scope the app lists | The provider, asked for every scope the organization's apps list. The callback stores the connection and allows the app the connect started in. |

The Allow page posts `state` and `decision` to `POST /connect/<provider>/allow`. That handler spends the state and checks again what the page showed: the app still lists the provider, the person still opens it, the connection still holds what the app lists, and the app lists no more than it did when the page was made. The control plane's CSRF guard covers the POST like any other cookie request.

A successful connect spends the person's open Allow pages for that provider. A page left open in another tab showed the account as it was, and must not allow an app the account that replaced it.

### Reconnect

Connected accounts marks a connection **Needs reconnect** when an app the person allowed lists a scope the connection lacks or the person didn't allow it, or the connection expired. Reconnect is a server function (`reconnectConnection`, a POST under the control plane's CSRF guard) for the person's own connection only:

| The connection | What happens |
| --- | --- |
| Expired, or lacks a scope one of their allowed apps lists | The provider, asked for every scope the organization's apps list, with a `reconnect` state in the name of the app that needs it. The callback stores the connection, allows that app, and, when it is the same account, allows every app they had allowed for what it lists now, where the token holds it. Back to Connected accounts. |
| Holds what every one of their allowed apps lists | No provider. Each app that lists more than they allowed it is allowed for what it lists now. Selecting Reconnect is their OK: an allowed app can already use every scope the connection holds (`docs/security.md`, known gap 11), so a page per app would limit nothing. |

Reconnect never allows an app the person hadn't allowed. Another account at the provider takes the other apps' access, as any connect does. A connection that was never named (its account lookup failed: GitHub's did until the Gateway sent a `User-Agent`, so every GitHub connection made before then is unnamed) takes the name read on its next connect, and its apps stay allowed.

### Opening an app

The perimeter asks twice before an app's private page opens. `needsSetup`, before sign-in, is the organization's: the settings the manifest requires, an OAuth provider's client among them. `needsConnection`, after sign-in, is the person's (server/oauth/connection-needs.ts): each OAuth provider the app requires (not one an optional feature lists), connected, holding the scopes the app lists, and allowed for this app, the same rule a call is held to. A page navigation that fails either goes to `/?setup=<app>`; the launcher's list carries the person's needs (`connections`), and the dialog shows the settings first, since an account can't be connected before the client is set, then one button per provider. Other requests pass the connection gate: the app's calls are refused with `integration_not_connected` anyway.

### Whether a provider is set up

One rule decides whether the Gateway holds an OAuth provider's client, the SDK's `oauthClientSource`: the Worker's settings (set from the terminal) while the registry may read them, else the client pasted under Manage workspace → Providers while it was pasted for the provider as it is now and has its secret. The Gateway's client lookup, the setup gate and the app lists use it, and so do the CLI's `status`, `deploy` and `configure`, which read the pasted client's binding from D1 (never its secret).

## A call

`handleHeldTokenCall` finds the connection by person and provider, then requires the person's access row for the calling app. No row answers `409 integration_not_connected` with the same `connectPath`, so an app's Connect button needs no change: it now leads to the Allow page. The status route reports `connection: null` for an app the person hasn't allowed.

## Lifecycle

| Event | What goes |
| --- | --- |
| The person disconnects, leaves the organization or is deactivated | The connection and every app's access to it |
| The provider is removed | Every connection to it and every app's access |
| The person loses an app, or takes its access away | That app's access. The connection stays |
| An app is deleted | Its access rows. The connections stay |
| The person connects another account | The other apps' access. Each asks again. The app the connect started in is allowed |
| The person selects Reconnect | Nothing goes. Each app they allowed is allowed for what it lists now, where the connection holds it |

## Migration `0034`

Each person keeps one connection per provider: an active one before an expired one, then the one holding the most scopes, then the newest. The other apps' tokens are dropped, not revoked at the provider. Every app whose connection was to that same account becomes an access row, so it keeps working if the kept connection holds its scopes, and otherwise sends the person through the provider once. An app that was connected to a different account gets no row and asks the person again.

`provider_connections.app_row_id` stays, as the app the connection was last made from: the CLI before this release reads it in `provider connections`. Nothing in the Gateway reads it; a later release drops it. While `everyapp update` swaps the code, the old Gateway's OAuth paths fail for those seconds, as they did for `0025`.

## Remote MCP apps

An MCP app's own provider (`<app>-mcp`) is used by that app alone, so nothing changes in effect: connecting from the app stores the person's connection and allows the app. The mint check's carve-out for that row stays. Removing the MCP app removes the members' connections to that row with it, since nothing else could use them.

## Not built

- No event is recorded when a person allows an app or takes one app's access away. Both are logged. `provider.connected` and `provider.disconnected` cover the connection itself.
- Nothing narrows a token to an app's own scopes. Some providers can issue a narrower token on refresh; that was not tried.
