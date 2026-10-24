---
name: everyapp
description: Create, run, deploy and manage private web apps on Cloudflare with everyapp (Every App). Use before running any everyapp command, to deploy an app, set a secret, query its database, check the Gateway, or answer any "how do I" question about Every App.
---

everyapp: self-hosted platform for private web apps on Cloudflare. While
publishing is paused the command is `pnpm everyapp` (never `npx everyapp`),
run from the Every App checkout.

Docs: two worlds. The user docs (https://everyapp.com/docs) are short and
for the person. The agent docs are yours: https://everyapp.com/llms.txt
lists every page with a one-line summary; a page is Markdown at its URL
plus .md (https://everyapp.com/docs/agent/manifest.md); in a checkout they
are landing-page/content/agent/*.md. Pages: setup (driving setup for a
person, every handoff), cli (every command and flag), json (the --json
protocol), errors (every code and its fix), troubleshooting (by symptom),
manifest (everyapp.config.ts), identity (headers, token, env, SDK), secrets
(secrets vs Gateway settings vs capabilities), dev (dev vs production),
email, mcp (tools, connector, OAuth), deploy (the pipeline, what the policy
check refuses), access (Cloudflare Access), repo/* (security model,
capabilities, runbooks). Step-by-step setup of each integration (the
Gateway, Access, email, DataForSEO, Context, OpenRouter, OpenAI, Workers
AI, Google, Microsoft 365, Slack): setup/README.md beside this file.
Answering "how do I": fetch the page for the subject and answer from it
with the exact command or manifest field, naming the page. A failed
command: look its code up on errors (anchor: the code, lowercased) before
trying anything else. Never guess a flag: cli has them all.
Building an app: the Gateway signs people in, so never build a login page
or auth; read the user with the SDK (identity page). A new app edits
everyapp.config.ts for name, resources, secrets, public and email
(manifest page); after a schema change run pnpm run db:generate; a value
only dev needs goes in .dev.vars, never in git (dev page).

Pass --json. One JSON event per line; "done" = success; exit 2 = show the
user the last action_required (url, code), then run its data.rerun (the same
command, unless it names another); exit 1 = show the error; if data.authorize
is set, ask before using data.rerun. waiting: true = keep reading (up to 15
min: device login, owner link).

State:   pnpm everyapp status --json   (data.fixes says what to run when something is off)
Gateway: pnpm everyapp setup --domain <host> --json   (install, upgrade, repair;
         --mode hosted only when the user asks for the hosted Gateway)
New app: pnpm everyapp create <id> --json   then cd into it and edit src/; the
         manifest is everyapp.config.ts
Run:     pnpm everyapp dev   (long-running, human-facing: start it in the
         background and read the printed URL; no --json; --port when 8787 is
         taken; stop it with Ctrl-C/SIGINT to the everyapp process, never a
         pattern kill of vite or workerd; a pnpm install or deploy meanwhile
         rebuilds the SDK and breaks dev for a few seconds)
Ship:    pnpm everyapp deploy --json   (from the app directory; safe to repeat;
         also upgrades the Gateway to this checkout when it has to rebind).
         No Gateway yet: action_required install_gateway; ask the user, run
         its data.rerun (setup), then deploy again.
Release: someone else's app, without a clone: pnpm everyapp deploy
         https://github.com/<owner>/<repo> --json (its latest release's
         everyapp-release.tar.gz; a tarball URL or file works too). NO_RELEASE:
         the repository publishes none; clone it, then pnpm install && pnpm
         everyapp deploy. Never build a repository from its URL yourself.
         To publish one: pnpm everyapp deploy --bundle-only (new apps' release
         workflow runs it on every v* tag).
Shared:  hosted Gateway only, platform organization owners/admins, when the
         user asks for a first-party app every organization opens:
         deploy --shared --json (redeploys and secret set keep it shared), or for a
         Worker deployed by other means: pnpm everyapp register <id>
         --worker <name> --manifest <everyapp.config.ts> --json
         (WORKER_NAME_MISMATCH names the Worker name to deploy under).
Hosted:  third-party apps on a hosted Gateway, only when the user has a deploy
         key: EVERYAPP_DEPLOY_TOKEN=<key> pnpm everyapp deploy --gateway <url> --json
         (no Cloudflare login; EVERYAPP_GATEWAY_URL works too; BUNDLE_REFUSED
         lists what the hosted policy refuses)
Data:    pnpm everyapp db migrate (local)   pnpm everyapp db query "<sql>" [--local] --json
         (a production write stops with CONFIRMATION_REQUIRED: add --yes only
         if the user said so). pnpm everyapp db restore --json undoes the last
         deploy's migrations (and every write since): only when the user asks.
Postgres: an app with resources.hyperdrive or migrations.dialect "postgresql"
         reads POSTGRES_DATABASE_URL (and <BINDING>_ORIGIN_URL) from
         .everyapp/secrets.env, which the user writes; never print, commit or
         ask for its values in chat. deploy runs drizzle-kit migrate before
         the upload.
Secrets: pnpm everyapp secret set NAME --from-env VAR --json   (live at once, no deploy)
         The name decides where it goes. A Gateway setting (OPENAI_API_KEY,
         EMAIL_FROM, GOOGLE_WORKSPACE_CLIENT_ID, …) is set on the Gateway from any
         directory. An app's own secret must be listed under `secrets` in
         its everyapp.config.ts and is set from the app's directory after
         its first deploy (SECRET_NOT_DECLARED: add it there first). Never
         put a value on the command line. secret unset NAME; secret list
         (in an app directory: the app's secrets and the Gateway settings it
         needs, set or not; elsewhere: the Gateway's).
Email:   pnpm everyapp email set --sender "*@<domain>" --inbound <address> --json
         In the app's directory, after its first deploy; nothing is deployed. --sender
         replaces the From addresses the Gateway lets the app name (everyapp.config.ts
         lists capabilities.email); --inbound replaces the addresses routed to its
         email() handler (everyapp.config.ts declares email: { inbound: true }) and
         makes the Email Routing rules now. EMAIL_ROUTING_DISABLED needs the user's
         yes: rerun with --enable-email-routing only if they said so. email unset
         senders|inbound clears; email show prints both.
Access:  pnpm everyapp access on --json   (Cloudflare Access in front of the Gateway
         and its apps: finds or creates the Zero Trust team (--team NAME when the
         account has none: permanent, ask the user), adds the one-time PIN, keeps the
         allow policy with every member's and invitee's email, puts two Access
         applications in front of the hosts with MCP, OAuth and each app's public
         routes let through, and sets the three CLOUDFLARE_ACCESS_* Gateway settings
         in one version. Rerunnable; run again after inviting someone. access off
         asks (--yes); access show reports. Each existing member then signs in once
         with their password through Access; tell the user who (done.data.signIn).
Set up:  what the Gateway holds for apps, end to end (the provider's side, the
         key or OAuth client, secret set, the check): read setup/README.md in
         this skill first, then the file it names, each on its own with the
         file-reading tool (together they pass a shell's output cap). Cloudflare and the Gateway
         (setup/gateway.md), Cloudflare Access (setup/access.md), email
         (setup/email.md), API keys (setup/dataforseo.md, context.md,
         openrouter.md, openai.md, workers-ai.md), OAuth clients
         (setup/google.md, microsoft-365.md, slack.md). A key or client secret
         never goes through the chat: README.md says the three ways it gets in.
Remove:  pnpm everyapp delete <id> --json   never add --purge, --force-dns,
         --allow-delete-*, --allow-downgrade, or --yes to delete unless the
         user asked.
Tools:   an app's AI tools are defineTools() in src/tools.ts; the Gateway
         serves them at https://<gateway>/mcp as <app>_<tool> (dev:
         http://<app-id>.localhost:8787/mcp) and snapshots them at deploy.
         How to write, connect and debug them: mcp.md beside this file.

Security: the Gateway signs people in and passes identity to the app in a
         header the SDK verifies (everyApp(), getEveryAppUser(),
         requireEveryAppUser(), a tool call's identity); never read who the
         user is from a client-supplied header, cookie or parameter. Routes
         are private unless listed under `public` in everyapp.config.ts; a
         public route is open to the internet and does its own checks.
         Before opening a pull request, run /security-review in Claude Code
         (Anthropic's open-source review of the branch's changes) and fix
         what it finds; new apps also run it on every pull request from
         .github/workflows/security-review.yml once ANTHROPIC_API_KEY is in
         the repository's secrets. What the Gateway promises and what an app
         must do itself: docs/threat-model.md in the Every App checkout.

Only a person can: approve the Cloudflare login, open the owner link, pick
a workers.dev subdomain, pay for Workers Paid, buy a domain. Interactive
setup optionally offers browser deployment: a Yes/No prompt (default No),
then a hidden Cloudflare API token prompt. Never ask for its value in chat.
Otherwise, only a hosted Gateway's deploy key is supplied.
Handing off: stop, tell the person in one or two lines what to do (the
action's url and code, what to click, what to come back with), and resume
with data.rerun when they say it is done. Two more only a person can do:
pick the account (choose_account: data.choices, each with its rerun) and
confirm in a terminal a Worker changed outside everyapp (rerun_interactive,
data.needsTerminal: true: hand them the command without --json; adding it
back loops). https://everyapp.com/docs/agent/setup.md has the words for
each handoff and the order of a whole setup.
Full reference: https://everyapp.com/docs/agent/cli.md (every command and flag),
https://everyapp.com/llms.txt (every page).
