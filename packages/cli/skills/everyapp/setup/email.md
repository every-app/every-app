# Email sending for the Gateway

Lets the Gateway send its own mail (invitations, password resets, sign-up
verification) and every app's, through one provider for the whole Gateway:
Cloudflare Email Sending (the default) or Resend. Apps that send: agentic-inbox
(replies from its own addresses; required), Open Analytics (reports and
alerts; `optional: true`, so it opens without it) and any app whose
`everyapp.config.ts` lists `capabilities: { email: { access: "write" } }`.
Email is optional: without it, an invite shows its link to share instead. At the end the person
has a sending domain set up with the provider, `EMAIL_FROM` and
`EMAIL_FROM_NAME` on the Gateway, and an invitation that arrived by mail.

## Settings

| NAME                   | required or optional        | what it holds                                                                                                              |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_FROM`           | required                    | the sender address, `noreply@<your domain>`; or the combined form `Acme <noreply@<your domain>>`, the display name inside it (quotes around the name are dropped) |
| `EMAIL_FROM_NAME`      | required, unless `EMAIL_FROM` carries the name | the display name people see, e.g. `Acme`; set, it outranks the name inside `EMAIL_FROM`                      |
| `RESEND_API_KEY`       | optional (Resend only)      | a Resend API key, `re_…`, with Sending access to every domain the Gateway sends as (step 6)                                |
| `EMAIL_PROVIDER`       | optional                    | `cloudflare` or `resend` (any case): pins the provider; unset, the Gateway picks one (below)                               |
| `EMAIL_REST_API_TOKEN` | optional (a Gateway outside Workers: local dev) | a Cloudflare API token with Email Sending Edit, with `CLOUDFLARE_ACCOUNT_ID`; never set it on a deployed Gateway: it outranks the `EMAIL` binding |

Set both, the default. Or `EMAIL_FROM` alone in the combined form, with
`EMAIL_FROM_NAME` unset. Either way the Gateway sends only once it has an
address and a name (`parseEmailSender` in `packages/sdk/src/internal/email.ts`;
the Gateway's `configuredSender()` uses it): a bare address with no name
anywhere counts as no sender, so the Gateway says "Email is not configured"
and an app's send gets `integration_not_configured` (503). `secret list`
and `status` read names, not values: an app's `email` setting counts as set
once `EMAIL_FROM` and `EMAIL_FROM_NAME` are both on the Gateway (both
`required: true` in `data.gateway.needed`), so the combined form with no
`EMAIL_FROM_NAME` reads as `! not set` there while the Gateway, which reads
the values (`isEmailConfigured`), opens the app and sends. Verify 2 is the
check that counts.

How the provider is picked: `EMAIL_PROVIDER` when set (and it must be set up;
it never falls back); else Cloudflare when `EMAIL_REST_API_TOKEN` is set, else
Resend when `RESEND_API_KEY` is set, else Cloudflare's `EMAIL` binding, which
every deployed Gateway has. So a deployed Gateway with `RESEND_API_KEY` sends
through Resend without `EMAIL_PROVIDER`. Neither `EMAIL_FROM` nor
`EMAIL_FROM_NAME` is a secret: pipe them with `echo`.

## Costs and plans

As of October 2026. Cloudflare Email Sending (in beta): "Sending to arbitrary
recipients requires the Workers Paid plan" ($5 a month, which `everyapp setup`
already needs); 3,000 emails a month included, then $0.35 per 1,000. Before a
domain is onboarded, mail goes only to verified destination addresses (those
sends are free and uncounted on any plan). New accounts start with "a
conservative daily quota" that grows with sending behaviour (Verify 6 reads
it). 50 recipients and 5 MiB a message. Resend Free: 3,000 a month, 100 a
day, 3 domains, 30 days of logs; Pro is $20 a month for 50,000. Resend's
pages don't say whether Free needs a card. Resend's default rate limit is 10
requests a second per team, all keys together (raised on request at
resend.com/help). The Gateway's own budget for app mail: 100 a day per
recipient address (20 on a hosted Gateway) and 5,000 a day per Gateway.

## Only a person can

- Pay for Workers Paid, or create a Resend account, accept its terms and pick
  a plan.
- Click **Onboard Domain** in the Cloudflare dashboard (you can do this with
  `cf` instead, step 2).
- Create the Resend API key and copy it off the screen into the hidden prompt.
- Approve Resend's **Sign in to Cloudflare** (Domain Connect) if they use it.
- Say yes to turning Email Routing on for a domain (its MX and SPF records
  move to Cloudflare; mail hosted elsewhere stops arriving).
- Open their inbox and confirm the invitation or reset mail arrived.

## Before you start

- `pnpm everyapp secret list <app id> --json` (`agentic-inbox` or
  `analytics`, the launch apps that list `email`; from anywhere once it is
  deployed, else `pnpm everyapp secret list --json` in its directory): this
  file applies when `data.app.setup.unmet`
  has the entry `id: "email"` (`kind: "capability"`, `holder: "gateway"`,
  `names: ["EMAIL_FROM", "EMAIL_FROM_NAME"]`, `need.kind: "required"`, `setup: "setup/email.md"`:
  the path `status` (under "<app> needs setup") and `secret list <app id>`
  (under the unmet setting) print as `Guide:
  .claude/skills/everyapp/setup/email.md`, and `secret list --json` carries
  per unmet setting; how an agent lands here), and `data.app.setup.command`
  is `pnpm everyapp configure <app id>`, which asks for `EMAIL_FROM` and
  `EMAIL_FROM_NAME` among what the app still needs (visible, checked
  prompts; step 8 says what to type). An app
  that marks `email` `optional: true` (Open Analytics) has the entry in
  `settings` with `set: false`, never in `unmet`: it opens without a
  sender, and this file applies when they want its mail. The older
  `data.gateway.needed` (each `{ name, required, set }`) and
  `data.gateway.missing` still say the same of `EMAIL_FROM` and
  `EMAIL_FROM_NAME`; `RESEND_API_KEY`, `EMAIL_PROVIDER` and
  `EMAIL_REST_API_TOKEN` are read when set (`required: false`), never in
  `unmet` or `missing`. The entry `set: true`: both are on the Gateway
  already; ask before replacing them.
- `pnpm everyapp status --json`: `data.installed` and `data.claimed` true,
  `data.gatewayUrl` gives `<gateway host>`, `data.accountId` is `<account id>`
  (the sending domain's zone must be in this account), `data.apps[].setup`
  says which apps still need setup (an `APP_NEEDS_SETUP` fix each, severity
  `warning`), and each `data.apps[].email.senders` says which apps already
  send as their own.
- `pnpm everyapp secret list --json` from the checkout root: whether
  `EMAIL_FROM`, `EMAIL_FROM_NAME`, `RESEND_API_KEY`, `EMAIL_PROVIDER` or
  `EMAIL_REST_API_TOKEN` are in `data.gateway.names` (the one place the last
  four show as set). Any set: ask before replacing. `EMAIL_REST_API_TOKEN`
  set on a deployed Gateway: it outranks the binding; ask whether that is meant.
- Every `cf …` below is the CLI's pinned cf, the one `pnpm everyapp login
  --json` signs in: README's "Where you are" says how to run it.
- `cf zones list --name <your domain>`: one zone, `status` active, in
  `<account id>`. None: the person adds the domain to Cloudflare first (the
  domain page in the public docs).
- `cf email-sending subdomains list -z <your domain>`: whether the domain is
  onboarded already (its entry, whose `tag` is `<subdomain id>` below).
  Empty: step 2.
- For an app's senders, in the app's directory: `pnpm everyapp email show --json`:
  `data.app.deployed` true (false: deploy first), `data.declares.sends` true,
  `data.senders` the current list.

## Steps

1. **You:** choose with the person: the provider and the sender. Cloudflare
   when the domain is on Cloudflare DNS in `<account id>` and they want
   nothing else to sign up for (the default; steps 2 to 3). Resend when they
   already use it or want its dashboard (steps 4 to 7). One provider sends
   everything; both can be set up, with `EMAIL_PROVIDER` picking. The
   sender: the address to send from (offer `noreply@<your domain>`, on the
   domain step 2 or 4 sets up: the apex or `mail.<your domain>`) and the
   name people see (their company name); set neither before they chose.
   Then step 8 for either.

   **Cloudflare Email Sending**

2. **You:** first, read-only,
   `cf email-sending subdomains preview -z <your domain> --name <your domain>`:
   the records onboarding needs and any conflict (a foreign MX, a second
   SPF) for the person to clean up under **DNS** > **Records** first. Then
   onboard the sending domain in the Gateway's account:
   `cf email-sending subdomains create -z <your domain> --name <your domain>`
   (`--name` is the domain `EMAIL_FROM` uses: the apex, or `mail.<your domain>`;
   never the full address). It turns zone-level Email Sending on too when
   the account has the entitlement (Workers Paid; refused for it: gateway.md,
   step 2). Note the subdomain's `tag` in the output: that is
   `<subdomain id>` below. Alternative,
   **Person:** https://dash.cloudflare.com/?to=/:account/email-service/sending
   (**Compute** > **Email Service** > **Email Sending**; the public docs say
   **Compute & AI**) > **Onboard Domain** > pick the domain > review the
   records > **Done** (**Add records and onboard** in the public docs). Wait
   until the domain is listed under Email Sending.
3. **You:** check the DNS records. Dashboard onboarding adds them itself (MX
   and SPF at `cf-bounce.<your domain>`, DKIM at
   `cf-bounce._domainkey.<your domain>`, DMARC at `_dmarc.<your domain>`);
   whether step 2's API path does too is unverified, so look:
   `cf email-sending subdomains dns status <subdomain id> -z <your domain>`
   diffs the expected records against the zone. Any missing or unlocked:
   `cf email-sending subdomains dns fix <subdomain id> -z <your domain>`
   creates them (idempotent; a 409 is a foreign MX or a duplicate
   SPF/DKIM/DMARC record at those names, for the person to clean up under
   **DNS** > **Records**). Run `dns status` again until nothing is missing,
   usually within 5 to 15 minutes. Go to step 8.

   **Resend**

4. **Person:** https://resend.com/domains > **Add Domain** > type the domain
   `EMAIL_FROM` will use (Resend recommends a subdomain, `mail.<your domain>`)
   > the region closest to recipients > add it. Fastest: Resend's **Sign in
   to Cloudflare** button (Domain Connect): they approve once, the records
   land in the zone, and the domain verifies within minutes; skip step 5's
   records. Else the **Records** tab lists a DKIM TXT record at
   `resend._domainkey` and SPF records at `send` (an MX, priority 10, and a
   TXT); DMARC is recommended, not required. They paste the names and
   values to you (public DNS values, not secrets): `<dkim value>`,
   `<mx host>` and `<spf value>` below.
5. **You:** add the records to the zone, `DNS only`, one
   `cf dns records create -z <your domain> --body '…'` per record, each with
   its complete name (the record it prints shows the `name` created):
   `{"type":"TXT","name":"resend._domainkey.<your domain>","content":"<dkim value>","ttl":1}`,
   `{"type":"MX","name":"send.<your domain>","content":"<mx host>","priority":10,"ttl":1}`,
   `{"type":"TXT","name":"send.<your domain>","content":"<spf value>","ttl":1}`
   (under `mail.<your domain>`: `resend._domainkey.mail.<your domain>` and
   `send.mail.<your domain>`; a free priority if 10 is taken). Then
   **Person:** on the domain's page, **Verify DNS Records**; the status goes
   **Pending** > **Verified** (often within 15 minutes, up to 72 hours;
   **Failed** after that: **Restart verification**). Until then Resend
   refuses mail from it.
6. **Person:** https://resend.com/api-keys > **Create API Key** > Name
   `every-app-gateway` > Permission **Sending access** > Domain: leave it
   unrestricted if any app will send as its own domain (step 9), else the
   domain from step 4 (both are editable there later; the key's value is
   not) > create. The key (`re_…`) is shown once. README's first way: with
   it on screen, they open a second terminal in the `every-app` folder, run
   `pnpm everyapp secret set RESEND_API_KEY`, paste at the hidden prompt,
   and tell you. Or README's third way: exported before they started you,
   you run `pnpm everyapp secret set RESEND_API_KEY --from-env RESEND_API_KEY --json`;
   else they read it in hidden in their own terminal (`read -rs
   RESEND_API_KEY && export RESEND_API_KEY`; never a typed `export …=`,
   which the shell history keeps), run that line there, then
   `unset RESEND_API_KEY`.
7. **You:** pin the provider only when both are set up, or the person wants
   it explicit: `echo resend | pnpm everyapp secret set EMAIL_PROVIDER --json`
   (README's second way; `resend` is not a secret). Look for `done`.

   **The sender, either provider**

8. **You:** the address and name chosen in step 1, one value per pipe
   (README's second way; two names in one pipe is `SECRET_SEVERAL_NAMES`):
   `echo "noreply@<your domain>" | pnpm everyapp secret set EMAIL_FROM --json`
   then `echo "Acme" | pnpm everyapp secret set EMAIL_FROM_NAME --json`, with
   their address and name in place of the examples. Or, when the person
   wants one setting, the combined form (Settings):
   `echo "Acme <noreply@<your domain>>" | pnpm everyapp secret set EMAIL_FROM --json`
   and no `EMAIL_FROM_NAME`. Each ends with `done`; the Gateway reads the
   new values on its next request, no deploy. Then Verify 1:
   `pnpm everyapp secret list --json`, both names in `data.gateway.names`
   (`EMAIL_FROM` alone with the combined form; and `RESEND_API_KEY` for
   Resend). Or, at the person's terminal, `pnpm everyapp configure <app id>`
   (`agentic-inbox` or `analytics`) asks for `EMAIL_FROM` and then
   `EMAIL_FROM_NAME` among the app's other settings, at visible prompts
   that say what each takes and check it (the address, then the name, as
   in the two pipes above; where `email` is required it wants both, so the
   combined form alone is for the pipe).

   **An app that sends as its own addresses** (agentic-inbox)

9. **You:** after the app's first deploy, set up its domain with the same
   provider (steps 2 to 3, or 4 to 5; a domain done for `EMAIL_FROM` needs
   nothing). Resend: the key must cover the new domain too; one restricted
   to step 4's domain refuses mail from any other, so the person edits its
   Domain at https://resend.com/api-keys (the value stays; nothing to
   re-set) or creates a new key (step 6, `secret set RESEND_API_KEY` again).
   Then in the app's directory:
   `pnpm everyapp email set --sender "*@<your domain>" --json`. `done` with
   `data.senders.value` the new list and `data.senders.changed` true.
   `--sender` replaces the whole list (repeat it for several; one address
   works too); the Gateway picks it up within 30 seconds. Until it has one
   the app sends as the Gateway's sender, and the CLI says so: its
   `pnpm everyapp deploy --json` ends with `data.next` naming
   `pnpm everyapp email set --sender '*@<domain>'` ("lets <app> send as
   your domain"), and `pnpm everyapp email show --json` carries the same
   command in `data.next` ("send as your own domain") under "<app> sends
   as the Gateway's sender"; neither on a hosted Gateway, which takes no
   app senders. An app deployed from a release has no directory here:
   clone its repository and run the command in that directory (only
   `everyapp.config.ts` is read), or pass
   `--manifest <path to its everyapp.config.ts>` from here.

   **Inbound mail** (an app declaring `email: { inbound: true }`): in its
   directory, `pnpm everyapp email set --inbound "*@<your domain>" --json`
   (an apex catch-all) or one address; the zone must be in `<account id>`.
   `EMAIL_ROUTING_DISABLED`: Email Routing is off for that domain; tell the
   person what turning it on does (above) and rerun with
   `--enable-email-routing` only when they said yes. Then
   `pnpm everyapp status --json`: `data.fixes` has no `EMAIL_*` code (all
   four are about inbound routes; each names what to run, usually
   `pnpm everyapp deploy --json`). The checks and the manual path:
   docs/runbooks/email-sending-setup.md, "Inbound mail to an app".

## Verify

1. `pnpm everyapp secret list agentic-inbox --json` (or the app that brought
   you here, from anywhere): the `email` entry in `data.app.setup.settings` is
   `set: true` and out of `data.app.setup.unmet`, `data.app.setup.ready` true
   once nothing else is missing, `EMAIL_FROM` and `EMAIL_FROM_NAME` out of
   `data.gateway.missing` (with the combined form and no `EMAIL_FROM_NAME`,
   that name stays in it: this reads names). From the checkout root with no
   app named: `EMAIL_FROM` and `EMAIL_FROM_NAME` in `data.gateway.names`
   (`EMAIL_FROM` alone with the combined form; `RESEND_API_KEY` too for
   Resend). Then `pnpm everyapp status --json`: `data.apps[].setup.ready` true
   for that app and no `APP_NEEDS_SETUP` fix naming it. All of this reads
   names: the combined form with no `EMAIL_FROM_NAME` fails here while the
   Gateway sends; Verify 2 is the check that counts.
2. Smoke check, by the person (`GET /api/integrations/email` is for apps, not
   operators): on `https://<gateway host>/`, **Manage workspace** (bottom of
   the sidebar) > **Users** > **Invite user** > an address they control >
   **Invite**. The invitation arrives from `EMAIL_FROM_NAME <EMAIL_FROM>` (the
   combined form: `EMAIL_FROM` as set). An
   **Invite link** dialog instead (the link with a copy button, "Send this
   link to <address>…") means it didn't; the Users page's banner "Email is
   not configured." says which case (If it fails). Or `https://<gateway host>/forgot-password`
   with their address: the reset mail arrives (unless `EMAIL_PASSWORD_SIGN_IN`
   is `false`).
3. The provider alone, Cloudflare, with the person's yes (one counted
   email, unless `to` is a verified destination address):
   `cf email-sending send --body '{"from":"noreply@<your domain>","to":"<address>","subject":"EveryApp test","text":"It works."}'`
   sends without the Gateway. It arriving means the provider is done and a
   failed invite is the Gateway's side (its settings; the logs below). A
   refusal is the REST API's numeric code (`10203` sending disabled,
   `10105` not entitled, `10004` throttled), not the binding's `E_*`; an
   un-onboarded sender's code isn't documented. Resend: the domain's
   **Verified** is the only check short of sending (a Sending-access key
   can't list domains: `restricted_api_key`).
4. The app: in its directory `pnpm everyapp email show --json` lists each
   pattern in `data.senders` (none yet, and the app declares sending on a
   self-hosted Gateway: `data.next` names `email set --sender '*@<domain>'`,
   step 9); `pnpm everyapp status --json` shows it in
   `data.apps[].email.senders`; the app itself sees `ready: true` and
   `provider` from `integrationStatus({ env, provider: "email" })`. Then
   send one mail from the app.
5. Logs, when a send fails: cf 1.0.0-beta.14 has no `workers tail` (`cf
   workers --help`; `cf o11y telemetry live-tail` only prepares a websocket),
   so use the dashboard, README's path:
   **Workers & Pages** → `every-app-gateway` → **Observability** (**Logs** on older accounts) → **Live**,
   then trigger the send. A failure
   is one line, "Email delivery failed", with `event: "email.send.failed"`,
   `kind`, `provider` (which one refused), `code`, `providerCode` and
   `message`; an app's send logs `email.app.send`. Or
   `npx wrangler tail every-app-gateway --format pretty` streams the same
   (npx fetches wrangler, not in the checkout; it signs in apart from cf:
   `npx wrangler login`, which the person approves in the browser).
6. Cloudflare's quota and usage: `cf email-sending limits get`:
   `quota.value` a day (`quota.unit`), `usage.sent` so far,
   `usage.over_quota`; `quota` null means none is assigned yet (a new
   account).

## If it fails

| error or symptom                                                                  | meaning                                                                             | what to do                                                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SECRET_VALUE_REQUIRED`                                                           | nothing was piped and there is no terminal                                          | one of README's three ways                                                                              |
| `SECRET_VALUE_REQUIRED` from `pnpm everyapp configure <app id> --json`           | nothing was piped (with `--from-env`, stdin isn't read), no variable of a missing name was found, and there is no terminal; the message names what the app still needs (`EMAIL_FROM` and `EMAIL_FROM_NAME` among them while unset) | `NAME=value` lines on stdin (`EMAIL_FROM="Acme <noreply@<your domain>>"`, quoted), or the person's terminal (step 8) |
| `SECRET_SEVERAL_NAMES`                                                            | a pipe or `--from-env` with two names                                               | one `secret set` per name                                                                               |
| `SECRET_EMPTY`                                                                    | the `--from-env` variable isn't set in the shell that ran the command (exported in theirs, not before you started) | they run it in their terminal, or the hidden prompt (step 6)                              |
| `SETTING_VALUE_INVALID` with `data.name`                                          | `EMAIL_FROM`, `EMAIL_FROM_NAME` or `EMAIL_PROVIDER` got a value the Gateway wouldn't read (`EMAIL_FROM` takes an address or `Name <address>`; `EMAIL_PROVIDER` `cloudflare` or `resend`); nothing was written | pipe the value `data.fix` describes                                                                       |
| `SECRET_NOT_DECLARED` with `data.didYouMean`                                      | the name isn't a Gateway setting (a typo)                                           | rerun with the name in `data.didYouMean` and the same value source (`--from-env VAR --json`, or the same pipe); `data.rerun` carries only the names, so run as is it stops with `SECRET_VALUE_REQUIRED` |
| `SECRET_NOT_SETTABLE`                                                             | a name setup owns (`CLOUDFLARE_ACCOUNT_ID`, written by `everyapp setup`) or a dev-only one | nothing to set; use the names in Settings                                                         |
| `CONFIRMATION_REQUIRED` from `secret unset --json`                                | it needs `--yes`                                                                    | ask the person, then rerun with it                                                                      |
| the **Invite link** dialog instead of a sent mail, and the Users page's banner "Email is not configured."; app gets `integration_not_configured` (503) | no sender (an `EMAIL_FROM` with no name in it and no `EMAIL_FROM_NAME` counts as none), or no provider is set up, or `EMAIL_PROVIDER` names one that isn't | set `EMAIL_FROM` and `EMAIL_FROM_NAME`, or `EMAIL_FROM` in the combined form (step 8); set that provider's setting or unset `EMAIL_PROVIDER` |
| the **Invite link** dialog with no banner on the Users page                      | configured, but the provider refused the send                                       | Verify 5's `email.send.failed` line, then the provider rows below                                       |
| the app's host answers 503 `app_needs_setup`, or a browser lands on `https://<gateway host>/?setup=<app id>`; `status` has `APP_NEEDS_SETUP` naming `EMAIL_FROM`, or the Gateway's app list says "Needs setup" while `secret list` says `set: true` | the Gateway keeps an app that lists `email` closed until it can send: a sender with a name and a provider (Settings) | step 8 (both settings, or the combined form), then the provider's steps; Verify 2 |
| log: `EMAIL_PROVIDER is "…", which isn't an email provider`                       | a value other than `cloudflare` or `resend`                                         | `echo cloudflare \| pnpm everyapp secret set EMAIL_PROVIDER --json`, or unset it                        |
| `email_sender_not_verified` (422); `E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_RECIPIENT_NOT_ALLOWED` (before onboarding, only verified destination addresses are allowed); Resend 403 naming the domain; mail reaches only verified addresses | the sender's domain isn't onboarded or Verified with the provider | steps 2 to 3 (Cloudflare) or 4 to 5 (Resend) for that domain; `dns status` or Resend's Records tab |
| `email_provider_limited` (429); `E_DAILY_LIMIT_EXCEEDED`, `E_RATE_LIMIT_EXCEEDED`, `10004`; Resend `daily_quota_exceeded`, `monthly_quota_exceeded`, `rate_limit_exceeded` | the provider's quota or rate | wait; `cf email-sending limits get`, Cloudflare's limit increase form; Resend Pro |
| `E_ACCOUNT_SUSPENDED`                                                             | Cloudflare paused the account's sending (reputation)                                | Cloudflare support; no self-service path is documented                                                  |
| `email_budget_exhausted` (429)                                                    | the Gateway's own daily app-mail budget                                             | wait until UTC midnight (`Retry-After`)                                                                 |
| `email_send_failed` (502); log `Resend refused the API key` (the stable marker; `providerCode` is Resend's name: `validation_error` "API key is invalid", `restricted_api_key`, `suspended_api_key`, `invalid_permission`) | the key is wrong, deleted, suspended, or restricted to another domain; any other `providerCode`: the provider refused it | a new key (step 6) and `secret set RESEND_API_KEY` again, or widen its Domain (step 9); else read `providerCode` in the log |
| `email_sender_not_allowed` (403)                                                  | the app's `from` matches none of its senders                                        | step 9                                                                                                  |
| `EMAIL_NOT_DECLARED`                                                              | `everyapp.config.ts` doesn't list `capabilities.email` with `access: "write"`       | add it; `pnpm everyapp deploy --json` in the app's directory, then rerun                                |
| `APP_NOT_FOUND` from `email set`; `email show`: "isn't deployed yet"              | no first deploy                                                                     | `pnpm everyapp deploy --json` in the app's directory, then rerun                                        |
| `EMAIL_SENDER_INVALID`; `EMAIL_SENDERS_HOSTED`                                    | a pattern that isn't lowercase `*@<domain>` or one address; a hosted Gateway takes no app senders | fix the pattern (its `data.rerun` lowercases it); apps send as the Gateway's sender      |
| `EMAIL_ROUTING_DISABLED`, `EMAIL_ZONE_NOT_FOUND`, `EMAIL_ADDRESS_TAKEN`           | inbound: routing off (needs a yes), zone not in the account, address routed elsewhere | the runbook's inbound section                                                                        |
| mail lands in spam                                                                | no DMARC, or a new domain with no reputation                                        | Cloudflare adds `_dmarc` itself; add Resend's recommended DMARC record; keep volume low at first        |

## Rerun, rotate, remove

- Rerun: every step repeats safely. `subdomains create` re-enables a domain
  that exists, `dns fix` is idempotent, `configure` and `secret set`
  replace, `email set --sender` replaces the list. Start again from Verify
  and continue at the first step that isn't done.
- Rotate Resend: create a new key (step 6), `secret set RESEND_API_KEY`, then
  delete the old key at https://resend.com/api-keys. The Cloudflare binding has
  nothing to rotate. Change the sender: step 8 again.
- Switch provider: set up the other one, then `EMAIL_PROVIDER`; `pnpm everyapp
  secret unset EMAIL_PROVIDER --json` goes back to the automatic choice.
- Remove: `pnpm everyapp secret unset RESEND_API_KEY EMAIL_PROVIDER --json`
  (add `--yes` only when the person said so; without it `--json` stops with
  `CONFIRMATION_REQUIRED`), then delete the key at
  https://resend.com/api-keys. Unsetting `EMAIL_FROM` and `EMAIL_FROM_NAME`
  returns the Gateway to invite and reset links. An app's senders:
  `pnpm everyapp email unset senders --json` in its directory. A Cloudflare
  sending domain, only when asked:
  `cf email-sending subdomains delete <subdomain id> -z <your domain>`
  (disables sending and removes its records; it asks, so add `--force` only
  after the person said yes, as with `--yes`), or the dashboard.

## Sources

- Cloudflare: https://developers.cloudflare.com/email-service/ (beta, Workers Paid, verified destinations free), https://developers.cloudflare.com/email-service/configuration/domains/ (onboarding, the records it adds), https://developers.cloudflare.com/email-service/get-started/send-emails/ (the dashboard path and deep link, the `EMAIL` binding), https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/ (the subdomain's `tag`), https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ (the `E_*` codes), https://developers.cloudflare.com/email-service/api/send-emails/rest-api/ (the numeric codes), https://developers.cloudflare.com/email-service/platform/limits/ (quota, verified destination addresses, 50 recipients, 5 MiB), https://developers.cloudflare.com/email-service/platform/pricing/ (Workers Paid, 3,000 a month, $0.35 per 1,000), https://developers.cloudflare.com/workers/platform/pricing/ ($5 a month), https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ (Logs > Live), https://developers.cloudflare.com/workers/wrangler/commands/workers/ (`wrangler tail`)
- Resend: https://resend.com/pricing, https://resend.com/docs/api-reference/rate-limit (10 a second per team), https://resend.com/docs/api-reference/errors (error names), https://resend.com/docs/add-a-domain, https://resend.com/docs/dashboard/domains/manage-domains (statuses), https://resend.com/docs/knowledge-base/cloudflare (Sign in to Cloudflare, record names, DNS only, Verify DNS Records), https://resend.com/docs/create-an-api-key, https://resend.com/docs/api-reference/api-keys/create-api-key (Sending access, domain restriction, shown once), https://resend.com/docs/dashboard/api-keys/introduction (permission and domain editable in the Dashboard)
- Local, 2026-10-23: `cf email-sending subdomains {create,preview,delete,dns status,dns fix} --help`, `cf email-sending limits get` (its fields), `cf dns records create --help` and `cf workers --help` of cf 1.0.0-beta.14 (`packages/cli/package.json` pins it, `lib/cf/bin.ts` runs it, `pnpm --filter everyapp exec cf --version` prints it); docs/runbooks/email-sending-setup.md, docs/capabilities.md and the CLI's error paths (`commands/secret`, `commands/email`, `lib/gateway/registry.ts`, `commands/status/problems.ts`) in the checkout; 2026-10-24: `packages/sdk/src/internal/email.ts` (`parseEmailSender`: the combined form, a name required) and the Gateway's `server/email/sendEmail.ts` (`configuredSender`, `isEmailConfigured`), `commands/deploy/deployApp.ts` and `commands/email/index.ts` (the `email set --sender` next step), `commands/configure/index.ts` (`configure <app>`: the visible prompts for `EMAIL_FROM` and `EMAIL_FROM_NAME`, `NAME=value` lines on stdin), the runbook's "Sender configuration" as of #389; `packages/sdk/src/internal/capabilities.ts` (the `email` entry: `settings: ["EMAIL_FROM"]`, the rest `optionalSettings`; later on 2026-10-24 `EMAIL_FROM_NAME` moved into `settings`, the shape the top of this file describes) and `appSettings.ts`, `packages/cli/src/lib/app/settings.ts` (`gatewayNeeds`, `gatewayMissing`) and `commands/secret/index.ts` (`secret list <app>`), the Gateway's `server/app-setup.ts` (readiness from `isEmailConfigured`) and `server/app-needs-setup.ts` (the closed app), after #383, #395, #396 and #397 merged
