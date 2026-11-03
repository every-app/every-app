---
name: everyapp
description: Create, run, deploy and manage private web apps on Cloudflare with everyapp (EveryApp). Use before running any everyapp command, to deploy an app, set a secret, query its database, check the Gateway, or answer any "how do I" question about EveryApp.
---

everyapp: self-hosted platform for private web apps on Cloudflare. The command
is `everyapp`: `pnpm everyapp` in an app's directory (its package.json pins the
CLI) and in a checkout of the EveryApp repository (which builds the Gateway from
the tree); `npm install -g everyapp` or `npx everyapp@latest` anywhere else.

This file routes; the agent docs hold the detail. https://everyapp.com/llms.txt
lists every page with a one-line summary; a page is Markdown at its URL plus
.md (https://everyapp.com/docs/agent/manifest.md); in a checkout they are
landing-page/content/agent/*.md. Pages: setup (driving setup for a person,
every handoff), apps (the open apps, their install commands and settings),
cli (every command and flag), json (the --json protocol), errors (every code
and its fix), troubleshooting (by symptom), status (the report and its fixes),
manifest (everyapp.config.ts), identity (headers, token, env, SDK), secrets
(secrets vs Gateway settings vs capabilities), dev (dev vs production), email,
events (webhooks, email alerts, every event type, emit()), mcp (tools,
connector, OAuth), native (Mac and phone apps; bearer routes), deploy (the
pipeline, release and install), providers (API providers and registering one),
access (Cloudflare Access), signin (sign-in providers), ai (the default model
provider, AI Gateway), workspace (people, groups, caps, usage from the terminal
and from an AI client), gateway (everything a Gateway offers, the CLI by job),
build (the build-every-app skill as a page), patterns (its look-up table),
repo/* (security model, capabilities, runbooks).

Answering "how do I": fetch the page for the subject and answer from it with
the exact command or manifest field, naming the page. A failed command: look
its code up on errors (anchor: the code, lowercased) before trying anything
else. Never guess a flag: cli has them all. Building or changing an app: read
the build-every-app skill beside this one.

## Driving the CLI

Pass --json. One JSON event per line; "done" = success; exit 2 = show the user
the last action_required (url, code), then run its data.rerun; exit 1 = show
the error; if data.authorize is set, ask before using data.rerun. waiting: true
= keep reading (5 min for the device login, up to 15 for the owner link).

| Job                                    | Command (with --json)                                                                   | Page      |
| -------------------------------------- | --------------------------------------------------------------------------------------- | --------- |
| What is online, what to fix, what next | `everyapp status` (data.fixes, data.next, data.apps[].setup)                            | status    |
| Install, upgrade or repair the Gateway | `everyapp setup --domain <host>` (5-20 min: background it)                              | setup     |
| A new app                              | `everyapp create <id>` (from a checkout `../<id>`, its own repository)                  | build     |
| Run it locally                         | `everyapp dev` (long-running, no --json: background it, read the URL; stop with SIGINT) | dev       |
| Put it live                            | `everyapp deploy` from the app's directory (safe to repeat)                             | deploy    |
| Someone else's app, no clone           | `everyapp install https://github.com/<owner>/<repo>`                                    | deploy    |
| Publish an app                         | `everyapp release` (`--publish` in its Release workflow)                                | deploy    |
| The database                           | `everyapp db query "<sql>" [--local]`, `db migrate`, `db restore`                       | cli       |
| Set up an app's values                 | `everyapp configure <app>` (one name: `secret set NAME`)                                | secrets   |
| Email senders and inbound              | `everyapp email set --sender "*@<domain>" --inbound <address>`                          | email     |
| Cloudflare Access                      | `everyapp access on` (rerun after inviting someone)                                     | access    |
| MCP apps                               | `everyapp mcp on dataforseo`, `mcp add <url> --auth bearer`                             | mcp       |
| API providers                          | `everyapp provider add <spec.json or id>`                                               | providers |
| The workspace                          | `everyapp workspace --help` (rename, role, invite, groups, apps, caps, usage)           | workspace |
| Events out                             | `everyapp events add <url> --events 'cap.*'` (data.secret shown once: hand it over)     | events    |
| The default model                      | `everyapp ai show`, `ai default <provider>`                                             | ai        |
| Remove an app                          | `everyapp delete <id>`                                                                  | cli       |

The workspace, events and `ai show|default` commands are the Gateway's own
tools, run as the person: EVERYAPP_TOKEN (a personal access token), or the
browser sign-in `everyapp login --gateway <url>` keeps (hand its URL to the
person; it waits). A refusal is GATEWAY_TOOL_ERROR, its code in data.code.
`everyapp call <tool> '<json>'` runs any tool by name (`call --list`).
`workspace invite-link` and `workspace reset-link` print a link under the
Cloudflare login: hand it to the person.

An app's AI tools are defineTools() in src/tools.ts, served at
https://<gateway>/mcp as <app>_<tool>: mcp.md beside this file says how to
write, connect and debug them.

## Values never pass through the chat

A key, token or client secret goes in through one of three ways: the person
runs `everyapp configure <app>` (or `secret set NAME`) in their own terminal
and types it at the hidden prompt; NAME=value lines on stdin from a command's
output; or --from-env for variables the person exported before starting you.
Never a value on the command line (VALUE_ON_COMMAND_LINE); never ask for,
print, repeat or invent one. An app whose data.apps[].setup.ready is false
doesn't open: show each unmet setting's why and docs, read its setup guide
(node_modules/everyapp/skills/everyapp/<setup>, the setup/ folder beside this
file), then hand over setup.command. Postgres URLs go in
.everyapp/secrets.env, which the person writes.

Step-by-step setup of what the Gateway holds (the provider's side, the key or
OAuth client, the check): setup/README.md beside this file first, then the
file it names, each read on its own: setup/gateway.md, access.md, email.md,
ai.md, ai-gateway.md, dataforseo.md, context.md, openrouter.md, openai.md,
workers-ai.md, google.md, microsoft-365.md, slack.md, remote-mcp.md, the
signin-*.md guides, and providers.md#<id> for any other catalog provider; a
provider registered on one Gateway has none: `everyapp provider show <id>`.

## Ask first

- Never add --purge, --force-dns, --allow-delete-* or --yes
  to delete, --yes to a production write (CONFIRMATION_REQUIRED), or
  --enable-email-routing, unless the user said so. `db restore` only when asked.
- Teardown deletes everything EveryApp made in one account: only on a dedicated
  test account the user names, --dry-run --json first, and never --confirm
  unless the user explicitly asked.
- Setup puts Cloudflare Access in front by default; never add --no-access
  unless the person says so. ACCESS_TEAM_REQUIRED: ask the person for a team
  name (permanent), then rerun with --team <name>.
- Never vendor the SDK or CLI into an app (no tarballs, no committed `file:`
  or `link:`): pin a published version; `pnpm link` locally to try unreleased
  code, and an rc ships it (deploy page).
- Gateway app installs from the browser are off by default: don't suggest
  them. Only when the person asks, they run `everyapp deploy-token add` at a
  terminal themselves.

Only a person can: approve the Cloudflare login, open the owner link, pick a
workers.dev subdomain, pay for Workers Paid, buy a domain, pick the account
(choose_account), and confirm in a terminal a Worker changed outside everyapp
(rerun_interactive, data.needsTerminal: hand them the command without --json).
Handing off: stop, tell the person in one or two lines what to do (the url and
code, what to click, what to come back with), and resume with data.rerun when
they say it is done. The setup page has the words for each handoff.

## Security

The Gateway signs people in and passes identity to the app in a header the SDK
verifies; never read who the user is from a client-supplied header, cookie or
parameter. Routes are private unless listed under `public` in
everyapp.config.ts. Before a pull request that touches identity, public routes,
tools, secrets or queries, review the changes against security-review.md beside
this file (`/security-review` in Claude Code; any other agent reads git diff
against it). Fix what it finds, or say in the pull request why a finding is a
false positive. What the Gateway promises: docs/threat-model.md in the checkout
(https://everyapp.com/docs/agent/repo/threat-model).
