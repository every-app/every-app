# @every-app/onboarding-loop

The onboarding loop: `pnpm loop run --harness claude --account loop-1` from
the checkout wipes a dedicated test Cloudflare account, starts one throwaway
container with the five harness binaries, hands the harness the home-page
setup prompt, plays the user for the hand-offs the prompt creates (the owner
claim over HTTP, the domain, a resume when a turn ends early), proves the
Gateway and one deployed template app from the outside, decides pass,
pass-with-intervention, fail-onboarding or fail-infra with a reason code,
wipes the account again and writes a redacted record.

The design is the spec: [docs/design/2026-10-onboarding-loop.md](../../docs/design/2026-10-onboarding-loop.md)
(sections 4.1 to 4.14 for the architecture, 5 for the clean-slate guarantee,
7 for the prompt). Every shared type lives in `src/types.ts`, each with a
pointer to the section it comes from. The test accounts and the files Ben
writes are in [docs/runbooks/onboarding-loop-test-accounts.md](../../docs/runbooks/onboarding-loop-test-accounts.md).

## What Ben runs

```
pnpm loop doctor                                   # once: build the image, check every command line
pnpm loop accounts                                 # what accounts.json and providers.env hold (names, zones; never a secret)
pnpm loop run --harness script --account loop-1    # the control: the prompt followed literally by bash
pnpm loop run --harness opencode --account loop-2 --model opencode/glm-5.3-flash   # cheapest model, while the pipeline is new
pnpm loop run --harness claude --account loop-1    # Claude Code, mode defaults, --max-budget-usd 15
pnpm loop run --harness codex --account loop-2
pnpm loop run --harness cursor --account loop-1    # provisional adapter (no fixture yet)
pnpm loop run --harness hermes --account loop-2    # provisional adapter (no fixture yet)
pnpm loop report                                   # docs/onboarding-loop/{README.md,findings.json,findings.md,runs/}
pnpm loop findings                                 # the hand-off text for the newest run; paste per destination
```

A run is 45 to 75 minutes (three cold `pnpm install`s, the gateway build,
two certificate waits, the harness, the verifier, two wipes). The driver
keeps the Mac awake (`caffeinate -i -w <pid>`), but a closed lid or a Docker
Desktop update still loses the run; the next run's wipe cleans up. Run one
lane per account: the O_EXCL lock in `~/.config/everyapp/onboarding-loop/locks/`
refuses a second run on the same account, and a wiped account waits 30
minutes before it is used again (Cloudflare's negative DNS TTL).

Useful flags: `--ref <commit>` (the commit under test, bundled into the
container; default HEAD), `--tools-ref <commit>` (the commit the sibling
containers run `everyapp teardown` from; default HEAD, because the teardown
command is on this branch and not on main yet), `--no-event-log` (the
D1-side claim as the control mode), `--claim-after turn-end` (measures
whether the agent relays the link), `--prompt-variant public` (the verbatim
prompt, once the public repository exists), `--with-access` (then `access on`
is verified as a sub-verdict), `--repeat-on-infra 1`, `--keep` (the container
stays for `docker exec`; `pnpm loop collect <runId>` copies it out later),
`--dry-run` (preflight only, no network call).

While a run is going: `docker logs -f` is useless (the container runs
`sleep infinity`); read `~/.config/everyapp/onboarding-loop/runs/<runId>/harness.stdout.redacted.log`
and `everyapp-events.ndjson` instead, and `pnpm loop answer <runId> "<text>"`
sends a person's reply at the harness's next turn end (recorded as an
intervention by a person).

## Status: what is verified, and how

No run against a real account has happened: the test accounts do not exist
yet. Everything below is proven by running it, on fakes where it has to be.

- **A whole run, on fakes** (`src/run.test.ts`): a real git repository is
  bundled, a fake Docker with a scripted `FakeSandbox` plays the container
  and the three sibling containers, a fake Cloudflare API answers the token
  gate, zones, subscriptions, D1, KV and DNS, a fake gateway answers the
  claim and the verifier's probes. The control harness goes end to end:
  preflight, wipe (`everyapp teardown --dry-run --json` then `--confirm`),
  run marker, sandbox with exactly `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID` and `EVERYAPP_EVENT_LOG`, bundle in, prompt in,
  the script in, the event-log tail feeding the scripted user and the
  claimer, the claim POSTed with `Origin` within the turn, collect and
  diff, the verifier's ten rows green from a sibling `status --json`, the
  wipe again, `run.json` with verdict `pass`, every artifact mode 600, and
  no token, provider key, owner password or `est_` link in any file or any
  line the driver printed. Also covered: a fixture `action_required`
  (`upgrade_workers_paid`) ends as `fail-infra: fixture_upgrade_workers_paid`
  with no reply to the harness; a commit without the `EVERYAPP_EVENT_LOG`
  seam switches to the D1-side claim and records the deviation `d1_claim`;
  `register_workers_subdomain` in the event log triggers the REST `PUT` and
  queues "Done, continue" for the turn end; a locked account fails preflight
  into a `fail-infra` record with nothing created; `reparse`, `replay`,
  `report`, `findings`, `answer` and `gc` over the finished run.
- **The harness turns** (`src/turns.test.ts`): stop on `DONE`; the domain
  question asked mid-turn is answered through the native resume at the turn
  end as an expected hand-off, no nudge counted; a turn without `DONE` gets
  the universal reply up to three times, then `caps_exceeded`; an exit
  without a result event is resumed twice; a reply is held while a `setup`
  is in flight in the event log; a fixture action stops the run; a person's
  queued answer goes out next; the deadline is `time_cap`; a token ceiling
  kills a harness without a budget flag (`budget`); the control (no resume)
  ends as `no_resume`.
- **The event-log feed** (`src/eventFeed.test.ts`), **the D1 client**
  (`src/gatewayD1.test.ts`: nothing while the database does not exist, then
  found once), **the HTTP fetch** (`src/httpFetch.test.ts`: method, headers,
  body, manual redirects, every `set-cookie`, 204, the injected `lookup`),
  and every lane module's own tests (harness normalizers over the captured
  fixtures, the scripted user's reply table, the claimer's retry and D1
  paths, the verifier's rows, the decision table, the record schema, the
  report whitelist, the findings ledger, preflight, locks, teardown,
  docker, redaction with a fake harness that prints `env`).
