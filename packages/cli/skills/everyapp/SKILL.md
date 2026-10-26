---
name: everyapp
description: Create, run, deploy and manage private web apps on Cloudflare with everyapp (EveryApp). Use before running any everyapp command, to deploy an app, set a secret, query its database, check the Gateway, or answer any "how do I" question about EveryApp.
---

everyapp: self-hosted platform for private web apps on Cloudflare. While
publishing is paused the command is `pnpm everyapp` (never `npx everyapp`),
run from the EveryApp checkout or from an app's directory (its package.json
links the CLI).

Docs: two worlds. The user docs (https://everyapp.com/docs) are short and
for the person. The agent docs are yours: https://everyapp.com/llms.txt
lists every page with a one-line summary; a page is Markdown at its URL
plus .md (https://everyapp.com/docs/agent/manifest.md); in a checkout they
are landing-page/content/agent/*.md. Pages: setup (driving setup for a
person, every handoff), apps (the open apps: each one's id, repository,
install command, every setting and whether it needs R2), cli (every
command and flag), json (the --json
protocol), errors (every code and its fix), troubleshooting (by symptom),
status (the report, every line, and its fixes in order), manifest
(everyapp.config.ts), identity (headers, token, env, SDK), secrets
(secrets vs Gateway settings vs capabilities), dev (dev vs production),
email, events (webhooks, email alerts, the signature, every event type,
emit()), mcp (tools, connector, OAuth), deploy (the pipeline, what the policy
check refuses), providers (API providers: the catalog, registering one,
a spec's fields), access (Cloudflare Access), signin (sign-in providers:
Continue with Google, Microsoft, GitHub, Apple, Cloudflare or SSO; every
setting, the signin commands), ai (the Gateway's default model
provider: the order, `ai default|show|list`, AI Gateway in front, what an
app writes), workspace (the workspace from
the terminal and from an AI client: every command and every tool), gateway
(everything a Gateway offers: apps vs MCP apps vs the compact MCP surface,
people, groups and caps, the CLI by job, what to suggest next, other MCP
servers), build (the build-every-app skill as a page), patterns (its
example-patterns index), repo/* (security model, capabilities, runbooks).
Step-by-step setup of each
integration (the Gateway, Access, email, DataForSEO, Context, OpenRouter,
OpenAI, Workers AI, the default model provider (setup/ai.md) and Cloudflare
AI Gateway (setup/ai-gateway.md), Google, Microsoft 365, Slack; every
catalog provider by id in setup/providers.md): setup/README.md beside this
file.
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
createGatewayFetch({ env }), a fetch for
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
header when it has no sidebar) is a muted "‹ EveryApp" link to
GATEWAY_URL (aria-label "Back to EveryApp"), above the app's own name,
so every app on the Gateway reads the same; put nothing else about the
Gateway in the footer.

Pass --json. One JSON event per line; "done" = success; exit 2 = show the
user the last action_required (url, code), then run its data.rerun (the same
command, unless it names another); exit 1 = show the error; if data.authorize
is set, ask before using data.rerun. waiting: true = keep reading (5 min
for the device login, up to 15 for the owner link).

State:   pnpm everyapp status --json   (data.fixes says what to run when something is off;
         data.next says what to do next: at most four { code, command | url, note, why }
         from the Gateway's state, never repeating a fix; tell the person
         each why and offer the command or page; data.apps[].setup says what each
         app needs set: ready, settings, unmet (each with why and docs), and
         command, pnpm everyapp configure <app>)
Gateway: pnpm everyapp setup --domain <host> --json   (install, upgrade, repair;
         a fresh install runs 5-20 min: build, certificate, then up to 15 min
         waiting for the owner link, so give it a long timeout or background
         it and keep reading; run data.rerun as given (a needsTerminal rerun
         goes to the person))
New app: pnpm everyapp create ../<id> --json   (from the every-app folder: the
         app is its own repository beside it, on the published SDK and CLI
         from npm; a bare <id> makes apps/<id> inside the checkout instead) then cd into it and
         edit src/; the manifest is everyapp.config.ts
Run:     pnpm everyapp dev   (long-running, human-facing: start it in the
         background and read the printed URL; no --json; --port when 8787 is
         taken; stop it with Ctrl-C/SIGINT to the everyapp process, never a
         pattern kill of vite or workerd; a pnpm install or deploy meanwhile
         rebuilds the SDK and breaks dev for a few seconds)
Ship:    pnpm everyapp deploy --json   (from the app directory; safe to repeat;
         never changes the Gateway's code; GATEWAY_RELEASE_UNAVAILABLE says
         to run update first).
         No Gateway yet: action_required install_gateway; ask the user, run
         its data.rerun (setup), then deploy again. done.data.publicRoutes
         lists the routes the manifest opens to the internet without
         sign-in; tell the person which.
Release: someone else's app, without a clone: pnpm everyapp install
         https://github.com/<owner>/<repo> --json (its latest release's
         everyapp-release.tar.gz; a tarball URL or file works too). NO_RELEASE:
         the repository publishes none; clone it, pnpm install in it, then
         this checkout's pnpm everyapp deploy from its directory. Never
         build a repository from its URL yourself.
         To publish one: pnpm everyapp release, then attach the
         tarball to a GitHub release of the app's repository, or give
         the repository the Release workflow that does it on every push
         (pnpm pack-for-app <app> --workflow from this checkout;
         docs/runbooks/app-releases.md).
Data:    pnpm everyapp db migrate (local)   pnpm everyapp db query "<sql>" [--local] --json
         (a production write stops with CONFIRMATION_REQUIRED: add --yes only
         if the user said so). pnpm everyapp db restore --json undoes the last
         deploy's migrations (and every write since): only when the user asks.
Skills:  pnpm everyapp skills update --json   (from the app directory: replaces
         its .agents/skills and .claude/skills copies of everyapp and
         build-every-app with the ones this CLI ships, adds a missing one, leaves
         other skills alone; done.data.changes lists each copy's files)
Postgres: any Postgres with a URL (Neon, Supabase, …) goes through Hyperdrive:
         resources.hyperdrive, database.provider "postgres", migrations.dialect
         "postgresql" (manifest page, #postgres). The deploy reads
         POSTGRES_DATABASE_URL (and <BINDING>_ORIGIN_URL) from
         .everyapp/secrets.env, which the user writes (configure doesn't);
         never print, commit or ask for its values in chat. Without it deploy
         stops HYPERDRIVE_ORIGIN_MISSING (data.variables, data.file) and status
         names it under the app. deploy runs drizzle-kit migrate before the
         upload. Turso is libSQL: app secrets, not Hyperdrive.
Secrets: pnpm everyapp configure <app> --json   sets up an app: every setting its
         manifest declares, each where it is held (an AI key or a capability's
         client on the Gateway, once for every app; the app's own secrets on
         its Worker, after its first deploy); live at once, no deploy. At a
         terminal it shows what is set (names only), asks for each required
         setting that isn't with a hidden prompt (why, where to get it and its
         guide above), which member of an any-of group, then offers the
         optional ones; from you (no prompt): NAME=value lines on stdin (one
         per line, from a command's output) or --from-env (each unset
         setting from the variable of its own name; stdin isn't read then).
         A value never goes on the command line (VALUE_ON_COMMAND_LINE). One
         name at a time: pnpm everyapp secret set NAME [--app <id>] --json
         (the value from a hidden prompt, stdin, or --from-env VAR). The name
         decides where it goes. A Gateway setting (OPENAI_API_KEY, EMAIL_FROM,
         GOOGLE_WORKSPACE_CLIENT_ID, …) is set on the Gateway from any
         directory. An app's own secret must be listed under `secrets` in its
         everyapp.config.ts and is set after its first deploy, from the app's
         directory or from anywhere with --app <id> (SECRET_NOT_DECLARED: add
         it there first). secret unset NAME [--app <id>]; secret list [<app>]
         --json (one app's settings, where each is held and whether it is set,
         with data.app.setup; elsewhere with no app named: the Gateway's names
         and every app's settings).
Needs setup: read data.apps[].setup; for each unmet setting show its why and docs
         and read its setup guide (.claude/skills/everyapp/<setup>); then run
         setup.command, pnpm everyapp configure <app>, without a value passing
         through the chat: tell the person to run it in their own terminal (it
         asks for each setting with a hidden prompt and says where to get it)
         and say when done; or drive it yourself, --json always: NAME=value
         lines on stdin from a command's output, or --from-env for variables
         the person exported before starting you. Never a value on the command
         line; never ask for, print, repeat or invent a value. An app whose
         setup.ready is false doesn't open (status shows "needs setup"; deploy
         warns APP_NEEDS_SETUP and puts the command under next); an any-of
         group (setup.groups) needs one member set, not all: configure asks
         which.
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
         account has none: permanent, ask the user), keeps both sign-in methods
         (Sign in with Cloudflare for the account's members, the one-time PIN for
         everyone else), keeps the allow policy with every member's and invitee's
         email, puts two Access applications in front of the hosts with the
         Gateway's MCP, OAuth and /health and each app's public routes let through
         (an app host's /mcp only where its manifest sets mcp), and sets the three
         CLOUDFLARE_ACCESS_* Gateway settings in one version. Rerunnable; run again
         after inviting someone. access off asks (--yes); access show reports. Each
         existing member then signs in once with their password through Access;
         tell the user who (done.data.signIn).
Set up:  what the Gateway holds for apps, end to end (the provider's side, the
         key or OAuth client, configure or secret set, the check): read
         setup/README.md in this skill first, then the file it names, each on
         its own with the file-reading tool (together they pass a shell's
         output cap). Cloudflare and the Gateway
         (setup/gateway.md), Cloudflare Access (setup/access.md), email
         (setup/email.md), API keys (setup/dataforseo.md, context.md,
         openrouter.md, openai.md, workers-ai.md), OAuth clients
         (setup/google.md, microsoft-365.md, slack.md), any other catalog
         provider (setup/providers.md#<id>, generated from the catalog); a
         provider registered on the Gateway has no file: pnpm everyapp
         provider show <id> prints its spec. A key or client secret
         never goes through the chat: README.md says the three ways it gets in.
Remove:  pnpm everyapp delete <id> --json   never add --purge, --force-dns,
         --allow-delete-*, --allow-downgrade, or --yes to delete unless the
         user asked.
MCP apps: pnpm everyapp mcp on dataforseo --json   offers a data provider's
         tools (dataforseo_<tool>) to members' AI clients through the Gateway's
         /mcp with the Gateway's key (DATAFORSEO_API_KEY, setup/dataforseo.md);
         no page, nothing to deploy (the launcher lists it under "MCP apps").
         pnpm everyapp mcp add <url> --auth bearer --json   does the same for
         any remote MCP server (Streamable HTTP): <id>_<tool>, its credential
         a Gateway setting <ID>_MCP_TOKEN set with secret set and pinned to
         the URL's origin (setup/remote-mcp.md). add looks at the server once
         and only warns. mcp list shows each app's kind, on/off/needs setup,
         tools and key; mcp show <id> its URL, credential and every tool with
         its risk; mcp tool <id> <tool> --risk read|write|destructive or --off
         overrides one tool; mcp refresh <id> re-lists. mcp off <id> stops
         serving and keeps access (mcp on is instant); mcp remove <id> deletes
         it (the key stays; before 2026-10-25 off deleted it). The credential
         never goes through the chat (setup/README.md's three ways). provider
         on|off still run mcp on|off through launch week; provider list is the
         API providers' list. You, owners and admins get it;
         others are granted in Admin → Apps → Manage access. An owner or admin
         caps an app's provider calls per month in Admin → Usage (off by
         default): past it a provider tool answers a tool error naming the
         cap, and an app's brokered call gets 429 app_monthly_cap_exceeded
         until the next UTC month.
APIs:    pnpm everyapp provider add stripe.json --json   registers an API
         provider the catalog doesn't have on the Gateway: a JSON spec (hosts,
         auth, settings named after its id, STRIPE_…; never a value; fields
         and rules on the providers page), from a file or an https URL. At a
         terminal it then asks for the key and sets it; with --json it sets
         nothing and its next is pnpm everyapp secret set STRIPE_API_KEY (it
         names the provider and the hosts the key goes to, and binds the key
         to them: a row replaced with --replace needs the key set again), or
         add --from-env. provider add <id> does the same for a built-in
         provider (openrouter) or OAuth client (google-workspace). An app lists it under
         capabilities like a catalog provider and calls integrationFetch().
         provider list (the catalog and the rows), provider show <id> (the
         whole spec; --save writes .everyapp/providers/<id>.json for dev),
         provider remove <id> (PROVIDER_IN_USE while an app lists it).
Workspace: pnpm everyapp workspace rename "Acme Corp" --json   renames the workspace
         (the Gateway's organization: the name in the switcher and in invitations;
         1 to 64 characters, no line breaks). Nothing is deployed; members see it
         on their next page. Owners and admins can do the same under Manage
         workspace → Rename. WORKSPACE_NOT_CLAIMED: the Gateway has no owner yet.
Roles:   pnpm everyapp workspace role <email> owner|admin|member --json   sets a
         member's role in the workspace under the Cloudflare login (the Users
         page does the same). Owners are peers and the workspace always keeps
         one: the last owner's role is refused (LAST_OWNER); someone still
         invited isn't a member yet (MEMBER_NOT_FOUND).
Manage:  pnpm everyapp workspace --help   the rest of Manage workspace from the
         terminal, under the Cloudflare login: show, users, invite (prints the
         link; nothing is mailed), invite-link, uninvite, deactivate, reactivate,
         remove (--yes), reset-link, groups, group create|set|delete|members|apps,
         apps, app set|access|cap, usage, activity, tokens, token revoke,
         connections, connection revoke; --json on each. --org <slug> acts on
         another organization (a name two organizations share is refused:
         ORG_AMBIGUOUS; scripts pass the slug or id). deactivate and remove keep
         the last owner who can act (LAST_OWNER); a ban is account-wide, so
         deactivate checks every organization the person owns.
Events:  pnpm everyapp events add <url> --events 'cap.*,member.*' --json   sends
         those Gateway events to a webhook (Slack workflow, Zapier, n8n), signed;
         the generated secret is data.secret, shown once: hand it to the person,
         never invent or echo one. --email admins mails owners and admins instead.
         events list|test <id>|deliveries --dead|redeliver <id>; events types lists
         types. An app emits its own with emit() (app.<id>.<name>), declaring
         nothing. Everything: /docs/agent/events.
Tools:   an app's AI tools are defineTools() in src/tools.ts; the Gateway
         serves them at https://<gateway>/mcp as <app>_<tool> (dev:
         http://<app-id>.localhost:8787/mcp) and snapshots them at deploy.
         How to write, connect and debug them: mcp.md beside this file.
Wipe:    pnpm everyapp teardown --account-id <id> --dry-run --json   deletes
         EVERYTHING EveryApp made in one Cloudflare account (the Gateway too):
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
         Before opening a pull request that touches identity, public routes,
         tools, secrets or queries, review the changes locally against the
         app boundaries in security-review.md beside this file: in Claude
         Code, /security-review (its built-in review of the branch's pending
         changes) pointed at that file; any other agent reads git diff
         against the list there. No CI job and no API key: the review runs
         where you run. Fix what it finds, or say in the pull request why a
         finding is a false positive. What the Gateway promises and what an
         app must do itself: docs/threat-model.md in the EveryApp checkout
         (https://everyapp.com/docs/agent/repo/threat-model).

Only a person can: approve the Cloudflare login, open the owner link, pick
a workers.dev subdomain, pay for Workers Paid, buy a domain. Interactive
setup optionally offers browser deployment: a Yes/No prompt (default No),
then a hidden Cloudflare API token prompt. Never ask for its value in chat.
It then puts Cloudflare Access in front by default (asked at a terminal,
Yes by default; the team name asked for when the account has none); under
--json or --yes it goes on without a question when the account can (a Zero
Trust team exists, the Cloudflare login is an owner or admin), else the
warning ACCESS_SETUP_SKIPPED says why and names access on; --no-access
leaves it off. --yes answers No to browser deployment.
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
