# Setting up what the Gateway holds, end to end

For a coding agent setting up one integration for a person: the provider's
side (an account, a plan, an app registration), the key or OAuth client it
gives, the Gateway setting that holds it, and the check that it works. One
file per integration, below. Read this page first, then the one file, each
on its own with your file-reading tool (the two together are longer than a
shell tool shows: a `cat` of both was cut off in testing); follow the
file's steps in order. The person is a solopreneur or a small team's
founder: say what each step is for in one line, and say exactly what to
click when they have to do something themselves.

| Integration                                   | File                                   | Gateway settings                                                                | Used by                                                                 |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Cloudflare account, the Gateway and its owner | [gateway.md](gateway.md)               | set by `everyapp setup` (optional: `CF_DEPLOY_TOKEN`, `BROWSER_APP_INSTALLS`)    | everything                                                              |
| Cloudflare Access in front of the Gateway     | [access.md](access.md)                 | `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_APPS_AUD` (set by `everyapp access on`; optional: `EMAIL_PASSWORD_SIGN_IN`, `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`, `CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN`) | sign-in, every app                                          |
| Email sending (Cloudflare Email Sending or Resend) | [email.md](email.md)               | `EMAIL_FROM`, `EMAIL_FROM_NAME`; `RESEND_API_KEY`, `EMAIL_PROVIDER`, `EMAIL_REST_API_TOKEN` | invitations, password resets, agentic-inbox, Open Analytics (optional), any app that sends |
| DataForSEO                                    | [dataforseo.md](dataforseo.md)         | `DATAFORSEO_API_KEY`                                                            | OpenSEO; the DataForSEO MCP app (`pnpm everyapp mcp on dataforseo`) |
| Any remote MCP server, as an MCP app          | [remote-mcp.md](remote-mcp.md)         | `<ID>_MCP_TOKEN` (one per server; none for a public one)                        | the MCP app added with `pnpm everyapp mcp add <url>`                     |
| Context.dev                                   | [context.md](context.md)               | `CONTEXT_API_KEY`                                                               | Open CRM; OpenSEO (optional: rendered audits)                           |
| OpenRouter                                    | [openrouter.md](openrouter.md)         | `OPENROUTER_API_KEY`                                                            | OpenSEO, Open CRM, agentic-inbox                                        |
| OpenAI                                        | [openai.md](openai.md)                 | `OPENAI_API_KEY`, `AI_PROXY_EXTRA_ROUTES`                                       | apps listing the `openai` provider                                      |
| Workers AI                                    | [workers-ai.md](workers-ai.md)         | `WORKERS_AI_API_TOKEN` (`CLOUDFLARE_ACCOUNT_ID` is set by `everyapp setup`)     | agentic-inbox (optional)                                                |
| Google (Gmail, Calendar, Search Console and Analytics) | [google.md](google.md)        | `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET`                  | Open CRM                                                                |
| Microsoft 365 (Outlook mail and calendar)     | [microsoft-365.md](microsoft-365.md)   | `MICROSOFT_365_CLIENT_ID`, `MICROSOFT_365_CLIENT_SECRET`                        | Open CRM                                                                |
| Slack (OAuth client)                          | [slack.md](slack.md)                   | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`                                        | Open CRM                                                                |

Which integrations a person needs: the apps they deploy decide. The four
Every App apps (OpenSEO, OpenCRM, OpenAnalytics, Agentic Inbox) are
installed from their GitHub releases by [gateway.md](gateway.md)'s last
step, each unless the person skips it; the keys they then ask for are the
files below. From any
directory, `pnpm everyapp secret list <app id> --json` (the id as `status`
lists it in `data.apps[].id`; in the app's directory it can be left out)
reports the app's setup state as `data.app.setup`: `ready` (the app
opens), `unmet` (the settings keeping it closed), `settings` (every
setting, set or not), `groups` (each any-of group, `met` once one member
is set) and `command`, the one `secret set` that sets everything missing
(`{ command, note? }`, the note an any-of group's alternatives; null once
ready). A setting has `names` (all must be set), `holder` (`gateway`, or
`app` for the app's own secret), `need.kind` (`required`, `optional`, or
`anyOf` with its `group`), `set` (true, false, or null when the app
Worker's names were never recorded, which never blocks), `blocking`, and
when known `why`, `docs` (where the key comes from) and `setup`: the file
here that sets it up, relative to the everyapp skill (`setup/dataforseo.md`;
in an app `.claude/skills/everyapp/setup/dataforseo.md`, in this checkout
`packages/cli/skills/everyapp/setup/dataforseo.md`). An unset optional
setting is in `settings` with `set: false`, never in `unmet`. The older
fields still hold: `data.gateway.needed` (each Gateway name with `required`
and `set`) and `data.gateway.missing` (the required ones unset); from the
checkout root with no app named, `data.apps[]` has every app's `id` and
`setup`. `pnpm everyapp status --json` carries the same per app as
`data.apps[].setup`, and a deployed app whose `ready` is false gets the
`data.fixes` entry `APP_NEEDS_SETUP` (a warning, `<app> needs setup`,
`run` the command above). Under each unmet setting that has a guide,
`status` (under "<app> needs setup"; the same lines are in
`data.fixes[].message`) and `secret list <app id>` (under its unmet settings)
print `Guide: .claude/skills/everyapp/setup/<name>.md`, once per guide, and
`secret list --json` names it as the setting's `setup`: that is how an agent lands on
one of these files. On the Gateway's home such an app shows
"Needs setup" and opens its setup dialog instead of the app (a browser
visit to the app's own host lands in that dialog too; any other request
gets a 503 `app_needs_setup`), and its tools stay out of the Gateway's
`/mcp`. Set up what is unmet, in the order the person wants; an optional
setting when they want its feature. A setting nobody needs is simply not
offered to apps.

## The rules every setup follows

**Where you are.** Every command runs from the `every-app` checkout, as
`pnpm everyapp …` (never `npx`), with `--json`: one event per line, `done`
means success, exit 2 means an `action_required` for the person (show its
`message`, `data.url` and `data.code`; rerun `data.rerun` when they are
done), exit 1 an error (show it; its `data.fix` or `data.rerun` says what
to do). An event with `"waiting": true` is being waited for: keep reading.
A Gateway setting is set from any directory; an app's own secret (a name
its `everyapp.config.ts` lists under `secrets`) from the app's directory,
or from anywhere with `--app <id>` (against the manifest its last deploy
stored; `setup.command` carries the flag when it sets one), either way
after its first deploy. Every `cf …` in these files is the CLI's pinned
`cf` (1.0.0-beta.14, which `pnpm install` puts under `packages/cli`, not
on PATH): from the `every-app` folder, run it as `pnpm --filter everyapp
exec cf …` (the root's bare `pnpm exec cf` finds none). A bare `cf` only
when `cf --version` answers `1.0.0-beta.14` (a global install); never
install one.

**Deep references.** A command's flags and exit codes:
`pnpm everyapp <command> --help` (0 done, 1 error, 2 action required,
251/252 a bad command or its arguments). The agent docs:
https://everyapp.com/docs/agent/, each page also as Markdown at
`https://everyapp.com/docs/agent/<page>.md` (`setup`, `cli`, `json`,
`errors`, `troubleshooting`, `manifest`, `identity`, `secrets`, `dev`,
`email`, `mcp`, `deploy`, `access`; an error code's fix is at
`errors.md#<code>`, the code lower-cased). They go live with the launch on
2026-10-27; until then each page is in the checkout at
`landing-page/content/agent/<page>.md`; `docs/runbooks/`,
`docs/threat-model.md` and `pnpm everyapp <command> --help` stay the
deeper reference. An error code these files don't
cover carries its own `data.fix` or `data.rerun`; it is raised in the
command's file under `packages/cli/src/commands/` or its library under
`packages/cli/src/lib/` (the error types: `packages/cli/src/lib/errors.ts`).
These files say what to do; the agent docs say why and what else is
possible.

