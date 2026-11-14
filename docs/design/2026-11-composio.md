# Composio: an account from a person's Composio is a connection

Date: 2026-11-13. Status: **built in this change.** It replaces the design of #1015 and #1016, which are closed. Their branches (`composio-api-link`, `composio-provider-add`) stay, for the code this reused. It builds on [2026-11-oauth-one-connection.md](2026-11-oauth-one-connection.md), which is on `main`, and changes none of its rules.

What was checked: the Gateway's behaviour is tested against a test double (`apps/every-app-gateway/src/test/fake-composio.ts`). Its answers have the shapes #1015's spike measured on the real service. A session's `connected_accounts` wasn't measured then, so for that the double follows Composio's API reference. Nobody ran this build against the real Composio, and the four checks under [Not checked against the real Composio](#not-checked-against-the-real-composio) are open.

Composio is a third-party service where a person connects their accounts (Gmail, Slack, GitHub). It never hands a token out. It sends a request to a connected account's API and adds the token. A Gateway that uses it needs no OAuth app of its own for the providers Composio serves.

## What changed from #1015

#1015 kept what a person used through Composio apart from their connections. Here it is a connection like any other, and the rest follows from that.

| | #1015 | Built here |
| --- | --- | --- |
| What is stored | Access rows with no connection beside them, and the services found, cached on the link | A `provider_connections` row marked `via: composio` |
| Where a person sees it | Its own Composio section under Connected accounts | A row in Connected accounts, and in Organization connections for admins |
| Which account a call uses | The first one Composio lists for the service, listed again every 5 minutes to notice another | The one named on the page the person said yes to, by Composio's id for it. If it is gone, the row reads Needs reconnect |
| Who decides Composio is used | Nobody. A provider with no client is served through whoever linked | An owner or admin turns it on for the organization |
| `provider connections`, `provider disconnect`, events | Don't see it | See it, because it is a row |

## The rule

1. Composio is off until an owner or admin turns it on for the organization.
2. A person links their own Composio once. The Gateway keeps their key sealed, like a token.
3. Linking adds no connection, and there is no list to pick from. An account in their Composio becomes their connection to a provider when an app asks for it and they say yes.
4. From there the one-connection rules hold as they are: one connection per person per provider, each app asks, an app the person hasn't allowed can't use it, and a connection is never used for another person.
5. A provider is served one way. While the Gateway holds an OAuth client for it, people connect through the client and Composio isn't offered for it.
6. Only the providers below are served. A service in a person's Composio that maps to none of them is never listed, stored or used.
7. The Gateway never changes a person's accounts at Composio. It doesn't connect, remove or rename one.
8. The key never reaches an app, a tool's answer, an event, a log or the browser.

| Provider | Services in Composio |
| --- | --- |
| `github-oauth`, `slack`, `notion-oauth`, `linear-oauth`, `gitlab-oauth`, `hubspot-oauth`, `zoom`, `dropbox` | One each |
| `google-workspace` | Gmail, Calendar, Drive, Sheets, Docs, Search Console, Analytics |
| `microsoft-365` | Outlook, OneDrive, Teams, SharePoint |
| `atlassian` | Jira, Confluence |

`spotify`, a spec of your own, a remote MCP app's own provider and API-key providers are not served.

## What a person sees

- **An owner or admin turns Composio on**, once. The providers Composio serves that read Needs setup because they have no OAuth app now read Ready.
- **A person links their Composio once.** On Your connections → Accounts they select **Link Composio**, sign in at Composio and approve. Or they do it the first time an app needs it, on the page below. Linking adds nothing to Connected accounts.
- **Each app asks.** Opening an app that needs Google shows the setup dialog with **Connect**, as before, and the app's own Connect button leads to the same place: one Gateway page, `Allow OpenMail to use your Google account from Composio?`, with Gmail and the account's name. Allow makes the connection, which is then a row in Connected accounts, and allows the app. If Gmail isn't connected in their Composio, the page says so, links its page there, and has **Check again**.
- **A second app** asks on the Allow page that was there before, when the connection has the services it lists. When it needs another service of the same provider (OpenMail has Gmail, OpenSEO asks for Search Console), it asks on the Composio page, and the connection then holds both. The first app keeps its access.
- **The rest is what they know.** Disconnect stops every app at once. One app's access can be removed. A row that needs something reads Needs reconnect.

