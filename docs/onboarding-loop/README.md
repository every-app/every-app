# Onboarding loop: runs

Written by `pnpm loop report` from the per-run records on the machine that ran the loop
(design: docs/design/2026-10-onboarding-loop.md). Whitelisted fields only: no zone, account,
host, email, session id or raw agent text. Each row names the CLI commit and prompt sha it measured;
compare rows only within the same harness, model, prompt sha, commit and image.

CLI commits and prompt shas in this table: e41110c7c10c (prompt e4216a2423a5).

## Runs

| run | harness version | model (resolved) | mode | cli commit | prompt sha | verdict | reason | phase reached | wall / install / setup / cert / deploy | everyapp cmds ok/err | link→claim s | hesitations by kind | interventions | app by | claim how | terminal reason | cost (source) | signal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-24T10:20-script-none-c58fad | script bash | - | - | e41110c7c10c | e4216a2423a5 | pass | - | app-live | 268s / 9s / 51s / 41s / 78s | 3/0 | 1 | none | 0 | harness | event-log | completed | - (none) | full/full/none/none |

## Hand-off coverage

| hand-off | script |
| --- | --- |
| domain_question | skipped: not reached |
| claim_owner | exercised 1/1 |
| register_workers_subdomain | skipped: workers.dev name preexisting |
| create_app | skipped: not reached |
| ACCESS_TEAM_REQUIRED | skipped: no --with-access |

## Findings

| key | area | status | first seen (cli) | last seen (cli) | harness × runs | excerpt | proposed fix | link |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CUSTOM_DOMAIN_OWNER_UNCHECKED\|setup | cli | open | 2026-10-24 (e41110c7) | 2026-10-24 (e41110c7) | script×1 | CUSTOM_DOMAIN_OWNER_UNCHECKED from `everyapp setup --domain apps.<zone> --json` | - | - |
| CUSTOM_DOMAIN_OWNER_UNCHECKED\|deploy | cli | open | 2026-10-24 (e41110c7) | 2026-10-24 (e41110c7) | script×1 | CUSTOM_DOMAIN_OWNER_UNCHECKED from `everyapp deploy --json` | - | - |
| ACCESS_NOT_CHECKED\|deploy | cli | open | 2026-10-24 (e41110c7) | 2026-10-24 (e41110c7) | script×1 | ACCESS_NOT_CHECKED from `everyapp deploy --json` | - | - |
| status\|GATEWAY_OUTDATED | cli | open | 2026-10-24 (e41110c7) | 2026-10-24 (e41110c7) | script×1 | status from a fresh clone of the same commit calls the Gateway outdated: an app created inside the checkout rewrites pnpm-lock.yaml, which the Gateway's tree hash covers | give an app created inside the checkout its own workspace (as one outside it has), or hash only the Gateway's lockfile importers | - |

The ledger is `findings.json`; `pnpm loop findings` renders the hand-off text per destination.