**Not a Gateway setting.** A secret of the app's own repository (a GitHub
Actions secret for a workflow the person added; a new app ships none) is
set in that repository (`gh secret set NAME` there, the value from the
person's terminal), never with `everyapp secret set`, which refuses names
it doesn't know.

**Preconditions, checked, not assumed.** Before the provider's side, both,
in either order (the integration files lead with 2, which says whether
the file applies):

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` are
   true, `data.gatewayUrl` is the Gateway (its host is `<gateway host>`
   below; `data.appBaseDomain` is where apps live, `<app>.<app base domain>`).
   Not installed, or no owner: [gateway.md](gateway.md) first. `status`,
   `secret list` and `email show` all need the Cloudflare login and an
   installed Gateway. Each logs in by itself: with nothing logged in it
   emits `action_required cloudflare_login` with `waiting: true` (show
   `data.url` and `data.code`, keep reading; approved within 5 minutes,
   the run goes on, otherwise it ends with the error
   `CLOUDFLARE_LOGIN_FAILED`, exit 1, whose `data.rerun` is `pnpm everyapp
   login`, which also logs in ahead of time). With no Gateway, `status`
   stops with `install_gateway` (exit 2; its `data.rerun` is the setup
   command), while `secret list` and `email show` end with the error
   `GATEWAY_NOT_FOUND` (exit 1); the fix for both is
   [gateway.md](gateway.md). In the report, `data.access` is `{ on,
   teamDomain }` when Cloudflare Access can be checked, else null (a hosted
   Gateway, no Worker yet, or cf couldn't list the Worker's settings: then
   `data.fixes` has `ACCESS_UNKNOWN`). Each `data.fixes` entry carries
   `code`, `severity` (`error`, `warning`, `info` or `settling`), `message`,
   `run` (null without a command), and when it has them `note` (what `run`
   does) and `fix` (a remedy that isn't a command). Only `error` and
   `warning` are something to fix; `info` (`GATEWAY_OUTDATED`: `pnpm
   everyapp update` updates the Gateway now; leave it unless the
   person asks) and `settling` need nothing from you.
2. `pnpm everyapp secret list <app id> --json`, from anywhere (the app's
   directory is no longer required): this file applies when its setting
   is in `data.app.setup.unmet` (each entry's `names`, `need.kind`,
   `holder` and `setup` say what goes where and which file), or, for an
   optional one, in `settings` with `set: false`; `data.app.setup.command`
   is the one command that sets what is missing. For a setting no app
   declares (the Gateway's own, Cloudflare Access's), from the checkout
   root `pnpm everyapp secret list --json`: `data.gateway.names` is what
   is set. Set already (`set: true`, or the name in `data.gateway.names`):
   ask whether to replace it before doing anything on the provider's side;
   a value can't be read back, so "replace" means a new key.

**The value never goes through the chat.** A key or client secret is never
asked for in the conversation, never shown, never put on a command line
(shell history, the process list), never written into a file you create in
the repository. `pnpm everyapp secret set NAME` reads the value from one of
three places, and your shell has no terminal, so it never prompts for you:

- **The person types it.** Tell them to open a second terminal in the
  `every-app` folder and run `pnpm everyapp secret set NAME`; it asks for
  the value with a hidden prompt (pasting works; nothing is echoed). Then
  they tell you, and you verify. This is the default when the value is on a
  dashboard the person is looking at.
- **A command produced it.** When a CLI or API call returns the key
  (Microsoft's `az ad app credential reset`, Slack's `apps.manifest.create`,
  a JSON file the console let the person download), pipe it straight in and
  the value never appears anywhere: `… | jq -r '.client_secret' | pnpm everyapp secret set NAME --json`.
  Never run the producing command on its own to look at the result first.
- **It is in an environment variable.** In their own terminal, in the
  `every-app` folder, the person reads it in hidden (bash or zsh:
  `read -rs NAME && export NAME`; fish: `read -s -x NAME`), pastes the
  value and presses Enter (nothing is echoed; bash and zsh show no prompt
  either), then runs `pnpm everyapp secret set NAME --from-env NAME --json`
  there, and `unset NAME` (fish: `set -e NAME`) once the file's smoke
  check is done. Never a typed `export NAME=…`: on a default macOS zsh and
  on bash it lands in the shell history, leading space or not (only a
  shell set up with `HIST_IGNORE_SPACE` or `HISTCONTROL=ignorespace` drops
  it). A variable they exported before starting you: you run the same
  `pnpm everyapp secret set NAME --from-env VAR --json`. Never `echo $VAR`,
  and never ask them to paste the export line into the chat.

One value per call for a pipe or `--from-env`; several names at once only
at the hidden prompt. The change is live on the Gateway at once (one new
version of its Worker, no deploy). If `secret set` fails with
`SECRET_VALUE_REQUIRED`, nothing was piped: use one of the three ways above;
`SECRET_EMPTY` means the `--from-env` variable is empty or unset in the
shell that ran it: the hidden read again, in that same terminal.
`SETTING_VALUE_INVALID` means a plain setting (`EMAIL_FROM`,
`EMAIL_PROVIDER`, `EMAIL_PASSWORD_SIGN_IN`, a `CLOUDFLARE_ACCESS_*` or
`MCP_*` switch) got a value the Gateway wouldn't read: the message names the
setting and the value, `data.fix` says what it takes, and nothing was
written; pipe the right value. A plain setting's prompt at a terminal is
visible and says what it takes; a credential's stays hidden.

**Only a person can** sign in to a provider, accept its terms, add a card
or choose a plan, approve an OAuth consent, pick a Google Cloud project's
organization, or copy a secret off a screen. For each such step, say what
page to open (a direct URL where one exists), what to click, what to type,
and what they will see when it worked; then wait. Everything else (reading
status, creating what an API or CLI can create, setting the value from a
pipe, verifying) you do. With a browser tool you may do the clicking too,
but a secret shown on screen still goes in through the person's terminal
or a file they save, not through you.

**Verify, every time.** After `secret set`:

1. `pnpm everyapp secret list <app id> --json`: in `data.app.setup` the
   setting has `set: true` and is out of `unmet` (`ready: true` and
   `command: null` once nothing else is missing); the older fields agree
   (the name in `data.gateway.names`, its `data.gateway.needed` entry
   `set: true`, out of `data.gateway.missing`). For the app as a whole,
   `pnpm everyapp status --json`: `data.apps[].setup.ready` is true for it
   and `data.fixes` has no `APP_NEEDS_SETUP` for it (a `SETTINGS_UNKNOWN`
   warning means cf couldn't list a Worker's secrets, so those rows read
   as unknown: run it again rather than trust them). For a setting no app
   declares, `data.gateway.names` alone.
2. The file's smoke check: a call that uses the value, made where the
   value is (the person's terminal, with the variable they exported) or
   through the app that uses it, and what its failure means.
3. The app: open it and use the feature, or `pnpm everyapp status --json`
   for `data.fixes` when the file says the setting changes what status
   checks. A Gateway refusal names the setting: `integration_not_configured`
   and `ai_provider_not_configured` mean the Gateway doesn't hold it (set
   it, or the name is wrong); the provider's own error means the value is
   wrong or the account isn't ready (the file says which).
4. Logs, when a file's step sends you there: the Cloudflare dashboard,
   **Workers & Pages** → `every-app-gateway` → **Observability** (**Logs**
   on older accounts) → **Live** streams now; the stored Workers Logs are
   on the same page (the Gateway deploys with them on). Which tab name an
   account shows wasn't checked in a browser here (unverified). `cf`
   1.0.0-beta.14 has no Worker tail; `npx wrangler tail every-app-gateway`
   streams the same after wrangler's own login. Each file says which log
   lines to look for.

**Resume.** Every step can be run again: `secret set` replaces, the
provider's console shows what exists, `everyapp setup` and `everyapp access
on` change only what differs. When a run was interrupted, or the person
comes back later, start from the Verify section, keep what is done, and
continue at the first step that isn't.

**Remove.** `pnpm everyapp secret unset NAME --json` (it asks at a
terminal; with `--json` add `--yes` only when the person said so). Then
revoke the key on the provider's side: a key the Gateway no longer holds is
still a key.

**Never**, on your own: create a paid account or buy a plan, change a
setting on a Gateway that isn't this person's, run `secret unset` or
`access off` without being asked, or set a value you were given in the
chat (tell them it's in the chat now, and to rotate it on the provider's
side; then use one of the three ways).
