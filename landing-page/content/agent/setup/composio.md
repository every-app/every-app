---
title: "Composio: people's accounts with no OAuth app"
description: "Step-by-step guide: an owner or admin turns Composio on, each person links their own Composio, and each app asks before it uses an account. Which providers it serves, what only a person can do, the limits, and how to turn it off."
---

Composio is a third-party service where a person connects their accounts
(Gmail, Slack, GitHub). It never hands a token out: it sends a request to a
connected account's API and adds the token. With Composio on, an OAuth
provider this Gateway holds no client for is used through the accounts in
each person's own Composio, so nobody registers an OAuth app at Google,
Microsoft or Slack. The price is that every request to those accounts, and
every answer, passes through Composio. App code is the same either way:
`integrationFetch()`, `connectUrl()` and `everyapp.config.ts` don't change.
At the end Composio is on for the organization, each person who uses such
an app has linked their own Composio, and each app they opened has asked
them and been allowed. The person's version of this page is
https://everyapp.com/docs/composio. The design is
`docs/design/2026-11-composio.md` in a checkout.

## When to suggest it

- The person doesn't want to register an OAuth app (a Google consent
  screen, an Entra registration, a Slack app), or can't.
- The people who will use the app already have the accounts in Composio,
  or are willing to connect them there.

Don't suggest it when the organization's data may not pass through a third
party, when an app sends a form or a file to the provider, or when the
provider isn't in the table below. Then the provider needs an OAuth app:
[google.md](/docs/agent/setup/google),
[microsoft-365.md](/docs/agent/setup/microsoft-365),
[slack.md](/docs/agent/setup/slack), or `everyapp provider add <id>` for
the others ([guides.md](/docs/agent/setup/guides)).

Before anyone says yes to turning it on, say this sentence to them:
requests to the accounts people use from Composio pass through Composio.

## Settings

None on the Gateway Worker: no key, no client, nothing for `secret set`.
The Gateway's database holds the organization's switch (off until an owner
or admin turns it on) and, for each person who linked, their Composio key,
sealed. The key is never shown, and no command or tool answers it.

Only these providers are served. The slug is Composio's name for the
service: its page in a person's Composio is
`https://dashboard.composio.dev/~/~/connect/apps/<slug>`.

| Provider id        | Services in Composio (slug)                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-oauth`     | GitHub (`github`)                                                                                                                                                                            |
| `slack`            | Slack (`slack`)                                                                                                                                                                              |
| `notion-oauth`     | Notion (`notion`)                                                                                                                                                                            |
| `linear-oauth`     | Linear (`linear`)                                                                                                                                                                            |
| `gitlab-oauth`     | GitLab (`gitlab`)                                                                                                                                                                            |
| `hubspot-oauth`    | HubSpot (`hubspot`)                                                                                                                                                                          |
| `zoom`             | Zoom (`zoom`)                                                                                                                                                                                |
| `dropbox`          | Dropbox (`dropbox`)                                                                                                                                                                          |
| `google-workspace` | Gmail (`gmail`), Calendar (`googlecalendar`), Drive (`googledrive`), Sheets (`googlesheets`), Docs (`googledocs`), Search Console (`google_search_console`), Analytics (`google_analytics`) |
| `microsoft-365`    | Outlook (`outlook`), OneDrive (`one_drive`), Teams (`microsoft_teams`), SharePoint (`share_point`)                                                                                           |
| `atlassian`        | Jira (`jira`), Confluence (`confluence`)                                                                                                                                                     |

`spotify`, a provider from a spec of your own, a remote MCP app's own
provider (`<id>-mcp`) and API-key providers are not served.

Each Google, Microsoft and Atlassian service is its own account in
Composio: connecting Gmail there doesn't give Calendar. An app needs the
services its scopes belong to:

| Provider           | A scope the app lists                                                                                                                                          | Service        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `google-workspace` | `gmail.*`, `https://mail.google.com/`                                                                                                                          | Gmail          |
| `google-workspace` | `calendar`, `calendar.*`                                                                                                                                       | Calendar       |
| `google-workspace` | `drive`, `drive.*`                                                                                                                                             | Drive          |
| `google-workspace` | `spreadsheets`, `spreadsheets.*`                                                                                                                               | Sheets         |
| `google-workspace` | `documents`, `documents.*`                                                                                                                                     | Docs           |
| `google-workspace` | `webmasters`, `webmasters.*`                                                                                                                                   | Search Console |
| `google-workspace` | `analytics`, `analytics.*`                                                                                                                                     | Analytics      |
| `microsoft-365`    | `Mail.*`, `MailboxSettings.*`, `Calendars.*`, `Contacts.*`                                                                                                     | Outlook        |
| `microsoft-365`    | `Files.*`                                                                                                                                                      | OneDrive       |
| `microsoft-365`    | `Team.*`, `TeamMember.*`, `TeamSettings.*`, `Channel.*`, `ChannelMessage.*`, `ChannelMember.*`, `ChannelSettings.*`, `Chat.*`, `ChatMessage.*`, `ChatMember.*` | Teams          |
| `microsoft-365`    | `Sites.*`                                                                                                                                                      | SharePoint     |
| `atlassian`        | any scope with `jira` in it                                                                                                                                    | Jira           |
| `atlassian`        | any scope with `confluence` in it                                                                                                                              | Confluence     |