- **The image** (`Dockerfile`) builds on this Mac: 133 s cold, 7.71 GB,
  linux/arm64, node 22, pnpm 10.34.5, claude 2.1.309, codex 0.163.0,
  opencode 2.1.3, Cursor agent, Hermes. **`pnpm loop doctor`** runs each
  adapter's turn-1 line against `--help` inside it as `dev` (the lines come
  from `src/harnesses`, so what doctor checks is what a run executes). Live
  on 2026-10-24 against `everyapp-loop:96d9980d10e4`: every flag of the
  five lines is in its help, Cursor's `--trust` and `--sandbox` and Hermes's
  `--query-file` included (`agent 2026.10.22-27dcf5f`, `Hermes Agent
v0.22.5`); exit 0.
- **`pnpm loop run --harness script --account stub --dry-run`** goes through
  preflight for real with the stub account (the environment, the forbidden
  id, the rotate markers, the lock, the 30-minute gap, `docker info` with the
  memory recorded, stale `loop-*` containers removed, the container's clock
  against the host's, the listeners a container can reach) and stops: the
  token, zone, plan, workers.dev and docs checks are skipped with the reason,
  no network call is made, nothing is created.
- **The Docker sandbox** (`src/docker.ts`) was exercised live against the
  image: create, exec streamed and redacted, `CI` unset inside, a timeout
  kills the whole process group, `tail -F` of a file that does not exist
  yet, `docker diff`, `docker cp`, `docker rm`.

## Not verified until the accounts exist (the first live run's checklist)

Run `pnpm loop run --harness script --account loop-1` first, read its log and
`run.json`, and check each of these before any model harness runs:

1. **The token gate on a real token**: `GET /user/tokens/verify` answers
   `active`, `/accounts` lists exactly the one account; a token that sees
   both lanes is refused (`token_too_broad`) by design.
2. **The Free-plan live check** (TODO.md, onboarding audit): on the account
   that is still Free, preflight prints `plan free`, and `setup` must stop on
   `upgrade_workers_paid` (the run is then `fail-infra:
fixture_upgrade_workers_paid`, as intended). Keep the subscription rows
   from `inventory-before.json`'s neighbour `decide-input.json` and the
   preflight log for `packages/cli/src/lib/cf/plan.test.ts`. Then buy Workers
   Paid.
3. **The workers.dev subdomain**: preflight records `workers_subdomain:
first-run`; whether `setup` really stops on `register_workers_subdomain`
   is unknown. If it does, the loop PUTs `everyapp-loop<n>` and replies
   "Done, continue"; the record's `handoffs.exercised` says which happened,
   and cf's real error text is in `harness.stdout.redacted.log`.
4. **`everyapp teardown` inside the sibling container**: the clone of the
   bundle and `pnpm install` there, `--dry-run --json`'s plan shape
   (`src/teardownStep.ts` `flattenPlan` was written from `planData()` in
   `packages/cli`), the typed confirmation from
   `confirm-<accountId>`, how Cloudflare lists a certificate pack
   mid-deletion (the loop re-polls for 3 minutes), and that the DNS check
   finds nothing at or under `apps.<zone>` afterwards.
5. **The event-log claim end to end**: the seam (`EVERYAPP_EVENT_LOG`, PR
   #446) is on `origin/main` but **not on this branch's HEAD**; a run with
   the default `--ref HEAD` therefore claims D1-side and records `d1_claim`.
   To exercise the event-log claim, pass `--ref origin/main` (or any commit
   with the seam) and keep `--tools-ref HEAD` for the teardown. The D1 path
   itself (poll `owner_setup_tokens`, replace the hash, POST) is unverified
   against a live gateway.
6. **The verifier's fingerprints** against the real gateway and app host:
   `403 ORIGIN_NOT_ALLOWED`, `404 unknown_app_host`, the `302` to
   `/sign-in?return_to=`, the `401 unauthenticated`, Better Auth's
   `set-cookie` and `get-session`, the template marker `Todos` on the
   signed-in page (A3 stays `perimeter-only` until the cookie domain covers
   `*.apps.<zone>`), and `status --json`'s `claimed`, `apps[].status/bound`,
   `upToDate` and `fixes[].severity`.
7. **Authoritative DNS** (`src/dns.ts`) against a real zone, and whether this
   Mac's resolver shows the negative-cache state the 30-minute gap exists
   for.
8. **The certificate waits**: every run deletes the packs (the teardown's
   step 5), so two first-time certificate waits per run; if Cloudflare's
   certificate-order limits bite, it shows here.
9. **Docker Desktop's memory**: 7.75 GiB today; preflight warns and asks for
   16 GiB. `docker stats` sampling (`stats.jsonl`, `substrate.statsPeakMiB`)
   says whether 6 GiB per container is enough for `pnpm install` plus the
   gateway build.
10. **Cursor and Hermes** are provisional (no fixture; flags `--trust`,
    `--sandbox disabled`, `--resume`, `--query-file`, `HERMES_YOLO_MODE`,
    `TERMINAL_TIMEOUT`, the model id are from docs); `pnpm loop doctor`
    settles the flags, a captured `fixtures/<harness>/sample.jsonl` settles
    the normalizers (`fixtures/README.md` has the commands).

Known limits of this build: Claude Code's `raised` mode (one long-lived
`--input-format stream-json` process) is not built, `--mode defaults` only;
`--parallel 2` is checked by preflight but two lanes at once are not run by
one command (start two `pnpm loop run`s on two accounts); Hermes's `clarify`
tool is detected as a hesitation but the process is not killed early; the
`idle loop` distinction under the time cap is not measured (a time cap is
`fail-infra: time_cap`); `pnpm loop verify <runId>` re-runs the probes but
O1, A3 and S1 cannot pass again (the owner password lived only in the run
that made it; no sibling container).

## Rules

- Never a secret in output: every subprocess line and the driver's own
  stdout go through `redact()` before they reach a file or a terminal; the
  owner password is added to the redactor the moment it is minted; collected
  session stores are rewritten through it. A counter in
  `run.json.secret_exposure` says what an agent echoed; a token or provider
  key echoed writes `rotate.json`, prints `ROTATE:`, and preflight refuses
  that value until it is rolled.
- Never Ben's account, never the host's `cf` login: every token-bearing
  call runs in a sibling container with exactly the test account's token,
  and the Cloudflare API is reached from the host only through typed
  `fetch` (`src/cf.ts`). `23bc28f0b638fbfc1c7f838573c17ee3` is refused by
  constant.
- No imports from `packages/cli` source; the loop shells out to
  `pnpm everyapp … --json` inside the containers.
- The driver refuses to start when `EVERYAPP_TEST_ACCOUNTS`,
  `CLOUDFLARE_API_TOKEN` or `EVERYAPP_GATEWAY_URL` is in its own environment.
- Committed output (`pnpm loop report`) is a whitelist: no zone, account id,
  host, email, session id, raw text, cookie, `est_`, key or bearer; the
  hosts each record names (gateway, app, zone) are scrubbed from every
  excerpt and asserted absent; a run whose `secret_exposure` counters say
  the token or a key was echoed is not committed at all (`ROTATE:` first).

## Files Ben writes (design 6)

`~/.config/everyapp/onboarding-loop/accounts.json` (mode 600,
`{"accounts":[{"name","accountId","zone","email","token"}]}`),
`providers.env` (mode 600, `ANTHROPIC_API_KEY=…`, `CODEX_API_KEY=…`,
`OPENCODE_API_KEY=…`, `CURSOR_API_KEY=…`), and `confirm-<accountId>` (mode
600, the one line `delete everything in <accountId>`) for unattended wipes;
without it the account id is typed at `/dev/tty`.

## The run directory

`~/.config/everyapp/onboarding-loop/runs/<runId>/` (mode 700): `run.json`
(schema v1, design 4.9), `events.jsonl` (normalized harness events with a
process index), `harness.raw.redacted.jsonl` (every harness line per
process and stream, for `reparse`), `harness.stdout.redacted.log`,
`harness.stderr.redacted.log`, `everyapp-events.ndjson` (the CLI's event
log), `verify.json`, `inventory-before.json`, `inventory-after.json`,
`diff.txt`, `git-status.txt` (`git status --porcelain` over the gateway,
packages and templates in the harness's checkout: the taint source),
`versions.txt` (every binary's `--version` and `ls -la $HOME` in the
container), `prompt.txt`, `stats.jsonl`, `assemble-input.json` and
`decide-input.json` (what `reparse` and `replay` rebuild from),
`teardown.sibling.redacted.log`, `verify.sibling.redacted.log`,
`collected/` (`/loop` and the harness's session store, redacted; a file over
50 MiB is replaced by a note, a binary file is left as it is and named in the
log), and `rotate.json` when a secret was echoed. `run.json`,
`verify.json` and the two inputs are written through the run's redactor
too, so a token an agent echoed in its last line never lands in the record
(`artifacts.transcript` names `harness.raw.redacted.jsonl`).

## Commands

```
pnpm loop --help
pnpm loop run …                        # above
pnpm loop doctor [--rebuild]
pnpm loop accounts
pnpm loop teardown --account <name> [--dry-run] [--force] [--ref <commit>]
pnpm loop verify <runId> | reparse <runId> | replay <runId> | answer <runId> "<text>" | collect <runId>
pnpm loop report | findings [runId] [--onboarding-dx <id>] [--agent-docs <id>] | gc [--days n]
# gc removes old run directories, stale locks, temp dirs and every loop-* container
# that no run with a live lock owns (running or not); preflight removes only
# stopped ones, and never under --dry-run. Ctrl-C during a run removes the
# container, expires open setup links, wipes the account and releases the lock.
pnpm -C packages/onboarding-loop test        # vitest over fixtures and fakes
pnpm -C packages/onboarding-loop types:check
pnpm -C packages/onboarding-loop knip
pnpm -C packages/onboarding-loop format:check
```

## Layout

`src/run.ts` (the driver and state machine), `cli.ts`, `turns.ts` (the
harness's turns with the scripted user), `eventFeed.ts` (the event log to
scripted-user inputs), `assemble.ts` (artifacts to `run.json` and the
decision; pure), `maintenance.ts` (the commands over finished runs),
`httpFetch.ts`, `gatewayD1.ts`, `commands.ts` (`teardown`, the arg parser);
the lanes' modules `types.ts`, `accounts.ts`, `lock.ts`, `redact.ts`,
`spawn.ts`, `sandbox.ts`, `docker.ts`, `withTestAccount.ts`, `preflight.ts`,
`teardownStep.ts`, `cf.ts`, `dns.ts`, `doctor.ts`, `harnesses/*`,
`scriptedUser.ts`, `claim.ts`, `verify.ts`, `decide.ts`, `parse/*`,
`record.ts`, `report.ts`, `findings.ts`, `prompt.ts`.
