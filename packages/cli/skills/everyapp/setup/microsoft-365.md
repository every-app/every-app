# Microsoft 365 (Outlook OAuth client) for the Gateway

An OAuth client registered in Microsoft Entra, held by the Gateway, so that
every member of an organization can connect their own Outlook mailbox (work
or school account, or a personal Microsoft account) to Open CRM (app id
`crm`), which reads their mail, never sends. The Gateway completes
Microsoft's token endpoint with the client; the app keeps each member's
tokens. At the end the person has an app registration named for the CRM, a
client id and one client secret (which expires), and `MICROSOFT_365_CLIENT_ID`
and `MICROSOFT_365_CLIENT_SECRET` set on the Gateway.

## Settings

Through the Gateway's own flow (since 2026-10-25) the same client also serves apps that list `microsoft-365` with `access: "read"` and `scopes`, without an app callback: register `https://<gateway>/connect/microsoft-365/callback` as a second redirect URI, and each person connects under Connected accounts in the account menu (the agent docs' `providers` page, "OAuth providers"). The client may be pasted in Manage workspace → Providers instead of set below; a setting set here wins.

| Name                          | Required | What it holds                                                                              |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `MICROSOFT_365_CLIENT_ID`     | required | The registration's **Application (client) ID** (a GUID, shown on its Overview page). Not a secret. |
| `MICROSOFT_365_CLIENT_SECRET` | required | A client secret's **Value** (Certificates & secrets), shown once when created; expires in at most 24 months. |

Fixed by the registry (`capabilities.ts`, `microsoft-365`, labelled **Microsoft 365 (Outlook mail and calendar)** in
errors and logs): the token endpoint the Gateway completes is
`POST https://login.microsoftonline.com/common/oauth2/v2.0/token`, the multi-tenant `common` one only, so the
registration MUST support "any organizational directory and personal Microsoft accounts" (manifest
`signInAudience: AzureADandPersonalMicrosoftAccount`); the app sends people to
`https://login.microsoftonline.com/common/oauth2/v2.0/authorize`, Open CRM asking for `offline_access User.Read Mail.Read`;
the redirect URI is `https://<app>.<app base domain>/integrations/microsoft/callback`, for Open CRM
`https://crm.<app base domain>/integrations/microsoft/callback`.