The rules:

- **Off until turned on.** With the switch off nothing here applies, and a
  provider with no client reads Needs setup as before.
- **A provider is served one way.** While the Gateway holds an OAuth client
  for a provider, people connect through the client and Composio isn't
  used for it.
- **A provider is set up for an app** when the Gateway holds a client for
  it, or when Composio is on, serves it, and has a service for every scope
  the app lists. One scope no service covers (`tasks` on Google) means
  that app needs an OAuth app for the provider. So does an app that lists
  only sign-in scopes for Google, Microsoft 365 or Atlassian.
- **The Gateway never changes an account at Composio.** It doesn't connect,
  remove or rename one. A person connects a missing service in their own
  Composio.

## Costs and plans

Each person needs their own Composio account. Composio's plans and limits
are Composio's own and were not checked for this guide. A call through
Composio takes about half a second longer than a direct one.

## Only a person can

- Decide that requests may pass through Composio, and say yes to turning
  it on. That is an owner's or admin's decision.
- Sign in to Composio and approve the sign-in page that links it. Nobody
  types or pastes a key.
- Connect a service in their own Composio.
- Select **Allow** on the Gateway's page, once in each app that uses an
  account.

The sign-in page goes to the person the command or tool acts as, and to
nobody else. Whoever approves it links their Composio to that person's
EveryApp account.

## Before you start

1. `everyapp status --json`: `data.installed` and `data.claimed` are true.
   `GATEWAY_OUTDATED` with `severity: "error"` means the Gateway is behind
   this everyapp: `everyapp update` first.
2. `everyapp workspace composio show`: whether Composio is on. This and
   the other commands below run as the person signed in to the Gateway
   (`everyapp login --gateway <url>`, or `EVERYAPP_TOKEN`), like every
   `workspace` command ([workspace](/docs/agent/workspace)). Turning it on
   or off needs an owner or admin.
3. Read the `everyapp.config.ts` of each app that should use it: the
   provider's id is in the first table, and every scope the app lists for
   it is in the second (or the provider is one service).
4. `everyapp provider list`: a provider that already has a client is
   served with the client. Composio changes nothing for it. One with no
   client reads `through Composio` once Composio is on and serves it.

## Steps

1. **Person (an owner or admin):** says yes to the sentence under "When to
   suggest it". Then **you**, signed in as them, or they:

   ```sh
   everyapp workspace composio on
   ```

   In the Gateway it is **Manage workspace → Providers**, the Composio
   section at the top, **Turn on**. The providers Composio serves that
   read Needs setup because they have no OAuth app are now set up for the
   apps whose scopes Composio covers. Nothing else turns it on:
   `everyapp provider add` never does.

2. **Each person who uses such an app:** links their own Composio, once.
   In their terminal:

   ```sh
   everyapp provider link composio
   ```

   It prints a sign-in page at Composio, opens it in their browser at a
   terminal, and waits. They sign in and approve. The command then lists what is in
   their Composio that EveryApp supports. Under `--json` the page is an
   `action_required` event, `composio_sign_in`, with `data.url` and
   `waiting: true`: show the URL to that person and keep reading, and the
   run ends with `done` once they approve. In the Gateway it is **Your
   connections → Accounts → Link Composio**. Skipping this step is fine:
   the first app that needs an account asks for it on its page (step 4).
   Linking adds no connection.

