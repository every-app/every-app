# The build-every-app skill, run end to end

A harness that runs the build skill (`packages/cli/skills/build-every-app/`)
the way it will be used: a coding agent (`claude -p`) in a fresh app, a
person asking for a feature in the chat, `pnpm test` and `pnpm types:check`
on the other side. The app is a copy of the starter as `everyapp create`
makes it, with both skills in place; its `pnpm everyapp` is the setup-skill
harness's fake (`../setup-skills/fake-everyapp.mjs`), which answers `dev`,
`deploy` and `create` with a done event and does nothing. What it checks is
the skill file, not the agent's taste: did the agent read the skill before
touching a file, go through drizzle for the table, give every tool a risk,
leave identity to the Gateway, keep the app's checks green, deploy nothing,
and close in plain words.

It needs the `claude` CLI logged in (it spends real tokens: well under a
dollar a scenario on sonnet; the runs below cost $0.13 to $0.19) and it is
**not run in CI**. CI runs the static
tests beside the skill, `packages/cli/src/lib/app/buildSkill.test.ts`
(frontmatter, every cited path, every `pnpm everyapp` route) and this
harness's own readers, `app-checks.test.mjs`. The setup skills have the
same arrangement: `../setup-skills/README.md`.

## Run it

From the checkout root, after one root `pnpm install` (the SDK built, the
starter installed):

```bash
node packages/cli/test/build-skill/run.mjs add-notes                 # one scenario, sonnet
node packages/cli/test/build-skill/run.mjs add-notes --model opus    # a stronger reader
node packages/cli/test/build-skill/run.mjs add-notes --scratch-only  # build and check the scratch, start no agent
node packages/cli/test/build-skill/run.mjs all --keep-going
node packages/cli/test/build-skill/run.mjs --help
```

Scenarios live in `scenarios/<name>.json`. A run takes one to five minutes
(46 s to 4 min 10 s so far); the exit code is 0 when every expectation held.

Sonnet is the default on purpose: a weaker reader finds the gaps in a
skill that a stronger one papers over. Read the transcript, not only the
verdict.

## What a run does

For each scenario, under `/tmp/build-skill-runs/<scenario>-<n>/`:

