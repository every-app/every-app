---
name: everyapp
description: Create, run, deploy and manage private web apps on Cloudflare with everyapp (Every App). Use before running any everyapp command, to deploy an app, set a secret, query its database, check the Gateway, or answer any "how do I" question about Every App.
---

everyapp: self-hosted platform for private web apps on Cloudflare. While
publishing is paused the command is `pnpm everyapp` (never `npx everyapp`),
run from the Every App checkout or from an app's directory (its package.json
links the CLI).

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
or auth; read the user with the SDK (identity page), and scope every query
by user.id: the Gateway admits every member of the organization. A new app
edits everyapp.config.ts for name, resources, public, providers,
capabilities, secrets and email (manifest page), and the Gateway gives it
nothing it doesn't declare there. AI: list the provider, providers:
["openai"] (or openrouter, workers-ai), and call it with the SDK's
createGatewayFetch({ env, for: request }), a fetch for
http://every-app-gateway.internal/api/ai/<provider>/... (an OpenAI client
takes it as fetch, with http://every-app-gateway.internal/api/ai/openai/v1
as baseURL; the other two base URLs and the code are on the identity
page); the Gateway holds the key, never the app, and a provider the
manifest doesn't list is refused provider_not_allowed 403. A capability
(members, email, an OAuth client, DataForSEO) is listed under
capabilities with access and a why and called with listMembers(),
sendEmail() or integrationFetch() (secrets page); an OAuth client with
scope sets (google-workspace, microsoft-365, slack) is listed with
scopes: [...] and held to them; after a schema change run pnpm run
db:generate; a value only dev needs goes in .dev.vars, never in git (dev
page). The way back: the first row of the app's sidebar (or of its page
header when it has no sidebar) is a muted "‹ Every App" link to
GATEWAY_URL (aria-label "Back to Every App"), above the app's own name,
so every app on the Gateway reads the same; put nothing else about the
Gateway in the footer.

Pass --json. One JSON event per line; "done" = success; exit 2 = show the
user the last action_required (url, code), then run its data.rerun (the same
command, unless it names another); exit 1 = show the error; if data.authorize
is set, ask before using data.rerun. waiting: true = keep reading (5 min
for the device login, up to 15 for the owner link).

State:   pnpm everyapp status --json   (data.fixes says what to run when something is off;
         data.apps[].setup says what each app needs set: ready, settings, unmet
         (each with why and docs), and command, the one secret set that opens it)
Gateway: pnpm everyapp setup --domain <host> --json   (install, upgrade, repair;
         a fresh install runs 5-20 min: build, certificate, then up to 15 min
         waiting for the owner link, so give it a long timeout or background
         it and keep reading; run data.rerun as given (a needsTerminal rerun
         goes to the person))
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
         its data.rerun (setup), then deploy again. done.data.publicRoutes
         lists the routes the manifest opens to the internet without
         sign-in; tell the person which.
Release: someone else's app, without a clone: pnpm everyapp install
         https://github.com/<owner>/<repo> --json (its latest release's
         everyapp-release.tar.gz; a tarball URL or file works too). NO_RELEASE:
         the repository publishes none; clone it, then pnpm install && pnpm
         everyapp deploy. Never build a repository from its URL yourself.
         To publish one: pnpm everyapp release, then attach the
         tarball to a GitHub release of the app's repository.
Data:    pnpm everyapp db migrate (local)   pnpm everyapp db query "<sql>" [--local] --json
         (a production write stops with CONFIRMATION_REQUIRED: add --yes only
         if the user said so). pnpm everyapp db restore --json undoes the last
         deploy's migrations (and every write since): only when the user asks.
Postgres: an app with resources.hyperdrive or migrations.dialect "postgresql"
         reads POSTGRES_DATABASE_URL (and <BINDING>_ORIGIN_URL) from
         .everyapp/secrets.env, which the user writes; never print, commit or
         ask for its values in chat. deploy runs drizzle-kit migrate before
         the upload.
