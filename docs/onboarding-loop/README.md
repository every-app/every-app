# Onboarding loop: runs

Written by `pnpm loop report` from the per-run records on the machine that ran the loop
(design: docs/design/2026-10-onboarding-loop.md). Whitelisted fields only: no zone, account,
host, email, session id or raw agent text. Each row names the CLI commit and prompt sha it measured;
compare rows only within the same harness, model, prompt sha, commit and image.

CLI commits and prompt shas in this table: e41110c7c10c (prompt e4216a2423a5), f2a1000de452 (prompt e4216a2423a5), a775e3d5c331 (prompt e4216a2423a5), 931ff03991e1 (prompt 217d257562ca), 6b142b18da98 (prompt 217d257562ca), 6f73c77f508d (prompt 4e2e4017da7f), df0fed7e1640 (prompt 8e73bee94bb9).

## Runs

| run | harness version | model (resolved) | mode | cli commit | prompt sha | verdict | reason | phase reached | wall / install / setup / cert / deploy | everyapp cmds ok/err | link→claim s | hesitations by kind | interventions | app by | claim how | terminal reason | cost (source) | signal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-26T13:01-script-none-afe986 | script bash | - | - | df0fed7e1640 | 8e73bee94bb9 | pass | - | app-live | 321s / 10s / 71s / 58s / 73s | 3/0 | 0 | none | 0 | harness | event-log | completed | - (none) | full/full/none/none |
| 2026-10-26T11:24-claude-opus55-dacece | claude 2.1.309 | claude-opus-5-5 | defaults | df0fed7e1640 | 8e73bee94bb9 | fail-onboarding | false_done | app-live | 793s / 10s / 69s / 57s / 66s | 7/0 | 1 | ended_turn_without_done×3, tool_output_truncated×2, asked_user×1 | 1 | harness | event-log | completed | $0.71 (harness) | full/truncated/harness/native |
| 2026-10-26T07:51-claude-opus55-bdaffd | claude 2.1.309 | claude-opus-5-5 | defaults | 6f73c77f508d | 4e2e4017da7f | pass-with-intervention | no_done | app-live | 439s / 12s / 65s / 54s / 91s | 4/4 | 0 | tool_output_truncated×1, ended_turn_without_done×2, asked_user×2, repeated_command×3 | 2 | harness | event-log | completed | $0.48 (harness) | full/truncated/harness/native |
| 2026-10-26T07:19-script-none-1d10c4 | script bash | - | - | 6f73c77f508d | 4e2e4017da7f | pass | - | app-live | 778s / 35s / 174s / 155s / 182s | 3/0 | 1 | none | 0 | harness | event-log | completed | - (none) | full/full/none/none |
| 2026-10-24T21:28-opencode-gpt61sol-02aadb | opencode 2.1.3 | openai/gpt-6.1-sol | - | 6b142b18da98 | 217d257562ca | pass-with-intervention | nudge | app-live | 333s / 0s / 0s / 50s / 91s | 3/0 | 1 | asked_user×1, tool_output_truncated×1, blocked_for_question×1, ended_turn_without_done×1, repeated_command×1, background_killed×1 | 1 | harness | event-log | completed | $0.08 (harness) | full/truncated/harness/native |
| 2026-10-24T20:40-opencode-gpt61sol-3f4448 | opencode 2.1.3 | openai/gpt-6.1-sol | - | 6b142b18da98 | 217d257562ca | fail-onboarding | everyapp_error:CF_NOT_FOUND | gateway-db | 1108s / 0s / 47s / - / - | 0/1 | - | tool_output_truncated×4, asked_user×2, ended_turn_without_done×1, source_read×3 | 0 | none | none | blocked | $0.16 (harness) | full/truncated/harness/native |
| 2026-10-24T20:40-codex-gpt61sol-bbf950 | codex 0.163.0 | gpt-6.1-sol | - | 6b142b18da98 | 217d257562ca | pass | - | app-live | 322s / 4s / 72s / 46s / 92s | 4/0 | 0 | blocked_for_question×1 | 0 | harness | event-log | completed | - (tokens_x_list) | full/full/tokens_x_list/native |
| 2026-10-24T19:30-opencode-gpt53codex-019400 | opencode 2.1.3 | openai/gpt-5.3-codex | - | 931ff03991e1 | 217d257562ca | pass | - | app-live | 314s / 0s / 67s / 56s / 79s | 3/0 | 1 | tool_output_truncated×1, ended_turn_without_done×1, asked_user×1 | 0 | harness | event-log | completed | $0.09 (harness) | full/truncated/harness/native |
| 2026-10-24T13:03-claude-opus55-bfc389 | claude 2.1.309 | claude-opus-5-5 | defaults | a775e3d5c331 | e4216a2423a5 | pass | - | app-live | 348s / 9s / 57s / 40s / 84s | 3/0 | 9 | ended_turn_without_done×2, asked_user×2 | 0 | harness | event-log | completed | $0.21 (harness) | full/truncated/harness/native |
| 2026-10-24T10:59-codex-gpt53codex-26b723 | codex 0.163.0 | gpt-5.3-codex | - | f2a1000de452 | e4216a2423a5 | pass-with-intervention | nudge | app-live | 285s / - / 50s / 40s / 80s | 3/0 | 1 | ended_turn_without_done×1 | 1 | harness | event-log | completed | - (tokens_x_list) | full/full/tokens_x_list/native |
| 2026-10-24T10:40-claude-opus55-022ccf | claude 2.1.309 | claude-opus-5-5 | defaults | f2a1000de452 | e4216a2423a5 | pass | - | app-live | 272s / - / 50s / 40s / 78s | 3/0 | 0 | ended_turn_without_done×1, asked_user×1 | 0 | harness | event-log | completed | $0.20 (harness) | full/truncated/harness/native |
| 2026-10-24T10:20-script-none-c58fad | script bash | - | - | e41110c7c10c | e4216a2423a5 | pass | - | app-live | 268s / 9s / 51s / 41s / 78s | 3/0 | 1 | none | 0 | harness | event-log | completed | - (none) | full/full/none/none |

