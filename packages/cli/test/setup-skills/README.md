# The setup skills, run end to end

A harness that runs each file of the everyapp skill's `setup/` directory
(`packages/cli/skills/everyapp/setup/*.md`) the way it will be used: a
coding agent (`claude -p`) in a checkout, a person answering in the chat,
and `pnpm everyapp` on the other side. The everyapp it talks to is a fake
(`fake-everyapp.mjs`) that speaks the real CLI's NDJSON contract and
records every call; the person is scripted by the scenario; the Gateway,
Cloudflare and every provider are make-believe. What it checks is the
skill file, not the CLI: did the agent read status first, list the secrets
before and after, send the person to the right console, keep the key out
of the chat, and verify at the end.

It needs the `claude` CLI logged in (it spends real tokens: a few cents per
scenario on sonnet) and it is **not run in CI**. CI runs the static test
beside the skill code, `packages/cli/src/lib/app/setupSkills.test.ts`,
which keeps the files honest without a model: every file in the README's
table exists and is listed, every `secret set NAME` is a Gateway setting
the CLI accepts, every `pnpm everyapp …` is a route the CLI has (`commandPaths()` in
`src/app.ts`; `access` included since PR #379 merged on 2026-10-24), no file asks for a value in the chat
or puts one on a command line, and each file has the sections the
README's contract requires.

The build-every-app skill has a harness of the same kind,
`../build-skill/` (a fresh app from the starter, a person asking for a
feature, the app's own checks at the end); the claude session, the
scripted person's rules and the tool stubs they share are `../shared/`.

## Run it

From the checkout root (the SDK must be built, which `pnpm install` does):

```bash
node packages/cli/test/setup-skills/run.mjs dataforseo                # one scenario, sonnet
node packages/cli/test/setup-skills/run.mjs dataforseo --model opus   # a stronger reader
node packages/cli/test/setup-skills/run.mjs all --keep-going          # every scenario, in turn
node packages/cli/test/setup-skills/run.mjs --help
```

Scenarios live in `scenarios/<name>.json`, one per setup file: `gateway`,
`access`, `email`, `dataforseo`, `context`, `openrouter`, `openai`,
`workers-ai`, `google`, `microsoft-365`, `slack`. A run takes half a
minute to a few minutes (the dataforseo scenario on sonnet: about 35
seconds and $0.13); the exit code is 0 when every scenario passed.

Sonnet is the default on purpose: a weaker reader finds the gaps in a file
that a stronger one papers over. Run a file on opus too before trusting a
pass, and read the transcript, not only the verdict.

## What a run does

For each scenario, under `/tmp/setup-skills-runs/<scenario>-<n>/`:

1. Makes a scratch checkout, `every-app/`: a `package.json`, a
   `node_modules/.bin/everyapp` that runs the fake (so `pnpm everyapp …`
   resolves to it, from the root and from each app's directory, without
   any output of pnpm's own), a copy of `packages/cli/skills/everyapp`
   in `.claude/skills/everyapp/` and `.agents/skills/everyapp/`, an
   `AGENTS.md` and `CLAUDE.md` like the starter template's, and for each
   app the scenario deploys, `apps/<id>/everyapp.config.ts` with the
   manifest the scenario gives (id, providers, capabilities), so "in the
   app's directory" means something.
2. Writes the scenario's initial state to `state.json` (what the Gateway
   holds, which apps are deployed, whether `access` exists yet). The fake
   reads and writes it, so a `secret set` shows up in the next
   `secret list`. The settings model is the real one: the fake evaluates
   each app's manifest with the built SDK (`appSettings`,
   `evaluateAppSettings`, `appSetupOf` from `@every-app/sdk/internal`, the
   registries' `setup` guide pointers included) against
   `state.gatewayNames` (plus the install's own names) and the app's
   `secretsSet`, so `secret list [<app>] --json` answers `data.app.setup`
   (`ready`, `settings`, `groups`, `unmet`, `command`) for the app named
   from anywhere or the one in the directory, with the kept
   `data.app.declared`/`workers`, `data.gateway.needed`/`missing` and
   `next`; from the root with no app, `data.apps[] { id, setup }` beside
   the Gateway's names. `status --json` carries `data.apps[].setup` and an
   `APP_NEEDS_SETUP` fix (severity `warning`, "<app> needs setup", `run`
   the one `secret set`) per app with unmet required settings, its
   `message` listing each unmet setting with `Guide:
   .claude/skills/everyapp/setup/<name>.md`, which the human `status`
   prints as the real one does. `secret set NAME --app <id>` and `secret
   unset --app <id>` reach an app's own secret from anywhere; an app with
   `deployed: false` is registered but never uploaded (`status` says
   `pending`, its own secrets read as unknown and "after first deploy").
   With `installed: false` there is no Gateway anywhere:
   `status` stops on `install_gateway` (exit 2), `secret list` and
   `secret set` on `GATEWAY_NOT_FOUND`, and `setup --domain <host>`
   installs one under `zone`, then stops on `claim_owner` with the owner
   link (it polls the state file for a few seconds first, since only the
   person, scripted by a rule that sets `claimed`, can open it; a rerun
   ends `done`).
3. Starts `claude -p --output-format stream-json --input-format stream-json
   --verbose --dangerously-skip-permissions --max-turns 60 --model <model>`
   in `every-app/`, with `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` removed
   from its environment (a nested session is refused while they are set)
   and, unless `--full-settings`, with `--setting-sources project,local
   --strict-mcp-config` so your own plugins, MCP servers and user CLAUDE.md
   stay out of the session. `cf` and `wrangler` on the child's PATH are
   stubs that log every call and refuse it, except the read-only checks
   the setup files name: `cf --version` answers the pinned
   `1.0.0-beta.14` (so the agent uses the stub bare, as the setup README
   says to when a cf on PATH answers that), and `cf auth whoami`,
   `cf zones list`, `cf accounts subscriptions get`, `cf email-sending
   subdomains list` and `cf dns records list` answer with JSON shaped
   like the real cf's, from the scenario's state (its account, `cloudflareEmail`, and
   `zone`, the one domain on Cloudflare; Workers Paid always, the Zero
   Trust Free plan with `cf.zeroTrust: true`, the login's scopes from
   `cf.scopes`, by default with the Access ones). `curl` is a stand-in too
   (`stubs/curl.mjs`): the Gateway's host and the app hosts answer from
   the state (the OAuth discovery document, `/mcp`, the Gateway's page, or
   Access's 302 to `<team>.cloudflareaccess.com` once `access on` has
   run); any other host fails to resolve. The fake everyapp never reaches
   anything.
4. Plays the person. The scenario's prompt is the first message. After
   each assistant turn (the `result` event), the assistant's last message
   is matched against the scenario's rules in order; a rule has a `when`
   regexp, a `reply` (`$1` is the regexp's first group; a `$N` the regexp
   has no group for stays as written, so "$10 of credits" is safe), optional
   `then` changes to the state (mark a name set, mark the owner claimed),
   `once: true` for a step the person takes one time (the sign-in page,
   the credits page: a later message that mentions the page again falls
   through to the next rule), `whenState` for a rule that applies at one
   stage only (`{"access.on": true}`: the first sign-in through Access
   only after `access on` has run; `{"access.team": null}`: the team's
   name only while there is none), and an optional `flag` that records a
   failure. Named rules the scenarios share (`{ "use": "<name>" }`, with
   any field overridden inline): `chat-secret` (the assistant asked for
   the key in the chat: flagged, and the person declines),
   `ran-secret-set` (the assistant told the person to run `pnpm everyapp
   secret set NAME` for a name not set yet: the name is marked set, "Done,
   I ran it."), `check-result` (the assistant asked what a check printed:
   "It printed a success status and no error."), `opened-url` ("Opened it
   and did that."), `yes` (a question: "Yes, go ahead.", unless the goals
   are met and the question offers more work, which ends the run). An
   inline rule with `skipWhenDone: true` is ignored once the goals are met
   (a step's answer such as "I have it copied" on the console's URL, which
   comes back later as rotation advice); one with `onlyWhenDone: true` is
   ignored until they are (a Verify step's answer such as "the invitation
   arrived", which an earlier message may only preview). With no rule
   matched, the person
   says "Done." until the round cap (8, `--max-rounds`, or the scenario's
   `maxRounds`; a rule that matches on the last round doesn't extend it),
   or "That's all, thanks." once the scenario's goals are met and the
   assistant isn't asking for anything. A scenario's `files`
   are written under the run directory (outside `every-app/`) before the
   session starts: what the person has on their disk, such as the client
   JSON a console let them download; a reply names one with `{runDir}`
   (the google scenario does this, and the agent must pipe from it
   without reading it).
5. Checks the expectations and writes the report.

## What a pass means

Every expectation in the scenario's `expect` held:

- `set`: each name ended up set on the fake Gateway, by a pipe or
  `--from-env` into the fake, by `access on`, or by the person at the
  hidden prompt (the `ran-secret-set` rule). The report says which.
- `secretList` (default on): `secret list` ran at least once before the
  first set and once after the last.
- `neverAskedInChat` (default on): no `chat-secret` flag, no value-looking
  argument to `secret set` for a key, no literal key piped in by the agent
  (`echo "sk-…" | pnpm everyapp secret set …`). A literal pipe for a
  setting that isn't secret (`EMAIL_FROM`, a client id) is fine.
- `finalMentionsVerification` (default on): the assistant's last message
  says it verified (`verificationPattern` overrides the words); when the
  person's last replies were bare "Done."s (no rule matched after the goals
  were met), the message before them counts as the closing.
- `mustMention`: strings (the provider's console URL, a redirect path)
  that must appear in the assistant's text.
- `commands`: regexps that must match some fake-everyapp invocation
  (`^secret list crm\b`: the setup files read `secret list <app id> --json`
  from anywhere, so the app-scoped scenarios expect the id, not a
  directory); an entry `{ "pattern": "^secret list crm\\b", "phase":
  "after" }` says it came after the last set (a file's Verify step; or
  `"before"` the first), and `"cwd": "apps/crm"` in which directory
  (relative to `every-app`) when that matters.
- `notCommands`: regexps no fake-everyapp invocation may match (the
  access scenario: `^secret set\b`, since its file pipes
  `EMAIL_PASSWORD_SIGN_IN` or the membership settings only when the
  person asks, and the scripted person never does).
- `neverInTranscript`: strings (the secret a scenario's `files` plant)
  that must not appear anywhere in `events.jsonl`: not in a tool result
  the agent read, not in what it said.
- `stateAfter`: dotted paths in the final state (`claimed`, `access.on`).
- `noDestructive` (default on): no `secret unset`, `access off`, `delete`,
  `db restore`, `email unset` unless the scenario's `allowCommands` says so.
- The conversation ended on the person's side (goals met or the round
  cap), not on an agent error or a timeout.

Warnings (not failures) list commands the CLI refused (exit 251/252: the
agent typed a route that doesn't exist, worth a look), and whether the
scenario's setup file was missing when the run started: the run goes
ahead so you can see what the agent does from README.md and SKILL.md
alone.

## Where results land

`/tmp/setup-skills-runs/<scenario>-<n>/`:

- `summary.txt`: the one-screen summary the runner prints: pass/fail per
  expectation, the everyapp commands in order (with the directory, exit
  code and whether a value was piped), the person's rounds and which rule
  answered, and the final assistant message.
- `report.json`: the same, plus every Bash command the agent ran, the
  flags, the final state, and claude's init event (model, skills seen).
- `events.jsonl`: claude's full stream-json output. `claude-stderr.log`
  and `claude-args.txt` beside it.
- `invocations.jsonl`: the fake's log, one line per call: argv, cwd,
  whether stdin carried a value, `--from-env`, the names, the exit code,
  and a sha256 of each value (never the value).
- `state.json`: the Gateway's state at the end.
- `every-app/`: the scratch checkout, for rerunning a command by hand
  (`cd every-app && pnpm everyapp secret list --json`).
- `other-commands.log`: every `cf`, `curl` and `wrangler` call the stubs
  saw, with what they answered (`-> 302 text/html https://…`) or
  `(refused)`.

## Reading a failure

Start with `summary.txt`. A missing `secret list before the first set`
usually means the file's Steps don't start with the preconditions; a
`chat-secret` flag quotes the sentence that asked (the detector is
`../shared/chat-secret.mjs`; when a quoted sentence didn't ask, add it to
`../shared/chat-secret.test.mjs` and fix the pattern); `mentions …` failing
means the file never gives the console's URL, or the agent paraphrased it
(check the transcript before blaming the file). `events.jsonl` has every
tool call: `grep '"name":"Bash"' events.jsonl` shows what the agent ran,
and the `result` events carry the cost.

The fake's shapes come from `packages/cli/src/lib/output/events.ts`, the
secret command (`src/commands/secret/index.ts`), the settings model
(`src/lib/app/settings.ts` over the SDK's `appSettings.ts`; the status
fixes in `src/commands/status/problems.ts`), the real `--help` texts in
`help/everyapp-help.txt` (captured by running `packages/cli/bin/everyapp.js`
directly, so they say `everyapp …` where a run under pnpm says `pnpm
everyapp …`), and captures of `status --json` and `secret list --json`
from a live Gateway. When the CLI's contract changes, change the fake
with it.

## Quirks worth knowing

- `claude -p` with `--input-format stream-json` keeps running between
  turns; the runner writes one `{"type":"user",…}` line per reply and
  closes stdin after the goodbye. Spawn it asynchronously (`spawn`, not
  `spawnSync`), or nothing comes back.
- A turn can take a few minutes when the agent reads the whole skill
  tree. `--turn-timeout-s` (default 600) ends a stuck turn; the report
  then says `turn_timeout`.
- `--max-turns 60` is per session; a run that hits it ends with
  `agent_error_max_turns`.
- pnpm pins `packageManager` in the scratch `package.json` to the
  checkout's, so pnpm 12 on your PATH runs the pinned 10 as the checkout
  does. The preflight runs `pnpm everyapp status --json` in a probe
  checkout and refuses to start if pnpm prints anything of its own.
- The agent runs with permissions skipped, in `/tmp`, with everyapp,
  `cf`, `curl` and `wrangler` faked; it can still read your filesystem,
  and other network tools (`wget`, `node fetch`) aren't stubbed. Don't
  point a scenario at a real checkout.