## Turning it on

The switch is the organization's, stored as `org_settings.composio`, the way linked dev is. Off without a row.

- **Manage workspace → Providers** has a Composio section above the Providers table, Off or On, with **Turn on** or **Turn off** and a link to the page for people (`landing-page/content/docs/composio.mdx`). Composio is not a provider, so it is no row of the table.
- **Nothing else offers it.** The dialogs that ask for an OAuth app (Set up on a provider's row, Add OAuth provider, the launcher's setup dialog) don't mention Composio. Someone who has not linked Composio meets it only in its own section and on Your connections.
- **Link Composio** shows for an owner or admin while Composio is off. Its first step turns it on. Starting a link is refused while it is off (`COMPOSIO_OFF`), so the surface turns it on first, after saying the sentence below, and then starts the link.
- `everyapp workspace composio on`, `off` and `show`, and `everyapp_workspace_composio`, as linked dev has. `everyapp_workspace_show` answers `composio: "on" | "off"`.
- `everyapp provider add <preset>` never turns Composio on. While it is on, for a provider above, at a terminal, in a run given no client, a person who linked their own Composio is told the provider is ready through Composio and asked `Add your own OAuth app instead? (y/N)`. They are the verified Gateway user with the Cloudflare login's email, read from D1 with the switch. Nobody else is asked: not `--json` runs, CI, a run given a client, or someone who has not linked.

Each way of turning it on says the same sentence before Yes: requests to the accounts people use from Composio pass through Composio (`COMPOSIO_NOTICE` in the SDK).

**What On changes.** An OAuth provider an app requires counts as set up when the Gateway holds a client for it, or when Composio is on, serves it, and has a service for every scope the app lists. It is one rule in the SDK, `oauthProviderSetUp` in `internal/composio.ts`, beside `oauthClientSource`, so the Gateway's setup gate, the app lists and the CLI's `status`, `deploy` and `configure` agree. The CLI reads the switch from D1, as it reads a pasted client's binding. The setup gate holds the switch for up to 30 seconds per isolate, as it holds whether a client is live. The isolate that changed it reads it at once.

**Turning it off** deletes every link in the organization and every connection made through Composio, with its access rows, after a confirm (the Gateway's counts them; the CLI's asks, then says how many were removed). Over `/mcp`, `everyapp_workspace_composio { on: false }` needs `confirm: true` while a link or a connection through Composio exists. Without it the refusal says how many there are.

## Linking

As #1015 built it. Nobody types or pastes a key: linking uses the sign-in Composio's own CLI uses, which hands out a key for Composio's HTTP API. Composio's MCP server was the other option and isn't used.

1. The person starts it: **Link Composio** on Your connections → Accounts, **Sign in to Composio** on the page an app's Connect leads to, `everyapp provider link composio`, or `everyapp_provider_composio_link`. The Gateway creates a sign-in at Composio and stores its id sealed, with when it expires (about 10 minutes). Starting again replaces a sign-in that is waiting.
2. The person opens the sign-in page at Composio and approves it.
3. The Gateway asks Composio every 2 seconds while the dialog or the command waits. The first read after the approval hands out the key, once. The Gateway reads the person's Composio organization and project, and stores the link.

Starting is refused while Composio is off (`COMPOSIO_OFF`) and for someone already linked (`COMPOSIO_ALREADY_LINKED`). When Composio can't be reached, starting and checking answer `COMPOSIO_UNAVAILABLE`. Composio hands the key out once, so a failure after the approval loses it: the sign-in is dropped, the answer is `COMPOSIO_LINK_FAILED`, and the person starts again.

Once linked, Accounts shows the Composio account's name with **Unlink**. `everyapp provider link composio` ends by listing what was found there, and adds nothing. Run again by someone already linked, it skips the sign-in and lists. `everyapp provider unlink composio` removes the key and the connections made through it.

What is in a person's Composio is read from Composio each time it is shown. Nothing of it is cached, so the read is a POST and a tool call (`everyapp_provider_composio`), never a GET server function.

## How it is stored