## Hand-off coverage

| hand-off | claude | codex | opencode | script |
| --- | --- | --- | --- | --- |
| early_adopter_question | exercised 1/4 | not seen | not seen | skipped: not asked: the harness ran setup |
| domain_question | exercised 3/4 | exercised 1/2 | exercised 3/3 | skipped: not reached, not asked: the harness ran setup |
| claim_owner | exercised 4/4 | exercised 2/2 | exercised 2/3 | exercised 3/3 |
| register_workers_subdomain | skipped: workers.dev name preexisting | skipped: workers.dev name preexisting | skipped: workers.dev name preexisting | skipped: workers.dev name preexisting |
| create_app | skipped: not reached, not a question: the harness ran create | skipped: not reached, not a question: the harness ran create | skipped: not a question: the harness ran create, not reached | skipped: not reached, not a question: the harness ran create |
| four_apps_question | exercised 1/4 | not seen | not seen | skipped: not asked: no install ran |
| ACCESS_TEAM_REQUIRED | skipped: no --with-access | skipped: no --with-access | skipped: no --with-access | skipped: no --with-access |

## Findings

| key | area | status | first seen (cli) | last seen (cli) | harness × runs | excerpt | proposed fix | link |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CUSTOM_DOMAIN_OWNER_UNCHECKED\|setup | cli | open | 2026-10-24 (e41110c7) | 2026-10-26 (df0fed7e) | script×3, claude×4, codex×2, opencode×3 | CUSTOM_DOMAIN_OWNER_UNCHECKED from `everyapp setup --domain apps.<zone> --json` | - | - |
| CUSTOM_DOMAIN_OWNER_UNCHECKED\|deploy | cli | flaky | 2026-10-24 (e41110c7) | 2026-10-26 (df0fed7e) | script×3, claude×4, codex×2, opencode×2 | CUSTOM_DOMAIN_OWNER_UNCHECKED from `everyapp deploy --json` | - | - |
| ACCESS_NOT_CHECKED\|deploy | cli | flaky | 2026-10-24 (e41110c7) | 2026-10-24 (6b142b18) | script×1, claude×2, codex×2, opencode×2 | ACCESS_NOT_CHECKED from `everyapp deploy --json` | - | - |
| status\|GATEWAY_OUTDATED | cli | flaky | 2026-10-24 (e41110c7) | 2026-10-26 (6f73c77f) | script×2, claude×3, codex×2, opencode×2 | status from a fresh clone of the same commit calls the Gateway outdated: an app created inside the checkout rewrites pnpm-lock.yaml, which the Gateway's tree hash covers | give an app created inside the checkout its own workspace (as one outside it has), or hash only the Gateway's lockfile importers | - |
| ended_turn_without_done\|-\|- | prompt | flaky | 2026-10-24 (f2a1000d) | 2026-10-26 (6f73c77f) | claude×3, opencode×2 | Install done. Which domain should I use? (Setup will run at `apps.<your domain>`.) | - | - |
| asked_user\|-\|- | prompt | fixed | 2026-10-24 (f2a1000d) | 2026-10-26 (6f73c77f) | claude×3, opencode×3 | Which domain should I use? | - | - |
| ended_turn_without_done\|-\|- | loop | open | 2026-10-24 (f2a1000d) | 2026-10-26 (df0fed7e) | codex×1, claude×1 | Great — I’ll start in `/work/every-app`, install deps, then pause to ask your domain before running setup. | - | - |
| ended_turn_without_done\|setup --domain apps.<zone> --json > /tmp/setup.log 2>&1; echo EXIT $? >> /tmp/setup.log\|- | prompt | fixed | 2026-10-24 (a775e3d5) | 2026-10-24 (a775e3d5) | claude×1 | The Gateway is live. **Your turn:** open this link to create the owner account. It works once and expires in 24 hours, so treat it like a password: <url> | - | - |
| asked_user\|setup --domain apps.<zone> --json > /tmp/setup.log 2>&1; echo EXIT $? >> /tmp/setup.log\|- | prompt | fixed | 2026-10-24 (a775e3d5) | 2026-10-24 (a775e3d5) | claude×1 | waiting for you | - | - |
| tool_output_truncated\|-\|- | loop | fixed | 2026-10-24 (931ff039) | 2026-10-26 (6f73c77f) | opencode×3, claude×1 | read output cut at 50146 chars | - | - |
| blocked_for_question\|-\|- | prompt | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | codex×1, opencode×1 | BLOCKED: waiting for your domain. Which domain should I use for `apps.<your domain>`? | - | - |
| CF_NOT_FOUND\|setup | cli | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | CF_NOT_FOUND from `everyapp setup --domain apps.<zone> --json` (exit 1) | - | - |
| tool_output_truncated\|setup --domain apps.<zone> --json > /tmp/opencode/everyapp-setup.log 2>&1\|- | loop | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | read output cut at 5716 chars | - | - |
| source_read\|setup --domain apps.<zone> --json > /tmp/opencode/everyapp-setup.log 2>&1\|- | docs | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | /work/every-app/packages/cli/src/lib/cf/deploy.ts | - | - |
| tool_output_truncated\|--filter everyapp exec cf workers list --quiet\|- | loop | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | grep output cut at 38672 chars | - | - |
| ended_turn_without_done\|setup --domain apps.<zone> --json > /tmp/opencode/everyapp-setup.log 2>&1\|- | loop | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | Open [your owner setup link](<url>). Enter your name, email, and a password of at least 8 characters, then click **Create owner account**. The l | - | - |
| repeated_command\|setup --domain apps.<zone> --json\|- | cli | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | setup --domain apps.<zone> --json | - | - |
| background_killed\|setup\|- | skill | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | everyapp setup (pid 533) vanished with no exit line: the harness killed its background task | - | - |
| ACCESS_SETUP_SKIPPED\|setup | cli | open | 2026-10-26 (6f73c77f) | 2026-10-26 (df0fed7e) | script×2, claude×2 | ACCESS_SETUP_SKIPPED from `everyapp setup --domain apps.<zone> --json` | - | - |
| LOCAL_DNS_STALE\|setup | cli | fixed | 2026-10-26 (6f73c77f) | 2026-10-26 (6f73c77f) | claude×1 | LOCAL_DNS_STALE from `everyapp setup --domain apps.<zone> --json` | - | - |
| NO_RELEASE\|install | cli | fixed | 2026-10-26 (6f73c77f) | 2026-10-26 (6f73c77f) | claude×1 | NO_RELEASE from `everyapp install <url> --json` (exit 1) | - | - |
| ended_turn_without_done\|cd /work/every-app/apps/hello && pnpm everyapp deploy --json > /tmp/deploy.log 2>&1; echo EXIT $?; grep -E "done"\|"error"\|action_required /tmp/deploy.log\|- | prompt | fixed | 2026-10-26 (6f73c77f) | 2026-10-26 (6f73c77f) | claude×1 | `hello` is live at **<url> It has no public routes, so everyone has to sign in through the Gateway to open it. Before the next step, please confirm the owner account i | - | - |
| asked_user\|cd /work/every-app/apps/hello && pnpm everyapp deploy --json > /tmp/deploy.log 2>&1; echo EXIT $?; grep -E "done"\|"error"\|action_required /tmp/deploy.log\|- | prompt | fixed | 2026-10-26 (6f73c77f) | 2026-10-26 (6f73c77f) | claude×1 | please confirm | - | - |
| repeated_command\|install <url> --json\|1 | cli | fixed | 2026-10-26 (6f73c77f) | 2026-10-26 (6f73c77f) | claude×1 | install <url> --json | - | - |
| GIT_FAILED\|create | cli | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | GIT_FAILED from `everyapp create ../hello --json` | - | - |
| CUSTOM_DOMAIN_OWNER_UNCHECKED\|install | cli | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | CUSTOM_DOMAIN_OWNER_UNCHECKED from `everyapp install <url> --json` | - | - |
| APP_NEEDS_SETUP\|install | cli | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | APP_NEEDS_SETUP from `everyapp install <url> --json` | - | - |
| tool_output_truncated\|--version; pnpm --version; npm view everyapp version 2>&1 \| tail -2; cat /work/every-app/packages/cli/package.json \| grep "version"; ls /work/every-app/landing-page/content/agent/\|- | loop | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | tool output cut at 1927 chars | - | - |
| ended_turn_without_done\|--version; pnpm --version; npm view everyapp version 2>&1 \| tail -2; cat /work/every-app/packages/cli/package.json \| grep "version"; ls /work/every-app/landing-page/content/agent/\|- | prompt | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | Node 22.23.4 and pnpm 10.34.5 are both installed. One change from your steps: we're inside the EveryApp repo, and its instructions say to run `pnpm everyapp` from here instead of the npm package. The | - | - |
| asked_user\|--version; pnpm --version; npm view everyapp version 2>&1 \| tail -2; cat /work/every-app/packages/cli/package.json \| grep "version"; ls /work/every-app/landing-page/content/agent/\|- | prompt | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | Which domain should I use? | - | - |
| ended_turn_without_done\|cd /work/hello; pnpm everyapp deploy --json 2>&1 \| cut -c1-400; echo exit=${PIPESTATUS[0]}\|- | loop | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | The Gateway is live at <url> and your owner account (<email>) is claimed. **hello** is deployed at **<url> Its first git commit in `/ | - | - |
| false_done | prompt | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | the harness printed DONE while a check was red | the prompt should tie DONE to the deploy's done event and URL | - |
| verify\|S1 | template | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | S1 red with an app deployed by the harness | - | - |
| app_name_not_hello | prompt | open | 2026-10-26 (df0fed7e) | 2026-10-26 (df0fed7e) | claude×1 | the app was named ../hello, not hello | - | - |

The ledger is `findings.json`; `pnpm loop findings` renders the hand-off text per destination.