3. **The person, when a service is missing:** connects it in their own
   Composio, at `https://dashboard.composio.dev/~/~/connect/apps/<slug>`.
   Run `everyapp provider link composio` again to list what is there now:
   for someone already linked it skips the sign-in.

4. **The person:** opens the app and selects **Connect** (the setup dialog
   shows it when the app requires the provider, and the app's own Connect
   button leads to the same place). The Gateway's page asks
   `Allow <app> to use your <provider> account from Composio?`, with each
   service and its account's name, and a choice where they have several.
   **Allow** makes the connection and allows the app. Not linked yet, the
   page has **Sign in to Composio** first. A service the app needs that
   isn't in their Composio is named there with a link to its page and
   **Check again**.

5. **Each other app** asks too. When the connection already has the
   services it lists, that is the Gateway's Allow page. When it needs
   another service of the same provider, it is the page of step 4 again,
   the connection then holds both, and the first app keeps its access.

## Verify

1. `everyapp workspace composio show`: on.
2. `everyapp status --json`: the app's `setup.ready` is true, or its
   `unmet` no longer has the provider's client. `status`, `deploy` and
   `configure` read the switch, so they agree with the Gateway.
3. `everyapp provider link composio`, run by the person: their Composio
   account, and each provider found there with its services and the
   accounts' names. It reads Composio each time and stores nothing.
4. `everyapp provider connections`: the person's connection to the
   provider. VIA reads `composio`, and ACCESS lists its services in place
   of scopes (`via` and `services` under `--json`).
5. The app: open it and use the feature. The Gateway's log has one
   `integration.proxy.call` per call, with `via: "composio"` and the
   service.

## If it fails

A refusal by the Gateway reaches the CLI as `GATEWAY_TOOL_ERROR` with the
Gateway's code in `data.code`.

| Error or symptom                                                                     | Meaning                                                                                                                                              | What to do                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COMPOSIO_OFF`                                                                       | Linking was started while Composio is off for the organization                                                                                       | An owner or admin turns it on (step 1)                                                                                                                 |
| `COMPOSIO_ALREADY_LINKED`                                                            | The person linked already                                                                                                                            | Nothing. To link another Composio account, `everyapp provider unlink composio` first, which deletes their connections made through it                  |
| `COMPOSIO_UNAVAILABLE`                                                               | Composio couldn't be reached                                                                                                                         | Try again                                                                                                                                              |
| `COMPOSIO_LINK_FAILED`                                                               | Composio approved the sign-in, but the link couldn't be finished. Composio hands a key out once, so that sign-in is spent                            | Start again (step 2)                                                                                                                                   |
| `COMPOSIO_LINK_EXPIRED`                                                              | Nobody approved the page in time (about 10 minutes)                                                                                                  | Start again (step 2)                                                                                                                                   |
| `ADMIN_REQUIRED`                                                                     | A member tried to turn Composio on or off                                                                                                            | An owner or admin does it                                                                                                                              |
| The app still reads Needs setup, or the connect page says the provider has no client | Composio is off, doesn't serve the provider, or the app lists a scope no service covers                                                              | `everyapp workspace composio show`; compare the app's scopes with the second table. A scope outside it needs an OAuth app for the provider             |
| The page names a service that isn't connected                                        | The service isn't in the person's Composio                                                                                                           | Step 3, then **Check again**                                                                                                                           |
| `integration_not_configured` (503)                                                   | No client, and Composio is off or doesn't serve what the app lists                                                                                   | As two rows up                                                                                                                                         |
| `integration_not_connected` (409)                                                    | The person hasn't connected or allowed the app, the connection needs a reconnect, Composio refused their key, or the account is gone from Composio   | The person opens `connectPath` from the app. After a refused key they link again (step 2), then **Reconnect** on Your connections → Accounts          |
| `invalid_integration_route` (400)                                                    | No service owns the URL, the method isn't `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, or Composio doesn't send to that host                           | Call a URL the service owns (Limits, below), or give the provider an OAuth app                                                                         |
| `integration_body_invalid` (400 or 413)                                              | The request body isn't JSON, or is larger than 10 MiB                                                                                                | Send JSON, or give the provider an OAuth app                                                                                                           |
| `integration_upstream_failed` (502)                                                  | Composio or the provider couldn't be reached, or the answer was larger than 25 MiB                                                                   | Try again                                                                                                                                              |
| A connection reads Needs reconnect after an OAuth app was added                      | The provider is served with the client now                                                                                                           | The person selects **Reconnect**, which goes through the provider. Their other apps ask again                                                          |