- `org_settings.composio`: the switch.
- `composio_links`: one row per (organization, person). The key, sealed (`key_enc`). The Composio account's email or name (`account_label`), the ids of its organization, project and user there, and the session a call uses (`session_id`) with the accounts it was opened for (`session_accounts`).
- `composio_link_requests`: one row per (organization, person) while a sign-in waits. The sign-in's id, sealed (`sign_in_enc`), and when it expires.
- `provider_connections.via`: `oauth`, the default and so every row there was before, or `composio`.
- `provider_connections.composio_accounts`: on a `composio` row, each service with Composio's id for the account and the account's name, as JSON (`[{ service, id, account }]`). Null otherwise.
- A `composio` row's other columns: `label` is the account names. `external_id` is the services and ids as one string. `scopes` is empty. There is no refresh token and no expiry. `access_token_enc` is `NOT NULL` and a migration only adds, so the row holds a sealed empty string, which nothing reads.
- `oauth_states.purpose`: `composio`, for the state the Composio page's form spends.
- `provider_app_access`: unchanged.

Migration `0037` (`0037_composio.sql`) adds two tables and three columns. A Gateway taken back to the release before it reads a `composio` row as a connection with no usable token. Where the provider has no client, its calls answer `integration_not_configured`. Where it has one, the provider refuses the empty token and the row turns expired.

## What a connection holds

A connection through Composio holds services, not scopes. Composio's account list doesn't say which scopes an account has.

