# Onboarding loop: runs

Written by `pnpm loop report` from the per-run records on the machine that ran the loop
(design: docs/design/2026-10-onboarding-loop.md). Whitelisted fields only: no zone, account,
host, email, session id or raw agent text. Each row names the CLI commit and prompt sha it measured;
compare rows only within the same harness, model, prompt sha, commit and image.

CLI commits and prompt shas in this table: e41110c7c10c (prompt e4216a2423a5), f2a1000de452 (prompt e4216a2423a5), a775e3d5c331 (prompt e4216a2423a5).

## Runs

| run | harness version | model (resolved) | mode | cli commit | prompt sha | verdict | reason | phase reached | wall / install / setup / cert / deploy | everyapp cmds ok/err | link→claim s | hesitations by kind | interventions | app by | claim how | terminal reason | cost (source) | signal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-24T13:03-claude-opus55-bfc389 | claude 2.1.309 | claude-opus-5-5 | defaults | a775e3d5c331 | e4216a2423a5 | pass | - | app-live | 348s / 9s / 57s / 40s / 84s | 3/0 | 9 | ended_turn_without_done×2, asked_user×2 | 0 | harness | event-log | completed | $0.21 (harness) | full/truncated/harness/native |
| 2026-10-24T10:59-codex-gpt53codex-26b723 | codex 0.163.0 | gpt-5.3-codex | - | f2a1000de452 | e4216a2423a5 | pass-with-intervention | nudge | app-live | 285s / - / 50s / 40s / 80s | 3/0 | 1 | ended_turn_without_done×1 | 1 | harness | event-log | completed | - (tokens_x_list) | full/full/tokens_x_list/native |
| 2026-10-24T10:40-claude-opus55-022ccf | claude 2.1.309 | claude-opus-5-5 | defaults | f2a1000de452 | e4216a2423a5 | pass | - | app-live | 272s / - / 50s / 40s / 78s | 3/0 | 0 | ended_turn_without_done×1, asked_user×1 | 0 | harness | event-log | completed | $0.20 (harness) | full/truncated/harness/native |
| 2026-10-24T10:20-script-none-c58fad | script bash | - | - | e41110c7c10c | e4216a2423a5 | pass | - | app-live | 268s / 9s / 51s / 41s / 78s | 3/0 | 1 | none | 0 | harness | event-log | completed | - (none) | full/full/none/none |

## Hand-off coverage

| hand-off | claude | codex | script |
| --- | --- | --- | --- |
| domain_question | exercised 2/2 | skipped: not reached | skipped: not reached |
| claim_owner | exercised 2/2 | exercised 1/1 | exercised 1/1 |
| register_workers_subdomain | skipped: workers.dev name preexisting | skipped: workers.dev name preexisting | skipped: workers.dev name preexisting |
| create_app | skipped: not reached, not a question: the harness ran create | skipped: not reached | skipped: not reached |
| ACCESS_TEAM_REQUIRED | skipped: no --with-access | skipped: no --with-access | skipped: no --with-access |

## Findings

| key | area | status | first seen (cli) | last seen (cli) | harness × runs | excerpt | proposed fix | link |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CUSTOM_DOMAIN_OWNER_UNCHECKED\|setup | cli | open | 2026-10-24 (e41110c7) | 2026-10-24 (a775e3d5) | script×1, claude×2, codex×1 | CUSTOM_DOMAIN_OWNER_UNCHECKED from `everyapp setup --domain apps.<zone> --json` | - | - |
| CUSTOM_DOMAIN_OWNER_UNCHECKED\|deploy | cli | open | 2026-10-24 (e41110c7) | 2026-10-24 (a775e3d5) | script×1, claude×2, codex×1 | CUSTOM_DOMAIN_OWNER_UNCHECKED from `everyapp deploy --json` | - | - |
| ACCESS_NOT_CHECKED\|deploy | cli | open | 2026-10-24 (e41110c7) | 2026-10-24 (a775e3d5) | script×1, claude×2, codex×1 | ACCESS_NOT_CHECKED from `everyapp deploy --json` | - | - |
| status\|GATEWAY_OUTDATED | cli | open | 2026-10-24 (e41110c7) | 2026-10-24 (a775e3d5) | script×1, claude×2, codex×1 | status from a fresh clone of the same commit calls the Gateway outdated: an app created inside the checkout rewrites pnpm-lock.yaml, which the Gateway's tree hash covers | give an app created inside the checkout its own workspace (as one outside it has), or hash only the Gateway's lockfile importers | - |
| ended_turn_without_done\|-\|- | prompt | open | 2026-10-24 (f2a1000d) | 2026-10-24 (a775e3d5) | claude×2 | Install done. Which domain should I use? (Setup will run at `apps.<your domain>`.) | - | - |
| asked_user\|-\|- | prompt | open | 2026-10-24 (f2a1000d) | 2026-10-24 (a775e3d5) | claude×2 | Which domain should I use? | - | - |
| ended_turn_without_done\|-\|- | loop | open | 2026-10-24 (f2a1000d) | 2026-10-24 (f2a1000d) | codex×1 | Great — I’ll start in `/work/every-app`, install deps, then pause to ask your domain before running setup. | - | - |
| ended_turn_without_done\|setup --domain apps.<zone> --json > /tmp/setup.log 2>&1; echo EXIT $? >> /tmp/setup.log\|- | prompt | open | 2026-10-24 (a775e3d5) | 2026-10-24 (a775e3d5) | claude×1 | The Gateway is live. **Your turn:** open this link to create the owner account. It works once and expires in 24 hours, so treat it like a password: <url> | - | - |
| asked_user\|setup --domain apps.<zone> --json > /tmp/setup.log 2>&1; echo EXIT $? >> /tmp/setup.log\|- | prompt | open | 2026-10-24 (a775e3d5) | 2026-10-24 (a775e3d5) | claude×1 | waiting for you | - | - |

The ledger is `findings.json`; `pnpm loop findings` renders the hand-off text per destination.