## Limits

- A call through Composio takes about half a second longer than a direct
  one.
- Only a JSON request body can be sent: no form, no file upload. It is at
  most 10 MiB, and the method is `GET`, `POST`, `PUT`, `PATCH` or
  `DELETE`.
- A JSON answer is parsed and written again, so a number past 2^53 loses
  precision.
- A binary answer comes back whole only when the provider labels it as
  binary. An answer of any kind is at most 25 MiB.
- Each Google, Microsoft and Atlassian service is its own account in
  Composio.
- Some URLs have no service and are refused: Google's account-name
  endpoints (`openidconnect.googleapis.com`, and `www.googleapis.com`
  outside Calendar, Drive and Search Console), Atlassian paths outside
  `/ex/jira/` and `/ex/confluence/` (`/me` among them), and Microsoft
  Graph paths outside mail, calendar, contacts, files, Teams and
  SharePoint.
- A call still goes only to the provider's API hosts
  ([providers](/docs/agent/providers)). `google-workspace`'s don't include
  `sheets.googleapis.com` or `docs.googleapis.com`, so a call to the Sheets
  or Docs API is refused with or without Composio.
- The Gateway can't see or ask for scopes on an account in Composio. An
  allowed app can do whatever the account allows there, and the provider's
  own refusal is the answer when it doesn't.
- A person connects a missing service in Composio, not from EveryApp.

App authors: an app that should work both ways sends JSON bodies and calls
only URLs a service owns.

## Rerun, rotate, remove

- **One connection.** The person selects **Disconnect** on Your
  connections → Accounts (the operator's command is `everyapp provider
  disconnect <provider> --user <email>`). Every app stops using it at
  once. Nothing is revoked at the provider, nothing changes at Composio,
  and their link stays.
- **Unlink.** `everyapp provider unlink composio`, or **Unlink** on Your
  connections → Accounts. It deletes the person's key, a sign-in that is
  waiting, and every connection they made through Composio, with the
  access apps had to them. The key stays valid at Composio until they
  revoke it there: tell them to.
- **Turn off.** `everyapp workspace composio off`, or **Turn off** in the
  Composio section on Providers. It deletes every link in the organization and every
  connection made through Composio, with the access apps had to them. It
  can't be undone. The command asks first at a terminal, and its result
  says how many were removed; with `--json` it stops with
  `CONFIRMATION_REQUIRED` until `--yes` is added, which you add only when
  the owner or admin said so. Over MCP, `everyapp_workspace_composio` with `on: false` needs
  `confirm: true` while a link or a connection through Composio exists,
  and without it the refusal says how many there are.
- **Composio refuses a key** (the person revoked it there): the Gateway
  deletes the link, and their connections through it read Needs reconnect
  and keep their apps. They link again and select **Reconnect**. With the
  same accounts, no app asks again.
- **The organization adds its own OAuth app later** (`everyapp provider
  add <id>`, or a provider's guide): nothing is deleted. Connections to
  that provider through Composio read Needs reconnect, and **Reconnect**
  goes through the provider's consent. To the Gateway that is another
  account, so the person's other apps ask again. Composio stops seeing
  that provider's calls. Removing the client again, with Composio on,
  works the other way round.

## Sources

- Local: `docs/design/2026-11-composio.md` (the design, and what was and
  wasn't checked against the real Composio), `docs/security.md` (known gap
  12) and `packages/sdk/src/internal/composio.ts` (the providers, their
  services, scopes and URLs).
- The limits on calls were measured against the real Composio for an
  earlier design. The Gateway as built is tested against a test double:
  nobody has run it against the real service.