Secrets: pnpm everyapp secret set NAME... [--app <id>] --json   (live at once, no deploy;
         the value from a hidden prompt, stdin, or --from-env VAR, never the command line)
         The name decides where it goes. A Gateway setting (OPENAI_API_KEY,
         EMAIL_FROM, GOOGLE_WORKSPACE_CLIENT_ID, …) is set on the Gateway from any
         directory. An app's own secret must be listed under `secrets` in
         its everyapp.config.ts and is set after its first deploy, from the
         app's directory or from anywhere with --app <id> (SECRET_NOT_DECLARED:
         add it there first). secret unset NAME [--app <id>]; secret list [<app>]
         --json (one app's settings, where each is held and whether it is set,
         with data.app.setup; elsewhere with no app named: the Gateway's names
         and every app's settings).
Needs setup: read data.apps[].setup; for each unmet setting show its why and docs
         and read its setup guide (.claude/skills/everyapp/<setup>); get the value
         in without it passing through the chat: tell the person to run
         `pnpm everyapp secret set <names>` in their own terminal (hidden prompt)
         and say when done; or pipe a value that came from a command or a file
         straight in; or --from-env VAR only for a variable the person exported
         before starting the agent. Never ask for, print or repeat a value; never
         invent one. An app whose setup.ready is false doesn't open (status shows
         "needs setup"; deploy warns APP_NEEDS_SETUP and puts the command under
         next); an any-of group (setup.groups) needs one member set, not all.
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
Providers: pnpm everyapp provider on dataforseo --json   offers a data provider's
         tools (dataforseo_<tool>) to members' AI clients through the Gateway's
         /mcp with the Gateway's key (DATAFORSEO_API_KEY, setup/dataforseo.md);
         nothing to deploy. provider list shows on/off and whether the key is
         set; provider off <id> removes it. You, owners and admins get it;
         others are granted in Admin → Apps → Manage access. An owner or admin
         caps an app's provider calls per month in Admin → Usage (off by
         default): past it a provider tool answers a tool error naming the
         cap, and an app's brokered call gets 429 app_monthly_cap_exceeded
         until the next UTC month.
Tools:   an app's AI tools are defineTools() in src/tools.ts; the Gateway
         serves them at https://<gateway>/mcp as <app>_<tool> (dev:
         http://<app-id>.localhost:8787/mcp) and snapshots them at deploy.
         How to write, connect and debug them: mcp.md beside this file.
Wipe:    pnpm everyapp teardown --account-id <id> --dry-run --json   deletes
         EVERYTHING Every App made in one Cloudflare account (the Gateway too):
         only on a dedicated test account the user names, never one they use.
         Always --dry-run --json first and show the user data.plan. It needs
         EVERYAPP_TEST_ACCOUNTS=<id> and CLOUDFLARE_API_TOKEN scoped to that
         account in the environment, which the user sets. Without --confirm it
         stops with TEARDOWN_CONFIRMATION_REQUIRED (authorize): never add
         --confirm <id> unless the user explicitly asked for the deletion.

Security: the Gateway signs people in and passes identity to the app in a
         header the SDK verifies (everyApp(), getEveryAppUser(),
         requireEveryAppUser(), a tool call's identity); never read who the
         user is from a client-supplied header, cookie or parameter. Routes
         are private unless listed under `public` in everyapp.config.ts; a
         public route is open to the internet and does its own checks.
         Before opening a pull request, run /security-review in Claude Code
         (Anthropic's open-source review of the branch's changes) and fix
         what it finds; an app that is the root of its own GitHub repository
         (what create makes outside the checkout) also runs it on every pull
         request from .github/workflows/security-review.yml once
         ANTHROPIC_API_KEY is in that repository's secrets; inside the
         checkout GitHub reads no workflow from apps/<name>, and the
         checkout's own workflow reviews pull requests to the checkout's
         repository once you have a fork or remote of your own, with the
         same key in its secrets. What the Gateway promises and what an app
         must do itself: docs/threat-model.md in the Every App checkout.

Only a person can: approve the Cloudflare login, open the owner link, pick
a workers.dev subdomain, pay for Workers Paid, buy a domain. Interactive
setup optionally offers browser deployment: a Yes/No prompt (default No),
then a hidden Cloudflare API token prompt. Never ask for its value in chat.
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
