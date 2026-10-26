# Cloudflare account, the Gateway and its owner for the Gateway

Everything else in this folder needs this first: a Cloudflare account on
Workers Paid with a domain, the Gateway Worker installed at `<gateway host>`
(`apps.<your domain>` unless the person chooses another name), the `cf` CLI
logged in, and an owner account. Every app uses it: OpenSEO, Open CRM,
openmail, OpenAnalytics, and anything `everyapp create` makes. At
the end the person has `https://<gateway host>` to sign in to,
`https://<gateway host>/admin` to invite people, and apps at
`<app>.<app base domain>`.

## Settings

The first four rows setup writes itself and `secret set` refuses
(`SECRET_NOT_SETTABLE`; it also refuses `APP_BASE_DOMAIN` and
`THIRD_PARTY_DEPLOYS`, which setup doesn't write). The last two are optional
and set with `secret set` (Step 9).

| NAME | required or optional | what it holds |
| --- | --- | --- |
| `GATEWAY_URL` | set by setup | `https://<gateway host>` |
| `CLOUDFLARE_ACCOUNT_ID` | set by setup | the account's id (32 hex characters); Workers AI and email reuse it |
| `GATEWAY_DEPLOYMENT_MODE` | set by setup | `self_hosted` or `hosted`; set at the first upload, never changes |
| `BETTER_AUTH_SECRET`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | set by setup | the Gateway's session and identity keys (rotation: docs/runbooks/key-rotation.md) |
| `CF_DEPLOY_TOKEN` | optional | a Cloudflare API token (Workers Scripts Edit, D1 Edit, Zone DNS Read) for installing apps from the browser |
| `BROWSER_APP_INSTALLS` | optional | exactly `on` turns browser installs on (setup writes it with the token when the person opts in); unset, `off` or anything else keeps them off. Owners and admins of the install organization, from a session under 10 minutes old |

## Costs and plans

As of October 2026. A Cloudflare account is free. Workers Paid is a $5 a
month minimum per account, then usage; it includes 10 million requests, 30
million CPU ms a month and D1's 25 billion rows read and 50 million written
a month plus 5 GB of storage, far more than a small team's Gateway uses.
The Free plan is refused: D1 Free stops answering at 5 million rows read or
100,000 written a day (reset 00:00 UTC), and the Gateway reads D1 on every
request. A domain: Cloudflare Registrar sells at cost, with no promotions
of its own; price trackers list a `.dev` or `.app` at about $8 the first
year (a registry discount), then $12.20 or $14.20 a year, and a `.com` at
about $10.46 (setup's own message says about $10); the dashboard shows the
exact price before **Complete purchase**. Moving a domain you own is free,
on the Free zone plan. Node, pnpm, git and `cf` are free. No rate limits
matter; the device login gives 5 minutes (cf's own limit), the owner link
lasts 24 hours.

## Only a person can

- Sign up for Cloudflare and verify the email.
- Add a card and subscribe to Workers Paid.
- Buy a domain, or change nameservers at the registrar they bought it from.
- Approve the device login in a browser, and pick a workers.dev subdomain when Cloudflare asks for one.
- Open the owner link and create the account (name, email, password).
- Answer setup's browser-installs question, at a terminal, and paste the token.
- Choose the Cloudflare account when the login sees several (you show the choices).
- Enable R2 in the dashboard once, before OpenSEO, OpenCRM or OpenMail installs on an account that never had it (Step 11).

## Before you start

1. Tools: `node --version` prints 22.18.0 or newer (22 and 24 are LTS; 26, the Current release, works too), `pnpm --version` and `git --version` answer, and `everyapp --version` prints 0.3.0 or newer (`npm install -g everyapp@latest` installs or updates it; it brings its own pinned `cf`). No clone is needed: setup downloads the Gateway release for this everyapp version. (In a checkout of the EveryApp repository, `everyapp` builds the Gateway from the tree instead.). Every command below runs from that folder; `everyapp` outside it stops with `CHECKOUT_MISSING`.
2. `everyapp status --json`. `done` with `data.installed: true` and `data.claimed: true`: the Gateway exists and has an owner, go to Verify (a `GATEWAY_OUTDATED` fix there is `severity: "info"`, not a reason to stop). `action_required install_gateway` (exit 2; `data.rerun` is `everyapp setup`): no Gateway in any account this login sees, do the Steps. `action_required cloudflare_login` with `waiting: true`: hand over `data.url` and `data.code` (Step 6) and keep reading. `done` with `data.installed: false` and a `GATEWAY_NOT_INSTALLED` fix, or fixes `GATEWAY_NOT_UPLOADED` or `NO_OWNER`: an earlier setup stopped, run Step 7 again. Error `GATEWAY_NOT_FOUND`: the account named by `--account-id` or `CLOUDFLARE_ACCOUNT_ID` has no Gateway; its message says where one is.
3. Once `status` says `data.installed: true`: `everyapp secret list --json`; `data.gateway.names` has `GATEWAY_URL`, and `CF_DEPLOY_TOKEN` in it means browser installs are configured already. On a fresh account skip it: `secret list`, `email show` and `status` all need the Cloudflare login (under `--json` each starts the same `cloudflare_login` itself) and an installed Gateway; with none, `status` stops on `install_gateway` while the other two end `GATEWAY_NOT_FOUND` (exit 1), and an install that stopped before its first upload ends them `GATEWAY_NOT_INSTALLED` (exit 1, `data.rerun` is setup).
4. Which account. Setup checks the rest itself: it logs in (`setup.auth`; `status` starts the same `cloudflare_login`), reads the plan (`setup.plan`) and the domain (`setup.domain`) and stops on `cloudflare_login`, `choose_account`, `upgrade_workers_paid`, `add_domain` or `ZONE_NOT_FOUND` (Step 7), so on a first install nothing here gates it. `cf auth whoami` (read-only) prints the login's email and its accounts: several, ask the person which and carry `--account-id <account id>` on every command. When setup stops: `cf zones list` shows the domains and whether each is `active`; `cf accounts subscriptions get` is what setup reads for the plan.

## Steps

1. **Person:** Create the Cloudflare account, or use the one they have. Open https://dash.cloudflare.com/sign-up, enter **Email** and **Password**, select **Create Account**. Open Cloudflare's verification email (check Spam) and follow its link, then log in. Check: **My Profile** → **Email Address** shows "(verified)"; if **Send verification email** is offered there, it isn't yet. A verified email is required to buy a domain, and Cloudflare refuses to create anything (API code 10034) until it is: setup would end `CF_EMAIL_UNVERIFIED` (Step 7). Wait for "verified".
2. **Person:** Subscribe to Workers Paid. Open https://dash.cloudflare.com/?to=/:account/workers/plans (or `https://dash.cloudflare.com/<account id>/workers/plans`), choose the **Paid** plan ($5 a month), enter a card (Visa, Mastercard, American Express, Discover, UnionPay, PayPal or a wallet) and complete the purchase. A card can also be added first under **Billing** → **Subscriptions** → **Payment methods** → **Add Payment Method** → **Confirm**. Done when **Billing** → **Subscriptions** lists Workers Paid. You can check: `cf accounts subscriptions get` names a Workers plan containing "paid" or "standard".
3. **Person:** Get a domain on Cloudflare, in the same account. Buy: open https://dash.cloudflare.com/?to=/:account/registrar/register, search a name, select **Purchase**, pick the term under **Payment option**, enter contact details (ASCII only) and payment, select **Complete purchase** (up to 30 seconds; a confirmation email follows). Registrar charges only the primary payment method (card, PayPal or Apple Pay): with several on the account, make the right one primary first under **Billing** → **Payment methods** (**Make primary payment method**). Move one they own: open https://dash.cloudflare.com/?to=/:account/domains/overview, select **Onboard a domain**, enter the apex without `www`, **Continue**, choose the **Free** plan, check the copied DNS records (mail records above all) and **Continue**, then replace the nameservers at the current registrar with the two Cloudflare shows (turn DNSSEC off there first). Done when Cloudflare's email says the domain is active (usually under an hour, up to a day). Wait for `cf zones list` to show it `active`.
4. **You:** Install the tools if Before you start found them missing (Node 22.18.0 or newer from https://nodejs.org, 22 or 24 LTS or 26; `npm install -g pnpm`; git from https://git-scm.com on Windows; `npm install -g everyapp@latest`).
5. **You:** `everyapp login --json`, when nothing has logged in yet (`status` and setup start the same device login themselves; on its own this is for seeing the accounts with `cf auth whoami` before choosing `--account-id`, or after `cf auth logout`). Already logged in: a `step cloudflare.login skip` with `data.email`, then `done`. Otherwise an `action_required cloudflare_login` with `data.url`, `data.code`, `data.expiresAt` and `waiting: true`: give the person the link and the code at once (Step 6; cf gives up after 5 minutes). The run ends with `step cloudflare.login ok` ("Logged in to Cloudflare.", `data.email`) and `done`, exit 0. Underneath it is `cf auth login --no-browser`. Unattended runs (CI) export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead (the token takes priority over any stored login): a custom token made at https://dash.cloudflare.com/profile/api-tokens with Account › Workers Scripts › Edit, Account › D1 › Edit, Account › Workers KV Storage › Edit, Zone › Zone › Read (listing the domains needs it) and Zone › DNS › Read, limited to this account and the domain's zone. A token that lists no accounts needs `--account-id` (`ACCOUNT_REQUIRED`). The owner link is withheld only when the `CI` variable is set, or output is piped without `--json` (then `OWNER_NOT_CLAIMED`); a token login with `--json` on the person's machine still gets `claim_owner`.
6. **Person:** Approve the login, within 5 minutes. Open `data.url` (Cloudflare's device page; the code is not in the link), sign in to Cloudflare if asked, type `data.code` where the page asks for it, and approve the request (Cloudflare's docs: "Approve the request to give cf access to your Cloudflare account"). The terminal moves on: wait for the `step … ok` "Logged in to Cloudflare" event. Over SSH or in a container the same link works from any browser. Datacenter IPs get a 403 managed challenge from the OAuth endpoints (cloudflare/cf issue 23, open): use the API token instead.
7. **You:** `everyapp setup --domain apps.<your domain> --json` (add `--account-id <account id>` when the login sees several accounts). Its events, in order:

   | event | what it carries |
   | --- | --- |
   | `setup.toolchain` | `data.node`, `data.cf` |
   | `setup.auth` | `data.email`; before it, `cloudflare_login` when nothing is logged in |
   | `setup.account` | `data.id`, `data.name`; `data.gateway` true when one exists |
   | `setup.plan` | new install only: `ok` on Paid; `warning WORKERS_PAID_UNVERIFIED` when it can't tell (the run goes on); `skip` when cf couldn't read it |
   | `setup.domain` | `data.gatewayHost`, `data.appBaseDomain`, `data.zone` |
   | `setup.gateway` | `start` (`data.change`: `install`, `resume` after an earlier stop, `upgrade`, `repair` or `redeploy`; on a fresh install `data.expectedMinutes` `{ min: 5, max: 10 }`, the human line adding "usually 5–10 minutes, then the owner link": a whole first run takes 5 to 20 minutes, most of it waiting at that link, so run setup with a long timeout or in the background and keep reading its events); a minute or two of silence while the checkout builds (nothing is printed under `--json`: don't kill the run), then `step gateway.release ok` ("Built the Gateway … from this checkout." or "Using the Gateway … built from this checkout before"), `gateway.resources` (the D1 database and KV namespace, created or found), DNS, the Worker, its certificate, `ok` |
   | `setup.owner` | `skip` "Owner account is <email>" when one exists; else `claim_owner` (Step 8), then `ok` |
   | `setup.access` | Cloudflare Access, on by default once the owner exists (self-hosted, not when it is on already). Under `--json` it goes on without a question: `access on`'s steps, then `done.data.accessOn: true`. Stops (exit 1) on `ACCESS_TEAM_REQUIRED` when the account has no Zero Trust team: ask the person for the name ([access.md](access.md) step 1: permanent; `data.suggested` is a suggestion), then run this command again with `--team <name>`. `ACCESS_SETUP_FAILED`: show its fix, then run setup again (it picks up at Access). Only `--no-access` (never added unless the person says so), a No at a terminal, or an earlier `access off` leaves it off, remembered for later runs: `warning ACCESS_SETUP_SKIPPED` (`data.reason`) says it isn't recommended; relay it |
   | `done` | `data.gatewayUrl`, `data.adminUrl`, `data.owner`, `data.gateway` (`installed`, `upgraded`, `repaired` or `up-to-date`), `data.next`: `[{ command, note }]`. On a fresh self-hosted install, or when the owner was just created, these lines in this order: `everyapp create ../my-app`, `everyapp access on` (recommended; left out when `data.accessOn` is true, with the fact `Access on`), `everyapp secret set OPENAI_API_KEY` (or `OPENROUTER_API_KEY`, `WORKERS_AI_API_TOKEN`), `everyapp secret set EMAIL_FROM EMAIL_FROM_NAME`. Show them from the event; when `access on` is among them and the person didn't say no, the `setup.access` row applies; hosted: no Access line; up to date: only `status` |

   What it can stop on (exit 2, rerun `data.rerun` once done):
   - `cloudflare_login` (`waiting: true`): Step 6.
   - `choose_account`: several accounts and no Gateway, or Gateways in several accounts. `data.choices[]` has `accountId`, `accountName`, `label` and a ready `rerun` each (`--account-id <account id>`, or `--domain <gateway host>` when the host picks it); `gatewayUrl` only when the choice is between existing Gateways. Ask the person which, run that `rerun`.
   - `upgrade_workers_paid` ("Subscribe this account to Workers Paid"; `data.url` the plans page, `data.plan`): the account is on Free, nothing was created. Step 2, then rerun. Cloudflare refusing the upload on the Free plan ends the same way.
   - `add_domain` (`data.url`): "Finish activating": a domain whose nameservers don't point at Cloudflare yet (url: that domain's page, `data.zone`, `data.status`); "Add a domain": only when setup ran without `--domain` and the account has none (url: the domains overview). With `--domain`, no domain is the error `ZONE_NOT_FOUND` below. Step 3, then rerun.
   - `register_workers_subdomain` (`data.url`, `…/workers/onboarding`): Cloudflare wants a workers.dev subdomain before the account's first Worker. The person opens the link and picks any name; apps never use it. If that page shows no name field, open **Workers & Pages** and select **Change** next to **Your subdomain** (or https://dash.cloudflare.com/?to=/:account/workers/subdomain). At a terminal cf offers to register one itself. It stops the Worker upload, after the D1 database, the KV namespace and the install row exist: a rerun (`--domain` may be left off) resumes (`setup.gateway start` with `data.change: "resume"`) and creates nothing twice.
   - `rerun_interactive` (`data.needsTerminal: true`): the Gateway Worker serves a version everyapp didn't deploy (the dashboard, the API, an interrupted deploy), and nothing replaces it unattended. `data.rerun` is this command without `--json`, `data.rerunNote` "in a terminal" (or "…and confirm cf's prompt"): hand it to the person for their own terminal; never run it yourself, with or without `--json`.
   - `claim_owner` (`waiting: true`): Step 8.
   Errors (exit 1): `DOMAIN_REQUIRED` (unattended without `--domain`; `data.zones` lists the active domains. One zone: `data.rerun` is this command with `--domain apps.<zone>`, `data.rerunNote` "or another name under <zone>". Several: `data.choices[]`, `{ label, rerun }` per zone and no `data.rerun`: ask the person which, run its `rerun`), `CF_EMAIL_UNVERIFIED` ("Verify your Cloudflare account's email address first": Cloudflare API code 10034; `data.url` https://dash.cloudflare.com/profile, `data.rerun` this command: Step 1, then rerun), `ZONE_NOT_FOUND` (no domain in this account, or `--domain` isn't under one; `data.url` the domains overview, `data.zones` the active domains, empty when there are none: Step 3, then rerun), `DNS_RECORD_CONFLICT` (something already answers the name; `data.fix`: delete the record under the domain's **DNS** page, or another name; its `data.rerun` adds `--force-dns` with `data.authorize: true`: ask first, never add the flag on your own), `DNS_UNREADABLE` (an API token without Zone › DNS › Read can't tell whether a record is in the way; `data.fix` says to give it that; the same `--force-dns` rule), `DOMAIN_CHANGE_UNSUPPORTED` (installed elsewhere; rerun without `--domain`), `ACCOUNT_NOT_ACCESSIBLE` (lists the accounts the login can use), `ACCOUNT_REQUIRED` (an API token that lists no accounts: pass `--account-id`), `UNSUPPORTED_RUNTIME` (Node too old, or Bun).
8. **Person:** Create the owner account. `action_required claim_owner` carries `data.url` (`https://<gateway host>/setup#token=est_…`), `data.expiresAt` (24 hours), `data.replaced` and `waiting: true` (`data.waitingFor`: "the owner account (up to 15 minutes)"); setup polls for 15 minutes. Show the link to the person and to nobody else: whoever opens it first owns the Gateway, so it never goes into a log, an issue, a commit or a file. At a terminal setup opens it itself. The page is titled **Set up your gateway** ("Create the owner account for this gateway."): **Name**, **Email**, **Password** (at least 8 characters), **Confirm password**, then **Create owner account**; the button reads "Setting up..." and they land in the Gateway, signed in. Before it, a `warning GATEWAY_UNREACHABLE` means the certificate is still on its way (the link works as soon as the host answers); `ACCESS_IN_FRONT` means they sign in to Cloudflare Access first. Wait for `step setup.owner ok` ("Owner account created for <email>") and `done`. Nobody opened it in 15 minutes: exit 2 `claim_owner` with `data.setupUrl`; the same link still works until `data.expiresAt`, and a rerun before anyone opens it mints a new one and kills it (`data.replaced: true`). Once they say the account exists after that exit 2: run `data.rerun` as given (under `--json` it is exactly `everyapp setup --json`; every rerun keeps the flags the run had, except a `needsTerminal: true` one, which the person runs); it finds the owner (`step setup.owner skip`, "Owner account is <email>"; no new link once there is one) and ends `done` with `data.gateway: "up-to-date"` and `data.adminUrl`. Or `everyapp status --json`: `data.claimed: true` and `data.owner.email` say the same. "Use the newer setup link": setup ran again elsewhere, or it expired; rerun for a new link.
9. **Person (optional):** Browser installs. Only an interactive run without `--yes` asks, after the owner (`--yes`, `-y`, answers No): **Configure browser app installs?** (Yes/No, default No), then a hidden **Cloudflare API token** prompt. The token: https://dash.cloudflare.com/profile/api-tokens → **Create Token** → **Custom token** → **Get started**; permissions Account › Workers Scripts › Edit, Account › D1 › Edit, Zone › DNS › Read, limited to this account and the Gateway's zone; continue to summary, create, paste (nothing is echoed). It is stored as `CF_DEPLOY_TOKEN`. Under `--json` the question is skipped; to do it later, README's first way: the person runs `everyapp secret set CF_DEPLOY_TOKEN` in a second terminal in the `every-app` folder (hidden prompt), or the third: `everyapp secret set CF_DEPLOY_TOKEN --from-env CF_DEPLOY_TOKEN --json` with the variable exported in their shell. Skipped when the token is set already, and on a hosted Gateway.
10. **You:** `everyapp status --json`, read as in Verify.
11. **You, then the person:** The four EveryApp apps, offered once, as the setup prompt does (landing-page/content/docs/setup-prompt.txt, step 4): "I'll install OpenSEO, OpenCRM, OpenAnalytics and OpenMail. Any you don't want?" For each one they keep, from the `every-app` folder: `everyapp install https://github.com/every-app/<repo> --json` with `open-seo`, `open-crm`, `open-analytics` or `open-mail` as `<repo>`. It downloads the repository's latest release (`everyapp-release.tar.gz`, anonymously) and deploys it as `deploy` would from the app's directory, with nothing to clone or build (`step app.deploy` "Deploying <app> <version> from github.com/every-app/<repo> (release <tag>) to …", then the deploy's own steps; `done` with `data.url`, `data.live` and `data.next`; the same command later updates the app). The release path is the only one here: never clone a repository and deploy it, never build one from its URL. What an install can end on:
   - `NO_RELEASE` (exit 1): the repository publishes no release yet. Say which app, and go on to the next one; its `data.fix` (clone, `pnpm install`, then deploy from the clone) is for when the person asks for that, not a step of yours.
   - `R2_NOT_ENABLED` (exit 1): OpenSEO, OpenCRM and OpenMail each bind an R2 bucket named after their Worker, the install makes it, and an account that never enabled R2 can't have one made by the API (OpenAnalytics binds none and never stops here). Once for the account, the person enables R2 in the dashboard: https://dash.cloudflare.com/?to=/:account/r2/overview, **R2 Object Storage** → **Get started** (free until something is stored; no bucket to make by hand; `data.fix` says the same). Wait for them, then run `data.rerun` (this same command); the other two won't stop on it again.
   - `warning APP_NEEDS_SETUP` at `step app.secrets` ("<app> won't open until <names> is set", `data.setup`), after the upload: the app is live and shows **Needs setup** on the Gateway until its keys are set, and `done.data.next` carries `everyapp configure <app id>`, the one command that opens it. Tell the person which keys it wants, by name (the warning's names; `everyapp status --json` `data.apps[].setup.unmet[].names`, the id as `status` lists it: `openseo`, `crm`, `analytics` or `openmail`; or `everyapp secret list <app id> --json` `data.app.setup.unmet`), and stop there: the keys are never asked for here. When they want that app, each unmet setting's `setup` names its file in this folder ([dataforseo.md](dataforseo.md), [openrouter.md](openrouter.md), [context.md](context.md), [google.md](google.md), …), which takes over from this one; `everyapp configure <app id>` at their terminal sets every key the app needs in one go (README's first way).
   An app that stops on neither opens at `data.url`; one the person skipped installs the same way later.

## Verify

1. `everyapp status --json`: `done` with `data.installed: true`, `data.claimed: true`, `data.owner.email`, `data.gatewayUrl` = `https://<gateway host>`, `data.appBaseDomain` (= `<app base domain>`), `data.mode: "self_hosted"`, `data.tls: true` (null: Cloudflare couldn't list the certificates, and a `CERTIFICATES_UNKNOWN` warning says so; rerun status later), `data.certificates[]` each `ready`, `data.access` (`{ on, teamDomain }`; null on a hosted Gateway, before the first upload, or when cf couldn't list the Worker's settings, which adds an `ACCESS_UNKNOWN` warning), `data.apps[]` (one per registered app; its `setup` is null when the app declares nothing to set or isn't up yet, else `{ ready, settings, unmet, groups, command }`: `unmet` the settings that keep the app closed, each with `names`, `holder`, `need.kind` and its guide `setup`, `setup/<name>.md` in this folder; `command`, `everyapp configure <app id>`, null once `ready`), and `data.fixes` (each `{ code, severity, message, run, note?, fix? }`; `severity` is `error`, `warning`, `info` or `settling`) empty or only codes that don't mean the Gateway is unfinished: `CERT_PENDING`, `DEPLOY_RUNNING`, `CERTIFICATES_UNKNOWN`, `ACCESS_UNKNOWN`, `APP_BINDING` (an app settling, not the Gateway), `APP_NEEDS_SETUP` (`warning`, "<app> needs setup": that app's `setup.ready` is false; its `run` is `setup.command.command`, and the person's report prints `Guide: .claude/skills/everyapp/setup/<name>.md` under it: that integration's file, not this one), `SETTINGS_UNKNOWN` (`warning`: cf couldn't list a Worker's secrets, so the settings it holds read `set: null`, which never blocks; run status again) and `GATEWAY_OUTDATED` (`info`, listed last: "Your every-app folder has a newer Gateway than the one online"; its `run` is `everyapp update`, or the next new app's deploy brings it; the summary still says "nothing to fix", so go on). Fix codes that mean this file isn't done: `GATEWAY_NOT_INSTALLED`, `GATEWAY_NOT_UPLOADED`, `NO_OWNER` (run setup again), `CHECKOUT_BEHIND` (`git pull`, then `pnpm install`), `GATEWAY_CHANGED` and `BINDINGS_DIFFER` (setup repairs; the first asks at a terminal). The other `APP_*` and `EMAIL_*` codes belong to app deploys, not here. Every other setup file relies on this check.
2. `everyapp secret list --json` from the checkout root: `data.gateway.workerName` is `every-app-gateway` and `data.gateway.names` holds `GATEWAY_URL`, `CLOUDFLARE_ACCOUNT_ID`, `GATEWAY_DEPLOYMENT_MODE`, `BETTER_AUTH_SECRET`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`; `CF_DEPLOY_TOKEN` too after Step 9. From the root the event also carries `data.apps[]`, `{ id, setup }` for each deployed app that declares something (the same `setup` as status). One app's, from anywhere once it is deployed: `everyapp secret list <app id> --json`, whose `data.app.setup` is that `setup` and whose `data.gateway.needed` and `data.gateway.missing` still say the same of the Gateway's names (`APP_NOT_FOUND` before its first deploy: in its directory instead).
3. Smoke check, from your shell: `curl -sS -o /dev/null -w '%{http_code}\n' https://<gateway host>/` answers `200` (the page loads and the browser does the sign-in redirect; read from the code, not checked live) or a `3xx` to a `cloudflareaccess.com` page (Cloudflare Access is in front; setup's own probe reads it the same way), not a TLS or name error; `000` means DNS or the certificate isn't ready yet, give it ten minutes. `cf auth whoami` says `authenticated: true` with the person's email.
4. The person opens `https://<gateway host>`, signs in with the owner email and password, and `https://<gateway host>/admin` opens (Users, invitations, apps).
5. Logs: `cf` has no Worker tail (Cloudflare's cf↔wrangler reference: "cf cannot stream live logs yet"; live logs are `npx wrangler tail every-app-gateway`, and wrangler has its own one-time login the person approves). In the dashboard, README's path: **Workers & Pages** → `every-app-gateway` → **Observability** (**Logs** on older accounts) → **Live**; Workers Logs are on for the Gateway, so the same page keeps them. `everyapp status --json` is faster for everything setup touches.

## If it fails

| error or symptom | meaning | what to do |
| --- | --- | --- |
| `UNSUPPORTED_RUNTIME`, `NODE_TOO_OLD` | Node below 22.18.0, Bun, or a Volta/pnpm pin on an older Node | install Node 22.18.0 or newer (22, 24 or 26), open a new terminal, rerun; raise the pin |
| `cloudflare_login` repeats, `CLOUDFLARE_LOGIN_FAILED` | the device login wasn't approved within 5 minutes (cf's limit), or failed | `everyapp login --json` again, and hand the link and code over at once; a 403 managed challenge on a server: use `CLOUDFLARE_API_TOKEN` |
| `CLOUDFLARE_TOKEN_REJECTED` | `CLOUDFLARE_API_TOKEN` is set but mistyped, expired or short of permissions | fix the token (Step 5's list), or `unset CLOUDFLARE_API_TOKEN` and log in |
| `choose_account` | several accounts (or several Gateways) and no `--account-id` | ask the person; run the chosen `data.choices[].rerun` |
| `ACCOUNT_NOT_ACCESSIBLE`, `ACCOUNT_REQUIRED` | `--account-id` names an account this login can't use; a token lists none | pick an id from the message; the id is in the dashboard URL, `dash.cloudflare.com/<account id>/…` |
| `GATEWAY_NOT_FOUND` | the named account has no Gateway, or the login lists no accounts | drop `--account-id`/`CLOUDFLARE_ACCOUNT_ID`, log in to the right account, or run setup to install |
| `upgrade_workers_paid`, "Subscribe this account to Workers Paid" ("It's on the Free plan", or "Cloudflare refused the upload on the Free plan") | Free plan; nothing created | Step 2, rerun |
| `CF_EMAIL_UNVERIFIED` (Cloudflare API code 10034) | the account's email isn't verified, so Cloudflare creates nothing | the person opens `data.url` (https://dash.cloudflare.com/profile) and finishes Step 1; run `data.rerun` |
| `DOMAIN_REQUIRED` | setup ran unattended without `--domain` | one zone: run `data.rerun` (`--domain apps.<zone>`; another name under it works too); several: ask the person which `data.choices[].label`, run its `rerun` |
| `WORKERS_PAID_UNVERIFIED` (warning) | the subscription list didn't name the plan | ask the person to check **Billing** → **Subscriptions**; the run continues |
| `add_domain` "Add a domain" (no `--domain`), `ZONE_NOT_FOUND` | no domain in this account, or `--domain` isn't under one (wrong account?) | Step 3; check `cf auth whoami` shows the intended account |
| `add_domain` "Finish activating" | nameservers not switched yet | finish Step 3's nameserver change, wait for the active email |
| `DNS_RECORD_CONFLICT` | a record already answers `apps.<your domain>` | the person deletes it (domain → **DNS**) or picks another name; `--force-dns` only when they say so |
| `DNS_UNREADABLE` | the API token can't read the zone's DNS, so it can't tell whether a record is in the way | give the token Zone › DNS › Read, rerun; `--force-dns` only when they say so |
| `register_workers_subdomain` | first Worker in this account; the database and KV namespace exist already | open `data.url`, pick any name (no name field: **Workers & Pages** → **Change** next to **Your subdomain**), rerun: it resumes |
| `rerun_interactive` (`data.needsTerminal: true`) | the Gateway Worker serves a version everyapp didn't deploy | the person runs `data.rerun` in their own terminal and confirms; never rerun it yourself, with or without `--json` |
| `GATEWAY_OUTDATED` from `status` (`info`) | this checkout's Gateway is newer than the live one; nothing is broken | go on; `everyapp update` when the person wants it updated now |
| `DOMAIN_CHANGE_UNSUPPORTED` | the Gateway lives elsewhere; it can't move | rerun without `--domain` |
| `claim_owner` after 15 minutes | nobody opened the link | they open `data.setupUrl` now, or rerun for a new link |
| "Use the newer setup link", the page refuses the link | expired, or replaced by a later run (maybe on another machine) | rerun setup; use only the newest link |
| "Password must be at least 8 characters", "Passwords do not match" | the claim form's own checks | fix the fields, submit again |
| `GATEWAY_UNREACHABLE`, `CERT_PENDING`, `curl` answers `000` | certificate or DNS still on the way | wait up to ten minutes; the link works as soon as the host answers |
| `OWNER_NOT_CLAIMED` (warning, exit 0; `data.needsTerminal: true`) | `CI` is set, or output is piped without `--json`: no link is shown there | run setup at a terminal, or with `--json` from an agent on the person's machine |
| `SECRET_NOT_SETTABLE` | `secret set` on `GATEWAY_URL`, `JWT_*`, … | setup owns those; nothing to set |
| `SETTING_VALUE_INVALID` with `data.name` | `BROWSER_APP_INSTALLS` takes exactly `on` or `off` (a plain setting; nothing was written) | pipe the value `data.fix` describes |
| `SECRET_VALUE_REQUIRED`, `SECRET_SEVERAL_NAMES` | `secret set CF_DEPLOY_TOKEN --json` got no value, or a pipe with several names | one of README's three ways, one name per pipe |
| `CONFIRMATION_REQUIRED` | `secret unset … --json` without `--yes`: nothing was removed | ask the person; rerun with `--yes` only when they said so |
| `integration_not_configured`, `ai_provider_not_configured` from an app | the Gateway is fine; that integration's setting isn't set | the integration's own file in this folder |
| an app's host answers 503 `app_needs_setup`, or a browser lands on `https://<gateway host>/?setup=<app id>` | the Gateway keeps an app closed until its required settings are set; `status` names them under `APP_NEEDS_SETUP` | the file its `Guide:` line names |

## Rerun, rotate, remove

- Rerun `everyapp setup --domain apps.<your domain> --json` any time: it logs in, finds the Gateway, upgrades it after a `git pull` (`everyapp update --json` does only that), repairs bindings and hostnames, mints a new owner link while there is no owner, and otherwise ends "up to date" (`data.gateway: "up-to-date"`). `--domain` can be left off once installed; the address and the mode can't change.
- Rotate the Cloudflare login: `cf auth logout`, then `everyapp login --json`. The owner's password: **Forgot password?** on the sign-in page when the Gateway sends email, else an admin's **Users** → **⋯** → **Password reset link** (valid an hour). The Gateway's own keys: docs/runbooks/key-rotation.md: a new pair in the dashboard, the public key recorded in the install row, `setup --redeploy` at a terminal, then `everyapp deploy` from every app's directory (apps keep the old key and answer 401 until then). `CF_DEPLOY_TOKEN`: roll the token at https://dash.cloudflare.com/profile/api-tokens (**⋯** → **Roll** → **Confirm**: same permissions, new secret, the old one stops at once), then set the new value one of the three ways; or create a new token, set it, then delete the old one.
- Remove browser installs: `everyapp secret unset CF_DEPLOY_TOKEN --json` (under `--json` it needs `--yes`, else `CONFIRMATION_REQUIRED`; add it only when the person said so), then delete the token in the dashboard; or keep the token and turn installs off: `BROWSER_APP_INSTALLS=off everyapp secret set BROWSER_APP_INSTALLS --from-env BROWSER_APP_INSTALLS --json` (`off` is a toggle, not a secret: the one value this folder puts on a command line, as docs/runbooks/browser-app-install.md does). Removing the Gateway itself is the person's, in the dashboard, and never yours to start (`delete` removes an app; `teardown` empties a dedicated test account the person names, never one in use: SKILL.md "Wipe"). Setup finds a Gateway only by its D1 database `every-app-gateway`: while that database exists, a rerun repairs the Gateway it describes (a Worker deleted by hand comes back at the same address); once it is gone, setup installs fresh, asking first when a Worker `every-app-gateway` is still in the account ("Replace it with <version>?"; unattended, `rerun_interactive`).

## Optional: MCP servers worth having beside EveryApp

Not part of setup, and never added by you unasked. Two are worth adding;
nothing else is. When the person's task needs one, offer it in one line
("Cloudflare's MCP server would let me read this account's DNS and Access
settings from here. Add it to Claude Code?") and do nothing until they say
yes.

**The Gateway's own connector, first.** `https://<gateway host>/mcp` is
every app the person can open, as tools, behind the Gateway's sign-in and
consent; [mcp.md](../mcp.md) has the commands per client. Every member can
have it. The one below is for the owner or operator, the person whose
Cloudflare login ran `everyapp setup`.

**Cloudflare's MCP server, `https://mcp.cloudflare.com/mcp`.** The whole
Cloudflare API and its docs behind four tools: `search` and `execute` (the
agent writes JavaScript against the API; it runs on Cloudflare's side),
`docs` and `whoami`. Connecting opens Cloudflare's login and a consent
page: choose **Minimal**; a call that needs more asks for that scope then
(step-up, since 2026-10-19). It then acts as that person on every account
their login reaches.

- Good for, with a Gateway: reading the account the Gateway runs in when
  `everyapp status` and `everyapp access show` don't answer the
  question. The zone and its DNS records (`<gateway host>` and one
  `<app>.<app base domain>` per app, each a Workers Custom Domain with its
  own record), the Workers (`every-app-gateway` and each app's) with their
  versions, the D1 database `every-app-gateway`, the Access team,
  applications and policies that `everyapp access on` made, Email
  Routing, Workers logs, the plan and the bill. "Which version is serving",
  "is the DNS record there", "why does this app host 503", "who does the
  Access policy let in", "what did October cost".
- Noise for: building and deploying. `everyapp setup`, `deploy`,
  `update`, `install`, `secret set`, `access on`, `email` and `mcp on`
  write the Gateway's registry and the deploy ledger as well as Cloudflare,
  and a deploy refuses to replace a Worker last changed outside everyapp
  (`assertReplaceable` in `packages/cli/src/lib/cf/deploy.ts`: the next
  `everyapp deploy` stops and asks a person to confirm in a
  terminal). A Worker, secret, DNS record or Access policy changed through
  this server is one `everyapp` doesn't know about. Look with it; change
  with `everyapp`.
- The rule: read before write. A write through it is a live API call on
  the whole account, as the person, with no undo. It goes in the person's
  own client config (Claude Code's default `local` scope or `--scope user`,
  `~/.cursor/mcp.json`, `~/.codex/config.toml`), never in one the
  repository shares (`.mcp.json` from `--scope project`, `.cursor/mcp.json`,
  `.codex/config.toml`), where every clone would be offered the account.

When they say yes, by client. The sign-in is the person's step every time:
the consent page is theirs, never yours.

- Claude Code. You may run it:

  ```bash
  claude mcp add --transport http cloudflare https://mcp.cloudflare.com/mcp
  ```

  Then the person types `/mcp` in Claude Code, chooses **cloudflare**,
  **Authenticate**, and allows in the browser.
- Codex. You run `codex mcp add cloudflare --url https://mcp.cloudflare.com/mcp`;
  the person runs `codex mcp login cloudflare` in their own terminal.
- claude.ai and Claude Desktop: **Settings** → **Connectors** → **Add
  custom connector**, the URL above.
- Cursor: in `~/.cursor/mcp.json`,
  `{ "mcpServers": { "cloudflare": { "url": "https://mcp.cloudflare.com/mcp" } } }`,
  then sign in when Cursor asks.

Removing it: `claude mcp remove cloudflare`, `codex mcp remove cloudflare`,
or delete the entry.

**GitHub.** `everyapp install <github url>` downloads a public release
anonymously and needs no GitHub access. For what surrounds an app's
repository (which release, its README, an issue, the Actions runs of the
starter's `security-review.yml`), a harness with a shell has `gh`; in
claude.ai, turn on the GitHub connector (**Settings** → **Connectors**).
Nothing to add.

**Not worth adding.** Cloudflare's separate docs server
(`https://docs.mcp.cloudflare.com/mcp`): the API server's `docs` tool is
the same search. A docs server for EveryApp: none; the agent docs are
Markdown at `https://everyapp.com/docs/agent/<page>.md` and
https://everyapp.com/llms.txt, which any client reads without MCP.

## Sources

Verified 2026-10-23; CLI shapes re-checked after #400, #401 and #410 merged; `data.apps[].setup`, `APP_NEEDS_SETUP`, `SETTINGS_UNKNOWN` and `secret list <app id>` after #383, #395, #396 and #397 (2026-10-24). The agent docs' version of this page: landing-page/content/agent/setup.md in the checkout, served at https://everyapp.com/docs/agent/setup.md once the site deploys with the launch.

- Plans and prices: https://developers.cloudflare.com/workers/platform/pricing/, https://developers.cloudflare.com/d1/platform/pricing/, https://developers.cloudflare.com/registrar/faq/ (at cost), https://costgoat.com/pricing/cloudflare-domains (third party, 2026-10-20)
- Account, billing, domains: https://developers.cloudflare.com/fundamentals/account/create-account/, https://developers.cloudflare.com/fundamentals/user-profiles/verify-email-address/, https://developers.cloudflare.com/fundamentals/subscriptions-and-billing/create-billing-profile/, https://developers.cloudflare.com/registrar/get-started/register-domain/, https://developers.cloudflare.com/fundamentals/manage-domains/add-site/
- `cf` and tokens: https://developers.cloudflare.com/cf/get-started/, https://developers.cloudflare.com/cf/ci/, cf 1.0.0-beta.14's source (`Math.min(expires_in, 300)`: the 5-minute login), https://github.com/cloudflare/cf/issues/23 (the 403 from datacenter IPs), https://developers.cloudflare.com/api/resources/zones/methods/list/ and https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (Zone Read and DNS Read are distinct), https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/
- workers.dev, logs, Node: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/, https://github.com/cloudflare/workers-sdk/issues/9045, https://developers.cloudflare.com/workers/observability/logs/workers-logs/, https://developers.cloudflare.com/cf/wrangler/reference/, https://nodejs.org/en/about/previous-releases
- The four apps (Step 11), verified 2026-10-25: landing-page/content/docs/setup-prompt.txt (step 4 and its "Only I can" list; #595, #607), docs/runbooks/app-releases.md (#611: `pnpm pack-for-app`, the Release workflow, which apps bind R2), landing-page/content/agent/deploy.md ("Release installs") and landing-page/content/agent/errors.md (`NO_RELEASE`, `R2_NOT_ENABLED`), packages/cli/src/commands/install/index.ts, packages/cli/src/lib/app/release.ts, packages/cli/src/lib/app/buckets.ts, https://developers.cloudflare.com/r2/get-started/ (the dashboard link)
- In this repository: packages/cli/src/commands/setup/{runSetup,deployGateway,index,command}.ts, commands/status/{index,problems,render}.ts, lib/app/settings.ts and packages/sdk/src/internal/appSettings.ts (the settings model), apps/every-app-gateway/src/server/app-needs-setup.ts (the closed app), commands/update/command.ts, commands/secret/index.ts, commands/configure/index.ts, commands/email/index.ts, lib/cf/{account,plan,deploy,errors}.ts, lib/domains/{preflight,zones}.ts, lib/gateway/{discover,connect,setup-link,apply,resources}.ts, lib/access/settings.ts, lib/errors.ts, lib/output/{events,report,command}.ts, lib/runtime.ts, apps/every-app-gateway/src/routes/{__root,setup}.tsx, docs/runbooks/{key-rotation,browser-app-install}.md, landing-page/content/docs/{cloudflare,domain,gateway,troubleshooting}.mdx