1. Makes a scratch checkout, `every-app/`: a root `package.json`, a
   `node_modules/.bin/everyapp` that runs the fake, both skills under
   `.claude/skills/` and `.agents/skills/`, an `AGENTS.md` and `CLAUDE.md`
   like the checkout's. Under `apps/<id>/` (the scenario's `app`), the
   starter as `everyapp create <id>` copies it (`lib/app/starter.ts`'s
   exclusions, the id and name in `everyapp.config.ts`, `package.json`
   and the README's title) with every skill the CLI ships copied in as
   `lib/app/skill.ts` does, so the app's own `AGENTS.md` points at both.
   The app's `node_modules/` is the starter's, linked entry by entry (so
   vitest, tsc, drizzle-kit, vite and the SDK resolve as in `starter/`),
   except `everyapp` (the fake) and `cf` (a stub that hands `cf workers
   types` to the real cf, which only writes `.cloudflare/types`, and
   refuses everything else). `scenario.appFiles` can add or replace files
   in the app before the run.
2. Runs the app's checks in the scratch before the agent starts: `pnpm
   everyapp status --json` (the fake, from the app's directory), `pnpm
   test`, `pnpm types:check` (which generates the Worker types once) and
   `pnpm run db:generate` (which must say there is nothing to migrate).
   A failure here stops the run: a red check at the end would say nothing
   about the skill. `--scratch-only` stops after this step on purpose.
3. Keeps a `pristine/` copy of the app for the diff at the end.
4. Starts `claude -p --output-format stream-json --input-format stream-json
   --verbose --dangerously-skip-permissions --max-turns 150 --model <model>`
   in the app's directory (`scenario.cwd: "root"` for the checkout's), as
   the setup-skill harness does: `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`
   removed, `--setting-sources project,local --strict-mcp-config` unless
   `--full-settings`. On the child's PATH, first: `cf` (types only),
   `wrangler` and `curl` are stubs that log every call to
   `other-commands.log` and refuse it.
5. Plays the person: the scenario's `prompt` first, then after each
   assistant turn the reply of the first rule whose `when` matches the
   assistant's last message. The rule fields (`when`, `reply`, `once`,
   `flag`, `use` for a shared rule: `chat-secret`, `check-result`,
   `opened-url`, `yes`) are the setup-skill harness's, in
   `../shared/person.mjs`. With no rule matched, the person says the
   scenario's `defaultReply` ("Go on.") until the round cap
   (`maxRounds`, default 6), or ends the conversation once the goals are
   met (the schema changed, a migration exists, the tools are there) and
   the assistant isn't asking for anything.
6. Snapshots the app again (`after/`), writes `app.diff` (`git diff
   --no-index pristine after`), regenerates `src/routeTree.gen.ts` when
   the agent added a route file without rebuilding (what `pnpm dev` does;
   the fake dev doesn't; the report says so), runs `pnpm test` and `pnpm
   types:check` in the app, checks the expectations and writes the report.

## What a pass means

Every expectation held (each can be switched off in `expect`):

- `readSkill`: a Read of `skills/build-every-app/SKILL.md` (either copy),
  a Bash command that prints it, or the Skill tool invoking
  `build-every-app`, came before the first edit (an Edit, Write or
  MultiEdit or NotebookEdit call, or a Bash command that writes: a
  redirect, `tee`, `sed -i`, `cp`, `mv`, `rm`, `db:generate`, `drizzle-kit
  generate`).
- `readPatterns`: the same for `patterns.md`.
- `schema`: `src/db/schema.ts` differs from the starter's.
- `migration`: a new `.sql` under `drizzle/`; the report says whether
  `pnpm run db:generate` wrote it or the agent did by hand.
- `tools`: `src/tools.ts` gained at least `tools.min` tools whose names
  match `tools.nameMatches` (optional), and every added tool has a `risk`
  of `read`, `write` or `destructive` (`app-checks.mjs` `toolsDefined`
  walks the `defineTools({ … })` literal).
- `keep`: files the ask leaves alone still exist (the add-notes scenario
  keeps the todo list's queries, test, server functions and migration:
  "add" is not "replace").
- `noAuthCode`: no added line of code (comments and markdown excluded)
  mentions a login, session, password, JWT, cookie or authorization
  (`AUTH_PATTERN`).
- `noClientHeaders`: no added line reads a request header or spells out
  the Gateway's header names (`CLIENT_HEADER_PATTERN`).
- `neverDeploy`: the fake saw no `deploy`, `release`, `install`, `update`,
  `setup`, `delete` or `login`; the stubs saw no `cf` call but `--version`
  and `workers types`, and no `wrangler` at all.
- `checks`: `pnpm test` and `pnpm types:check` pass in the app after the
  run.
- `finalMentions` (default `["pnpm dev"]`) and `finalPattern`: the
  closing says each (case-insensitive). The closing is what the agent
  said once the work was done: from the wrap-up (the first message after
  the goals were met) to the message the person ended on. Without a
  wrap-up (the round cap came first), it is the message the person ended
  on, plus the one before any trailing default replies.
- `mustMention`: strings that must appear somewhere in the assistant's
  text.
- `neverAskedInChat`: no `chat-secret` flag.
- `noDestructive`: no `secret unset`, `access off`, `delete`, `db
  restore`, `email unset` (`allowCommands` excepts).
- The conversation ended on the person's side (goals met or the round
  cap), not on an agent error or a timeout.

Warnings (not failures): commands the CLI refused (exit 251/252), fake
commands the agent ran (`dev`, `create`: answered, nothing happened),
files changed outside `src/`, `drizzle/` and `everyapp.config.ts`, a route
tree the harness had to regenerate, and a run that hit the round cap.

## Where results land

`/tmp/build-skill-runs/<scenario>-<n>/`:

- `summary.txt`: the one-screen summary: pass/fail per expectation, the
  tool calls by kind, the fake everyapp commands, the changed files, the
  person's rounds and the final message.
- `report.json`: the same plus every tool call in order (`toolUses`:
  sequence, tool, trimmed input), every Bash command, the tools added,
  the checks' output tails, and claude's init event.
- `events.jsonl`: claude's full stream-json output; `claude-stderr.log`
  and `claude-args.txt` beside it.
- `app.diff`: what the agent changed, against `pristine/`; `after/` is the
  snapshot it was made from.
- `checks.log`: the full output of every `pnpm` check the harness ran,
  before and after.
- `invocations.jsonl`, `state.json`: the fake's log and the Gateway's state.
- `other-commands.log`: every `cf`, `wrangler` and `curl` call the stubs saw.
- `every-app/apps/<id>/`: the app as the agent left it, with its
  `node_modules` links, for rerunning anything by hand.

## The app checkouts

`buildSkill.test.ts` checks every `open-crm/…`, `open-analytics/…`,
`open-seo/…` and `open-mail/…` path the skill cites against a checkout
of that repository, looked for under `$EVERYAPP_APP_CHECKOUTS` (default
`~/workspaces`) by the name it is cited under, and skips that app with the
reason when the directory isn't there or has no `everyapp.config.ts`. The
test's title records the commit each checkout was at. A clone kept under
another name or somewhere else is named per app, comma-separated:

```bash
EVERYAPP_APP_CHECKOUTS=open-seo=/path/to/your/open-seo/clone,open-mail=/path/to/another \
  pnpm -C packages/cli exec vitest run src/lib/app/buildSkill.test.ts
```

A bare path in the variable is the directory for all four; a `name=path`
pair wins for its app.

## Reading a failure

Start with `summary.txt`. `read … before the first edit` failing with
"never read" means the skill wasn't found or wasn't wanted: check the init
event's `skills` in `report.json` and what the agent read instead
(`toolUses`). A migration "written by hand" with a passing test is a
skill gap worth a sentence (rule 9 says `db:generate`). A failing
`types:check` after the run with a new route file and no regeneration
warning means the agent broke a type, not the route tree. `app.diff` is
the whole change; read it before blaming the skill for a style you don't
like: the expectations are the skill's rules, nothing more.

## Runs so far

The add-notes scenario on sonnet, 2026-10-24, as the skill and the harness
changed between runs. Every run built the same thing: a `notes` table keyed
by the organization, queries in `src/server/notes.ts` filtered by
`user.orgId`, a test that two organizations' notes stay apart, two tools
(`list_notes` read, `add_note` write), the page, a migration from `pnpm
run db:generate`; every run kept the app's checks green and deployed
nothing.

| Run | Time, cost    | What failed first                                                                                                                                                                                      | What changed after it                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 4m10s, $0.19  | `patterns.md` never read: the agent invoked the skill, read the starter's files and went straight to code. Its first edit was `rm -rf` of the todo list, its test and its migration: "add" became "replace", and the first screen went with it. | The skill: "Read first" now starts with `patterns.md`, "before the first edit, every time", with what to read for which job; a new paragraph, "Add means add", keeps the todo list and the first screen until the person asks for a different app. The harness: `rm` counts as a write, a `keep` expectation (the scenario lists the todo files), deleted files no longer reported under `pristine/`. |
| 2   | 54s, $0.16    | `patterns.md` reported never read, but it was: `grep -B2 -A12 "orgId" …/patterns.md \| head -80` before the first edit. The detector anchored the file name to the end of the command.                   | The harness: the file patterns match anywhere in a Bash command (`SKILL_FILE`, `PATTERNS_FILE` in `app-checks.mjs`, with the case in the test). The todos stayed; the migration was `0001_…` on top of the starter's.                                                                                                                                                 |
| 3   | 46s, $0.13    | Every skill expectation held. `final message says "pnpm dev"` failed on a quirk: the wrap-up said it, the person's "I ran pnpm dev" drew a follow-up that didn't, and the check read only the follow-up. | The harness: the closing is everything the agent said from the wrap-up (the first message after the goals were met) to the end.                                                                                                                                                                                                                                      |
| 4   | 3m05s, $0.15  | Nothing: PASS.                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                             |

Still open, from the transcripts: the agent never ran the interview the
skill asks for (a clear request, so fine) and never offered the "‹ Every
App" link check or `/security-review` beyond naming it. Opus has not run
yet.