The client carries three scope sets, each one Graph delegated permission, all read-only: `identity` (`User.Read`),
`mail.read` (`Mail.Read`) and `calendar.read` (`Calendars.Read`); `offline_access` (the refresh token) is added to
every app's list whatever its sets (`alwaysRequested`; `requestedScopes()` in `packages/sdk/src/internal/oauthScopes.ts`),
so the registry's whole checklist reads `offline_access User.Read Mail.Read Calendars.Read` (docs/capabilities.md,
"OAuth clients"). An app names its sets in its manifest entry, `"microsoft-365": { access: "write", scopes: ["identity", "mail.read"], why }`
(#414; `everyapp deploy` refuses the entry without `scopes`), and the Gateway holds it to them at every token exchange
and refresh (#411; docs/design/2026-10-oauth-scopes.md §3 and §5), replacing the request's `scope` with the sets'
scopes plus `offline_access`: Open CRM's is `offline_access User.Read Mail.Read`. An entry deployed without `scopes` is
refused at the token endpoint (`integration_scopes_undeclared`); such a CRM must redeploy before the Gateway is updated
from main (TODO.md "OAuth scopes (2026-10-24)", follow-up 0).
The registration's delegated permissions are the union behind the sets of every app you approve
(TODO.md, "Setup skills (2026-10-24)"), not the registry's whole list: for the launch, Open CRM alone, `User.Read`,
`Mail.Read` and `offline_access`; `Calendars.Read` joins only when an app declares `calendar.read`.

## Costs and plans

As of October 2026: registering an app and its client secrets cost nothing (Microsoft Entra ID Free). A tenant is
needed to register in: a Microsoft 365 or Azure subscriber already has one (every tenant is an Entra tenant). A
solopreneur without Microsoft 365 creates an Azure free account (a phone number, a non-prepaid card for identity
verification that is not charged beyond a temporary hold of about one dollar, and a Microsoft or GitHub account); its
**Default Directory** is the tenant. After 30 days the Azure subscription is disabled unless moved to pay-as-you-go
(nothing is charged); Entra ID Free needs no subscription, and Microsoft's page says nothing about the directory:
support answers say the tenant and its registrations stay (unverified). The account that registers needs at least the Application Developer role (the
tenant's creator is Global Administrator). A personal Microsoft account alone, with no tenant, cannot register.
Members who connect need a mailbox: Exchange Online (a Microsoft 365 plan with mail) or an outlook.com account.
Microsoft Graph's Outlook limit is 10,000 requests per 10 minutes and four concurrent requests, per app per mailbox;
a `429` carries `Retry-After`, which Open CRM honors.

## Only a person can

- Sign in to Microsoft: the Entra admin center, or the browser approval `az login` opens.
- Create the Azure free account, add the card, and pick the tenant when the sign-in sees several.
- Copy the client secret's **Value** off the screen (it is shown once) and type it at the hidden prompt.
- Connect their mailbox in Open CRM and accept Microsoft's consent screen. Register in the tenant the members' work
  mailboxes live in: a member from another organization's tenant sees "Need admin approval" (`AADSTS90094`) by
  Microsoft's default (a new multitenant app without a verified publisher, asking for more than sign-in), and that
  organization's admin consents (the If-it-fails row); personal Microsoft accounts are not affected. Publisher
  verification, which lifts this, needs a Partner Center account and a custom publisher domain, and a registration
  made under a personal Microsoft account can't get it.

## Before you start

1. `pnpm everyapp secret list crm --json`, from any directory (the id reads the manifest Open CRM's last deploy
   stored; in its directory the id can be left off), one call, before any Microsoft step. The rule: read
   `data.app.setup.settings`, `unmet` and `command`. The client is one setting there, `id: "microsoft-365"`,
   `kind: "capability"`, `holder: "gateway"`, `names: ["MICROSOFT_365_CLIENT_ID", "MICROSOFT_365_CLIENT_SECRET"]`
   (an OAuth client's id and secret are the two names of one setting, set only when both are), `need.kind` as the
   CRM's manifest declares it (Open CRM: `optional`: it sits in `settings` with `set: false`, never in `unmet`, the
   CRM opens without Outlook and `command`, `pnpm everyapp configure crm`, offers it after the required ones;
   `required` would put it in `unmet`, close the CRM and have configure ask for both names first), `setup:
   "setup/microsoft-365.md"` (this file). While its `set` is false this file
   applies. The same entry in `data.app.setup.settings` with `set: true`: ask before
   replacing; a value can't be read back, so replacing means a new secret in Entra. The same answer says whether
   the CRM's own `TOKEN_ENCRYPTION_KEY` is set (`holder: "app"`; optional, so in `settings`, never in `unmet`): it
   must be set before anyone can connect (after the CRM's first deploy, at the hidden prompt of
   `pnpm everyapp configure crm`, which offers it with the optional ones, or of
   `pnpm everyapp secret set TOKEN_ENCRYPTION_KEY --app crm`, from anywhere; 32 or more random characters), so
   settle it now, not after the set.
2. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true; `data.appBaseDomain` is `<app base domain>`;
   `data.apps[]` has `"id": "crm"` with `"status": "active"`, `"bound": true`, the `hostname` the redirect URI
   goes on (step 1) and, as `setup`, 1's `data.app.setup` again: what else the CRM needs. No `crm`: deploy Open
   CRM first (from its directory, `pnpm everyapp deploy --json`); the registration can be made before that, but
   a connect only completes once `crm.<app base domain>` serves `/integrations/microsoft/callback`.
3. An existing registration: the person opens
   https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade and looks for one named
   for the CRM. Reuse it (steps 3 to 5 check its settings) rather than registering twice.
4. The console path below is the default. The `az` alternatives need the Azure CLI: `az version` says whether it
   is there. Missing: don't install it on your own; offer `brew update && brew install azure-cli` only if the
   person wants the `az` path and says yes.

## Steps

One Person step per message: give step 2, wait for the words it ends with, then step 3, and so on. Not a checklist
to send at once: step 2 settles the tenant and step 3 the account type (and gives the id step 6 needs) before any
secret exists.

1. **You:** Work out the redirect URI from `pnpm everyapp status --json`: `https://` + the `hostname` of app `crm`
   + `/integrations/microsoft/callback` (the same URI Open CRM shows owners and admins on Settings → Connections →
   Microsoft 365). Give it to the person with the registration name to use, `Open CRM`.
2. **Person:** Sign in at https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
   with the account that administers the organization's tenant (or the Microsoft account of the Azure free
   account). Several tenants: the **Settings** (gear) icon in the top menu switches; pick the one the
   organization's mailboxes live in. They see the **App registrations** list (older menus: **Identity →
   Applications → App registrations**; current: **Entra ID → App registrations**). Wait for "I see App
   registrations".
   *Alternative, with `az`:* `az login --allow-no-subscriptions` (opens the browser; `--use-device-code` when it
   can't; `--tenant <tenant id>` to pick one). The person approves the sign-in; wait for `az` to print the account.
3. **Person:** Click **New registration**. **Name:** `Open CRM` (people see it on the consent screen). **Supported
   account types:** the option for any organization plus personal accounts, labelled **Any Entra ID Tenant +
   Personal Microsoft accounts** (older wording: **Accounts in any organizational directory (Any Microsoft Entra
   directory - Multitenant) and personal Microsoft accounts (such as Skype, Xbox)**); never "Single tenant": the
   Gateway completes only the `common` endpoint. **Redirect URI (optional):** platform **Web**, paste the URI from
   step 1 (no field on the form: after registering, **Authentication → Add a platform → Web → Redirect URIs →
   Configure**). Click **Register**. They see the **Overview** page with **Application (client) ID**; that id is
   not a secret, they may paste it in the chat. Wait for the id.
   *Alternative:* `az ad app create --display-name "Open CRM" --sign-in-audience AzureADandPersonalMicrosoftAccount --web-redirect-uris "https://crm.<app base domain>/integrations/microsoft/callback" --query appId -o tsv`
   prints the id; then `az ad sp create --id <client id>` (the portal creates this service principal with the
   registration; `az ad app create` does not, and the smoke check in Verify needs it).
4. **Person:** In the registration, **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions**; search and tick `User.Read` (added automatically at registration), `Mail.Read` and
   `offline_access`: the union behind Open CRM's sets (`identity`, `mail.read`, plus `offline_access`). Tick
   `Calendars.Read` as well only when an app you approve declares `calendar.read` (Settings, above). Click **Add
   permissions**. They see the three under **Configured permissions**, each with
   **Admin consent required: No**. The app asks for these three on its authorize URL, so members of this tenant and
   personal accounts consent themselves; registering them is what **Grant admin consent for <tenant>** covers
   (members from other tenants need it by Microsoft's default: Only a person can, above). Wait for the three rows.
   *Alternative:* `az ad app permission add --id <client id> --api 00000003-0000-0000-c000-000000000000 --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope 570282fd-fa5c-430d-a7fd-fc8dc98a9dca=Scope 7427e0e9-2fba-42fe-b0c0-848c9e6a8182=Scope`
   (Microsoft Graph's app id; the delegated ids of `User.Read`, `Mail.Read`, `offline_access`, each verified in
   Graph's permissions reference; `Calendars.Read`, when an app needs it, is `465a38f9-76ea-45b9-9f34-9e8b0d4b0b42=Scope`,
   admin consent not required, personal accounts supported). Ignore its hint to run `permission grant`: people consent at connect time.
5. **Person:** **Certificates & secrets → Client secrets → New client secret**. **Description:** `EveryApp
   Gateway`; **Expires:** 24 months is the maximum (Microsoft recommends less; put the date in the calendar).
   Click **Add**. The row's **Value** column is the secret, shown only while they stay on the page. Then, in a
   second terminal in the `every-app` folder: `pnpm everyapp secret set MICROSOFT_365_CLIENT_SECRET` (the hidden
   prompt; paste; nothing is echoed). README's first way: the person types it. Wait until they see `Set MICROSOFT_365_CLIENT_SECRET on the Gateway`
   and `Live now on <gateway host>. No deploy needed.`
   *Alternative, with `az`, README's second way (a command produced it; never run the `az` part on its own):*
   `az ad app credential reset --id <client id> --years 2 --display-name "EveryApp Gateway" --append --query password -o tsv | pnpm everyapp secret set MICROSOFT_365_CLIENT_SECRET --json`
   `--append` keeps existing secrets (without it the command deletes them all first). Look for `"type": "done"`.
6. **You:** Set the client id (not a secret): `echo "<client id>" | pnpm everyapp secret set MICROSOFT_365_CLIENT_ID --json`,
   or from `az`: `az ad app list --display-name "Open CRM" --query "[0].appId" -o tsv | pnpm everyapp secret set MICROSOFT_365_CLIENT_ID --json`.
   Look for `"type": "done"`. One value per pipe (`SECRET_SEVERAL_NAMES` otherwise). Both at once only at the
   person's terminal: `pnpm everyapp configure crm` (it asks for the two names, id then secret, with hidden
   prompts, after the CRM's required settings; the client is optional for Open CRM, so Yes to `Set the N optional
   settings too?`, Enter skipping the others; with one of the two names set it asks only for the other; or pick `MICROSOFT_365_CLIENT_ID + MICROSOFT_365_CLIENT_SECRET` from
   the menu once the CRM is ready) or `pnpm everyapp secret set MICROSOFT_365_CLIENT_ID MICROSOFT_365_CLIENT_SECRET`
   (two hidden prompts); either covers step 5's set too. The change is live at once, no deploy.
7. **You:** Verify, below.

## Verify

1. `pnpm everyapp secret list crm --json`, from anywhere: the `microsoft-365` setting has `set: true` (optional
   for Open CRM, so it was never in `data.app.setup.unmet`; a manifest that requires it has it leave `unmet`, with
   `ready: true` and `command` null once nothing else is missing); both
   names in `data.gateway.names`, `"set": true` in `data.gateway.needed`, and not in `data.gateway.missing`.
   Then `pnpm everyapp status --json`: the `crm` entry's `setup.ready` is true and `data.fixes` has no
   `APP_NEEDS_SETUP` for it (the Gateway opens the CRM again).
2. Smoke check, only if the person still has the secret in a variable they exported in their own terminal
   (README's third way) and says so; otherwise skip to 3. Never ask them to copy the secret again for this: the
   **Value** was shown once, at step 5, and 3 exercises the pair through the Gateway anyway. (They `unset` the
   variable after.) It checks the id and secret pair against the registration's home tenant (its **Directory
   (tenant) ID** on Overview, or a verified domain of the tenant):

   ```
   printf '%s' "$MS_CLIENT_SECRET" | curl -s -X POST "https://login.microsoftonline.com/<tenant id>/oauth2/v2.0/token" -d "client_id=<client id>" -d "grant_type=client_credentials" -d "scope=https://graph.microsoft.com/.default" --data-urlencode "client_secret@/dev/stdin"
   ```

   `printf` is a shell builtin and curl URL-encodes the secret it reads from stdin, so the value is never on a
   command line (the process list would show it). Expected: JSON with `access_token` (the pair is right; this token carries no permissions and is thrown away).
   `error_description` starting `AADSTS7000215`: wrong secret; `AADSTS7000222`: expired; `AADSTS700016`: the id
   isn't a registration in that tenant; `AADSTS7000229`: no service principal yet (the If-it-fails row).
3. The app, open: 1's `data.app.setup.ready` true. While another required setting of the CRM is unmet, the Gateway
   sends a browser to its setup dialog instead of the CRM (anything else gets 503 `app_needs_setup`): finish those
   first (each `unmet` entry's `setup` names its file); until then 1 and 2 are the checks of the client. Then a
   member opens Open CRM → **Settings → Connections → Microsoft 365** and clicks **Connect**. Microsoft
   signs them in, shows a consent screen for Open CRM with its permissions in Microsoft's words (reading mail,
   signing in and reading the profile, and **Maintain access to data you have given it access to**; the scope names
   don't appear, and the publisher shows as **Unverified**, which is expected), and returns them to the page, which
   says the mailbox is connected and starts syncing. A **Not configured** badge and no **Connect** button means the
   Gateway doesn't hold both settings (an owner or admin also sees a card with the redirect URI and
   `pnpm everyapp secret set MICROSOFT_365_CLIENT_ID MICROSOFT_365_CLIENT_SECRET`): step 1 of this section.
4. The Gateway's logs, when the connect fails after consent: the dashboard, README's path:
   **Workers & Pages** → `every-app-gateway` → **Observability** (**Logs** on older accounts) → **Live**
   (the Gateway deploys with Workers Logs on, so the stored logs are on the same page). `cf workers` has no
   tail; Workers Logs are under `cf o11y telemetry`: `cf o11y telemetry query --help` (a query over them) and
   `cf o11y telemetry live-tail --help` (prepares a live tail; `--script-id` names the Worker, `every-app-gateway`). Look for
   `integration.proxy.call` with `"capability": "microsoft-365"`, its `grantType` (`authorization_code` on connect,
   `refresh_token` later) and `status`: `200` is a token issued; `400` or `401` is Microsoft refusing, and the body
   is never logged, so read the AADSTS code on the CRM's page. `integration.proxy.upstream_failed` is Microsoft
   unreachable.

## If it fails

| Error or symptom                                                                 | Meaning                                                                                        | What to do                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `integration_not_configured` (Gateway 503), or the CRM's **Not configured** badge with no **Connect** button (owners and admins: the card with the redirect URI and the `secret set` command) | The Gateway holds neither or only one of the two settings, or a name differs; the badge alone also means the deployed manifest lists `microsoft-365` without `scopes` (add them, deploy) | `pnpm everyapp secret list --json`; set what is missing (steps 5 and 6) |
| `capability_not_requested` (403)                                                 | The deployed manifest doesn't list `microsoft-365` (an entry without `scopes` is `integration_scopes_undeclared` instead) | Add `"microsoft-365": { access: "write", scopes: ["identity", "mail.read"], why }` to `everyapp.config.ts`, deploy again |
| `integration_agent_not_allowed` (403)                                            | An agent (MCP) tried to connect or refresh                                                     | The person connects in the app                                                                               |
| `integration_upstream_failed` (502), log `integration.proxy.upstream_failed`      | The Gateway couldn't reach login.microsoftonline.com (the CRM says "Microsoft returned an error. Try again.") | Try again                                                                                          |
| `integration_path_not_allowed` (403), `integration_body_invalid` (400), `integration_body_too_large` (413), `integration_scope_not_allowed` (403: the request's `scope` names a scope outside the CRM's sets) | The app's request (an endpoint other than `/common/oauth2/v2.0/token`, a body it doesn't take, or a scope it doesn't declare), not this setup | Check the app's version                                                        |
| `integration_scope_exceeded` (403) on a connect or a refresh | Two apps on this one registration and one person: Microsoft can issue a token carrying every scope the person consented to either app, and the Gateway refuses the narrower app's exchange rather than narrowing it (docs/design/2026-10-oauth-scopes.md §9; its log line `integration.proxy.scope_refused` names the excess) | The member removes the app at https://myapplications.microsoft.com and connects again; for good, one registration per app, which needs its own registry entry (TODO.md "OAuth scopes (2026-10-24)") |
| `SECRET_VALUE_REQUIRED`                                                          | Nothing was piped and there is no terminal                                                     | One of README's three ways; `data.rerun` shows the `--from-env` form                                         |
| `SECRET_VALUE_REQUIRED` from `pnpm everyapp configure crm --json`               | Nothing was piped (with `--from-env`, stdin isn't read), no variable of a missing name was found, and there is no terminal; the message names what the CRM still needs (this client is optional for Open CRM, so never among them) | The pipes in steps 5 and 6, or the person's terminal (step 6)                             |
| `SECRET_SEVERAL_NAMES`                                                           | Two names with one piped or `--from-env` value                                                 | One `secret set` per name                                                                                    |
| `SECRET_EMPTY`                                                                   | The `--from-env` variable isn't exported in this shell                                         | The person exports it in the terminal that runs the command                                                  |
| `SECRET_NOT_DECLARED` with `data.didYouMean`                                     | The name is misspelled (case or underscores)                                                   | rerun with the name in `data.didYouMean` and the same value source (`--from-env VAR --json`, or the same pipe); `data.rerun` carries only the names, so run as is it stops with `SECRET_VALUE_REQUIRED` |
| `CONFIRMATION_REQUIRED` from `secret unset --json`                               | No `--yes`, and `--json` never asks                                                            | That is the ask: show it; its `data.rerun` adds `--yes` (`data.authorize`), run it only if the person says so |
| `AADSTS50011` redirect URI mismatch                                              | The URI on the registration isn't exactly `https://crm.<app base domain>/integrations/microsoft/callback` | **Authentication → Platform configurations → Add URI**, platform Web, exact case; wait 3 to 5 minutes |
| `AADSTS50194` /common not supported                                              | The registration is single-tenant                                                              | **Authentication → Supported account types**, choose the organizations + personal option (manifest `signInAudience`) |
| `AADSTS700016` application not found                                             | `MICROSOFT_365_CLIENT_ID` isn't a registration's id, or the registration is personal-only / single-tenant | Compare with **Application (client) ID** on Overview; fix the audience; set the id again          |
| `AADSTS7000229` missing service principal (the smoke check; not in Microsoft's AADSTS reference) | The registration was made with `az` and has no Enterprise application in its tenant yet; the secret is fine, so don't rotate it | `az ad sp create --id <client id>`, or on Overview the **Create Service Principal** link (where **Managed application in local directory** would be); smoke check again |
| `AADSTS50020` user does not exist in tenant                                      | The account signed in belongs to no tenant the registration accepts                            | Fix the audience as above; the member signs in with their mailbox's account                                  |
| `AADSTS7000215` invalid client secret                                            | The Gateway's secret is wrong (a typo at the prompt, or not the **Value** column)              | New secret (Rotate, below), set it again                                                                     |
| `AADSTS7000222` client secret expired                                            | The secret's expiry passed; every connect and refresh fails                                    | Rotate, below; members reconnect when the CRM says NEEDS_RECONNECT                                           |
| `AADSTS90094` "Need admin approval", the CRM's `access_denied`                   | Microsoft's default for a member outside the registration's tenant: a new multitenant app without a verified publisher (risk-based step-up consent) | That organization's admin opens the admin-consent link on the member's CRM page, or Entra → **Enterprise apps → Open CRM → Security → Permissions → Grant admin consent**; or register in the members' tenant |
| `AADSTS65001`, the CRM's `access_denied`                                         | Consent hasn't been granted for that tenant (the default for members outside the registration's tenant, or a tenant that lets only admins consent) | As above                                                                                            |
| `AADSTS65004`                                                                    | The member declined the consent screen                                                         | Connect again                                                                                                |
| `AADSTS90002` tenant not found                                                   | The admin-consent link was built from an email domain the tenant hasn't verified               | The admin consents from Entra (previous row)                                                                 |
| `AADSTS700054` id_token not enabled                                              | The authorize request asked for an ID token; Open CRM asks for a code                          | Something other than the CRM built the URL; check the app's version                                          |
| `invalid_grant` on refresh: `AADSTS70008` / `AADSTS700082` (unused 90 days), `AADSTS50173` (password reset or tokens revoked), `AADSTS65001` (consent withdrawn); `AADSTS70000` is another refresh-token failure | The refresh token stopped working | The CRM marks the connection NEEDS_RECONNECT; the member connects again |
| CRM: `email_doesn't_match`                                                       | The mailbox's address isn't the member's Gateway email                                         | Sign in to Microsoft with the matching account                                                               |
| CRM: "confirm this is an active Exchange Online mailbox"                         | The account has no mailbox (no mail license)                                                   | A licensed mailbox or an outlook.com account                                                                 |
| CRM: **Connect** fails before Microsoft opens: "Connections aren't set up on this CRM yet" | The CRM's own `TOKEN_ENCRYPTION_KEY` is unset, or under 32 characters (the one key its Google, Microsoft and Slack connects share) | Set it after the CRM's first deploy: `pnpm everyapp configure crm` (which asks for it) or `pnpm everyapp secret set TOKEN_ENCRYPTION_KEY --app crm` from anywhere (in the CRM's directory the flag can be left off), the value in one of README's three ways; connect again |

## Rerun, rotate, remove

- **Rerun.** Safe at any step: `configure` and `secret set` replace; the registration's pages show what exists (one registration,
  not two: look in App registrations first). Interrupted: start from Verify and continue at the first step that
  isn't done.
- **Rotate the secret** before it expires (the registration's **Certificates & secrets** page shows the dates).
  This audience allows at most two client secrets at once: look there first (or
  `az ad app credential list --id <client id>`) and, with two already, delete the expired or unused one. Then add the second (step 5, either path; with `az`,
  keep `--append`), set it (`secret set MICROSOFT_365_CLIENT_SECRET`), verify, then delete the old one: the trash
  icon on its row, or `az ad app credential list --id <client id>` for its `keyId` and
  `az ad app credential delete --id <client id> --key-id <key id>`. Members' connections carry on; the client id
  never changes, so `MICROSOFT_365_CLIENT_ID` stays.
- **Remove.** `pnpm everyapp secret unset MICROSOFT_365_CLIENT_ID MICROSOFT_365_CLIENT_SECRET --json` (with
  `--json` it never asks: without `--yes` it stops with `CONFIRMATION_REQUIRED`, whose `data.rerun` adds `--yes`;
  run that only when the person said so). Then revoke on Microsoft's side: delete the secret (as
  above), or the whole registration (Overview → **Delete** → confirm, as at least Cloud Application
  Administrator; or `az ad app delete --id <client id>`). Microsoft has no token revocation endpoint: members'
  mailbox tokens stop at their next refresh, and each member withdraws the consent from their own Microsoft
  account at https://myapplications.microsoft.com (the CRM's page links it).

## Sources

- https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app (registration path, account type labels, client id)
- https://learn.microsoft.com/en-us/entra/identity-platform/supported-accounts-validation (`signInAudience` values, two-secret limit)
- https://learn.microsoft.com/en-us/entra/identity-platform/reply-url (redirect URI rules, AADSTS50011)
- https://learn.microsoft.com/en-us/troubleshoot/azure/entra/entra-id/app-integration/error-code-aadsts50011-redirect-uri-mismatch
- https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials (client secret steps, 24-month maximum, shown once)
- https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-access-web-apis (API permissions clicks, admin consent button)
- https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc (`offline_access` must be requested; refresh tokens)
- https://learn.microsoft.com/en-us/entra/identity-platform/permissions-consent-overview (dynamic consent for delegated permissions)
- https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent (default user consent; the settings path)
- https://learn.microsoft.com/en-us/graph/permissions-reference (`User.Read`, `Mail.Read`, `offline_access`, `Calendars.Read` ids; admin consent not required; `Mail.Read` and `Calendars.Read` for personal accounts)
- https://learn.microsoft.com/en-us/graph/throttling-limits (Outlook service limits)
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow (the smoke check's request and answers)
- https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes (AADSTS codes)
- https://learn.microsoft.com/en-us/entra/identity-platform/howto-remove-app (deleting a registration)
- https://learn.microsoft.com/en-us/entra/fundamentals/what-is-entra and https://learn.microsoft.com/en-us/entra/fundamentals/create-new-tenant (who has a tenant; free tenants)
- https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account (card for verification with a temporary hold, not charged; disabled after 30 days unless upgraded)
- https://learn.microsoft.com/en-us/entra/identity-platform/app-objects-and-service-principals (the service principal: automatic in the portal, a separate step through the API; created on consent)
- https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-risk-based-step-up-consent and https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview (AADSTS90094 for unverified multitenant apps; who can be verified)
- https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent (the Enterprise apps path; the adminconsent URL)
- https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience ("Unverified" on the consent prompt)
- https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens (90-day lifetime, revocation)
- https://knowledge.cribl.io/microsoft-47/office-365-activity-source-fails-with-aadsts7000229-service-principal-missing-from-azure-tenant-2323 (AADSTS7000229's text and the portal fix)
- https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-macos, https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively, https://learn.microsoft.com/en-us/cli/azure/reference-index (`az login` flags)
- https://learn.microsoft.com/en-us/cli/azure/ad/app, https://learn.microsoft.com/en-us/cli/azure/ad/app/credential, https://learn.microsoft.com/en-us/cli/azure/ad/app/permission (Azure CLI 2.91, flags as used above)
- https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ and https://developers.cloudflare.com/workers/observability/logs/workers-logs/ (the dashboard's Logs and Observability pages)
- `packages/sdk/src/internal/capabilities.ts` (`microsoft-365`: the label, the `common` token endpoint, the three scope sets, `alwaysRequested`) and `packages/sdk/src/internal/oauthScopes.ts` (`requestedScopes()`); `docs/capabilities.md`, "OAuth clients" (the generated scope tables)
- `docs/design/2026-10-oauth-scopes.md` (§3 the manifest's `scopes`, §4 the Microsoft policy, §5 the token-endpoint check and `integration_scope_exceeded`, §9 the shared-client limit) and TODO.md, "OAuth scopes (2026-10-24)" (the decisions; Open CRM's redeploy) and "Setup skills (2026-10-24)" (the console-side union rule); the manifest field and the check are #414 and #411, merged
- Open CRM's `src/shared/mailbox.ts` (`REQUESTED_SCOPES.microsoft`) and `src/client/features/mailbox/connectionCopy.ts` (the myapplications.microsoft.com link)