- The SDK's Composio map (`packages/sdk/src/internal/composio.ts`) names, for each service, the provider scopes it covers (`gmail.*` is Gmail, `calendar` and `calendar.*` are Calendar, `webmasters` and `webmasters.*` are Search Console, `Mail.*` is Outlook) and the URLs it owns.
- An app needs the services its listed scopes map to (`composioServicesNeeded`). A sign-in scope (the provider's identity and tolerated scopes: `openid`, `email`, `profile`, `offline_access`, `User.Read`) needs none. A provider that is one service always needs it.
- The connection holds what an app lists when it has an account for each of those services. One helper answers this for both kinds of connection: `connectionLacks` in `server/oauth/holding.ts`. It took the place of the `missingScopes(flow, connection.scopes, declared)` that `connectionAction`, the call, the status route, the Allow form and Reconnect each ran.
- A scope that maps to no service can't be served. So is an app that lists only sign-in scopes for Google, Microsoft 365 or Atlassian, since nothing says which service it means. For that app the provider isn't set up through Composio and needs an OAuth app.
- What the account's token allows is Composio's to say. A call it doesn't cover comes back as the provider's own refusal.

On Accounts, the row's Access shows the services. The Allow page names them and says the app can do whatever those accounts allow in Composio.

A connection made the other way than the provider is served now needs a reconnect: one through Composio after an admin added a client, or one made with a client that was removed while Composio is on. `connectionAction` answers Reconnect for it, so the connect link, the setup dialog's button and Needs reconnect all follow.

## Connecting from an app

`GET /connect/<provider>?app=<app>&return=…` works out how the provider is served (`providerServing` in `server/composio/link.ts`) and then what the person has to do (`connectionAction`).

| What to do | The provider has a client | No client, Composio on and serving it |
| --- | --- | --- |
| Nothing | Back to `return` | The same |
| Allow | The Allow page | The same page |
| Connect or Reconnect | The provider's consent | The Composio page |

With no client, and Composio off or not serving what the app lists, the page says an owner or admin sets it up, as before.

The Composio page, `/oauth/composio?state=…`:

| The person | The page |
| --- | --- |
| Hasn't linked | One sentence about Composio, and **Sign in to Composio**. It waits as the dialog does, then shows one of the next two |
| Linked, and a service the app needs isn't connected there | Names the service, links its page at Composio, and has **Check again** |
| Linked, and every service the app needs is there | `Allow <app> to use your <provider> account from Composio?`, each service with its account's name (a choice where there are several), **Don't allow** and **Allow** |

The page reads the person's accounts from Composio each time it opens. Nothing is cached. When Composio doesn't answer, the page says so and nothing is shown to allow.

Allow posts to `POST /connect/<provider>/composio` (`serveComposio` in `server/oauth/flow.ts`). The handler spends the state, lists the person's accounts at Composio again, and checks what the page showed: the app still lists the provider and the person still opens it, the provider still has no client and Composio still serves what the app lists, and each account chosen is still there, for the service it was chosen for. Then it writes the connection, allows the app, and spends the person's open Allow and Composio pages for the provider, as any connect does.

What the connection holds afterwards, and who keeps access:

- The services this app needs, with the accounts chosen on the page.
- The services the connection already had that this app doesn't need, where their accounts are still in the person's Composio. So a second app that needs another service keeps the first app's access, and the row holds both.
- Another account for a service the row already had is another account. It takes the other apps' access, as any connect does. So does a first connection through Composio in place of one made with a client. So does an account that leaves the row because it is gone from the person's Composio: were its apps to stay allowed, the account chosen for that service later would be theirs to use unasked.

**Reconnect** on Accounts (`reconnectConnection`, which runs `startReconnect`), for a connection through Composio: when the accounts on the row are still in the person's Composio and cover what their allowed apps list, the row turns active and each app is allowed for what it lists now, on the spot. Otherwise it answers the Composio page's address, in the name of the app that needs it.

## A call

`integrationFetch()`, `connectUrl()` and `everyapp.config.ts` don't change. `handleHeldTokenCall` keeps its order:

1. The app's manifest lists the provider.
2. The provider is set up: a live client, or Composio on for the organization and serving what the app lists. Otherwise `503 integration_not_configured`, as before.
3. Whose connection: unchanged.
4. The connection exists, the person allowed this app, it isn't expired, and it was made the way the provider is served now. Otherwise `409 integration_not_connected` with the same `connectPath`.
5. It holds what the app lists, and the person allowed the app for every scope it lists.
6. The host is one of the provider's.
7. By `via`. `oauth`: the token, as before. `composio`: `sendThroughComposio` in `capabilities/composioCall.ts`, which is #1015's send without its own checks (they are steps 1 to 6 now). The service that owns the URL, its account on the row, one request to Composio, and the provider's answer rebuilt.

Then `last_used_at`, `connection.used`, and the log line `integration.proxy.call` with `via: "composio"` and the service, as for any connection.

A call goes through a session at Composio that is opened for exactly the accounts on the person's active connections (`connected_accounts`). The session is kept on their link with the accounts it was opened for. A call whose connections name other accounts by now opens another, so nothing has to clear it.

Composio's failures:

| Composio says | The Gateway |
| --- | --- |
| The key is refused | Deletes the link, turns the person's connections through it expired, answers the 409 |
| The account is gone | Turns this connection expired, answers the 409 |
| No service owns the URL, or Composio won't send to the host | `400 invalid_integration_route` |
| Anything else | `502 integration_upstream_failed` |

Composio's error text never reaches the app.

## Lifecycle

| Event | What goes |
| --- | --- |
| The person disconnects a connection made through Composio | The row and every app's access, as any disconnect. Nothing is revoked at the provider and nothing is called at Composio. Their link stays |
| The person unlinks Composio | The key, a waiting sign-in, and every connection of theirs made through it, with its access |
| Composio refuses the key | The key. Their connections through it turn expired and keep their access rows. Linking again and Reconnect brings them back, and with the same accounts no app asks again |
| An account is removed in Composio | Noticed by the next call, which turns that connection expired, or by the next Reconnect, which leads to the Composio page |
| An owner or admin turns Composio off | Every link in the organization, and every connection made through it, with its access |
| An admin adds a client for a provider | Nothing is deleted. Connections to it through Composio read Needs reconnect, and Reconnect goes through the client. To the Gateway that is another account, so the other apps ask again |
| An admin removes a provider's client, with Composio on | Nothing is deleted. Connections made with the client read Needs reconnect, and Reconnect goes through Composio. That is another account too, and the token the row held is dropped, not revoked at the provider |
| The person leaves the organization or is deactivated | Their link, with their connections and access |
| The provider is removed, an app is deleted, or the person loses an app | As before |

No event type is new. `provider.connected` and `provider.disconnected` cover a connection through Composio, with `via`.

## UI, CLI and tools

| Action | UI | CLI | Tool |
| --- | --- | --- | --- |
| Turn Composio on or off (owners and admins) | Providers → Composio | `workspace composio on\|off\|show` | `everyapp_workspace_composio` |
| Link my Composio | Accounts → Link Composio | `provider link composio` | `everyapp_provider_composio_link`, `…_link_finish` |
| See whether my Composio is linked, and what is in it | Accounts | `provider link composio` | `everyapp_provider_composio` |
| Unlink my Composio | Accounts → Unlink | `provider unlink composio` | `everyapp_provider_composio_unlink` |
| List connections, disconnect, remove one app's access | As before | As before | As before |

Using an account in an app happens on the Gateway's page in a browser, as connecting any account does. The last row needed nothing new: `provider connections` and `everyapp_provider_connections` gained `via` on each row, and `services` on a row made through Composio. A disconnect of a connection through Composio revokes nothing at the provider. The matrix rows are in [2026-10-agent-parity.md](2026-10-agent-parity.md).

## Limits

Measured against the real service in #1015:

- A call through Composio takes about half a second longer than a direct one.
- Only a JSON request body can be sent. No form, no file upload.
- A JSON answer is parsed and written again, so a number past 2^53 loses precision.
- A binary answer comes back whole only when the provider labels it as binary.
- Each Google, Microsoft and Atlassian service is its own account in Composio. Connecting Gmail there doesn't give Calendar.
- Some URLs have no service and are refused: Google's account-name endpoints, Atlassian paths outside `/ex/jira/` and `/ex/confluence/` (`/me` among them), and Microsoft Graph paths outside mail, calendar, contacts, files, Teams and SharePoint.

New here:

- The Gateway can't see or ask for scopes on an account in Composio.
- A person connects a missing service in Composio, not from EveryApp.
- A call is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. A request body is at most 10 MiB, and an answer at most 25 MiB: a larger one is `502 integration_upstream_failed`.

## Security

`pnpm security-review` runs before the pull request: this holds a key and changes how a call is authorized. `docs/security.md` gained:

- Composio among who is trusted: when an organization turns it on, Composio sees the requests and answers of the accounts people use from it.
- Known gap 12: the key can do more in the person's Composio than the Gateway uses, and it stays valid there after unlinking until they revoke it.
- In the same gap: a person who approves a sign-in page someone else sent them links their Composio to that person's EveryApp account. The sign-in's id is sealed until it is used and deleted afterwards, and the page's address goes only to the person who started it.

## Not checked against the real Composio

With one script against the real Composio and a person's own key, as #1015's spike did. It changes nothing on a Cloudflare account. These are in `TODO.md`, and are Ben's to ask for.

1. A session opened with `connected_accounts` sends through those accounts only, and a removed account is refused, never replaced by another. Composio's API reference documents the field. If `POST /tools/execute/proxy` with `connected_account_id` takes a person's key, use that and keep no session.
2. Whether unlinking can revoke the key at Composio.
3. Whether `binary_body` sends a file, which would lift the JSON-only limit.
4. One call that writes. #1015 tested reads only.

Still open from #1015: Composio hasn't been asked about a product using its CLI's sign-in. That step is in `TODO.md` too.

## What was built

One change, where the proposal had three:

- **The switch and the link.** Migration `0037` (all of it), the SDK's Composio map, the Composio client and the sign-in from `composio-api-link`, the fake Composio for tests, the section on Providers, `workspace composio`, `provider link composio` and `unlink`, and their tools.
- **Connections.** The Composio page, what a connection holds, the call, Reconnect, the setup rule, the lifecycle, `via` in the lists, `docs/security.md`.
- **The ways in.** The Composio section on Providers, Link Composio on Your connections, `provider add <preset>` for someone who linked, a `setup/composio.md` page for agents and one for people, the parity rows.

## Decided

1. **The switch exists.** An owner or admin turns Composio on. Without one, as in #1015, every app that lists Google on every Gateway would stop reading Needs setup and send people to Composio, whether the organization chose it or not. The cost of the switch is one step, which an owner's first Link Composio takes for them.
2. **A client added later makes connections through Composio reconnect through the client.** The provider is served one way, and Composio stops seeing its calls. The other choice let them work until the person reconnects, which breaks nobody on the day and leaves two ways in use.
3. Decided on 2026-11-13: a person links once and picks nothing. Each app asks, on the page its Connect button or the setup dialog leads to, and that yes is what makes the connection.

## Not chosen

- **A list of accounts to tick after linking.** A person would approve accounts before any app asked for one. Each app asking is the approval.
- **One Composio key for the organization.** An admin sets a single Composio API key, and each member connects from inside an app on a page Composio hosts. It keeps the contract as it was, uses only Composio's documented API and holds no key per person. It doesn't use the accounts a person already has in their own Composio, which is the point here, and every member's accounts would live in the organization's Composio.
- **Connecting a missing service from EveryApp**, **two accounts of one service in different apps**, and **remote MCP apps through Composio**.
