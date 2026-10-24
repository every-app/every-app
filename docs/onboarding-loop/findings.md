# Onboarding loop: findings

| key | area | status | first seen (cli) | last seen (cli) | harness × runs | excerpt | proposed fix | link |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CUSTOM_DOMAIN_OWNER_UNCHECKED\|setup | cli | open | 2026-10-24 (e41110c7) | 2026-10-24 (6b142b18) | script×1, claude×2, codex×2, opencode×3 | CUSTOM_DOMAIN_OWNER_UNCHECKED from `everyapp setup --domain apps.<zone> --json` | - | - |
| CUSTOM_DOMAIN_OWNER_UNCHECKED\|deploy | cli | flaky | 2026-10-24 (e41110c7) | 2026-10-24 (6b142b18) | script×1, claude×2, codex×2, opencode×2 | CUSTOM_DOMAIN_OWNER_UNCHECKED from `everyapp deploy --json` | - | - |
| ACCESS_NOT_CHECKED\|deploy | cli | flaky | 2026-10-24 (e41110c7) | 2026-10-24 (6b142b18) | script×1, claude×2, codex×2, opencode×2 | ACCESS_NOT_CHECKED from `everyapp deploy --json` | - | - |
| status\|GATEWAY_OUTDATED | cli | flaky | 2026-10-24 (e41110c7) | 2026-10-24 (6b142b18) | script×1, claude×2, codex×2, opencode×2 | status from a fresh clone of the same commit calls the Gateway outdated: an app created inside the checkout rewrites pnpm-lock.yaml, which the Gateway's tree hash covers | give an app created inside the checkout its own workspace (as one outside it has), or hash only the Gateway's lockfile importers | - |
| ended_turn_without_done\|-\|- | prompt | flaky | 2026-10-24 (f2a1000d) | 2026-10-24 (6b142b18) | claude×2, opencode×2 | Install done. Which domain should I use? (Setup will run at `apps.<your domain>`.) | - | - |
| asked_user\|-\|- | prompt | open | 2026-10-24 (f2a1000d) | 2026-10-24 (6b142b18) | claude×2, opencode×3 | Which domain should I use? | - | - |
| ended_turn_without_done\|-\|- | loop | fixed | 2026-10-24 (f2a1000d) | 2026-10-24 (f2a1000d) | codex×1 | Great — I’ll start in `/work/every-app`, install deps, then pause to ask your domain before running setup. | - | - |
| ended_turn_without_done\|setup --domain apps.<zone> --json > /tmp/setup.log 2>&1; echo EXIT $? >> /tmp/setup.log\|- | prompt | open | 2026-10-24 (a775e3d5) | 2026-10-24 (a775e3d5) | claude×1 | The Gateway is live. **Your turn:** open this link to create the owner account. It works once and expires in 24 hours, so treat it like a password: <url> | - | - |
| asked_user\|setup --domain apps.<zone> --json > /tmp/setup.log 2>&1; echo EXIT $? >> /tmp/setup.log\|- | prompt | open | 2026-10-24 (a775e3d5) | 2026-10-24 (a775e3d5) | claude×1 | waiting for you | - | - |
| tool_output_truncated\|-\|- | loop | open | 2026-10-24 (931ff039) | 2026-10-24 (6b142b18) | opencode×3 | read output cut at 50146 chars | - | - |
| blocked_for_question\|-\|- | prompt | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | codex×1, opencode×1 | BLOCKED: waiting for your domain. Which domain should I use for `apps.<your domain>`? | - | - |
| CF_NOT_FOUND\|setup | cli | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | CF_NOT_FOUND from `everyapp setup --domain apps.<zone> --json` (exit 1) | - | - |
| tool_output_truncated\|setup --domain apps.<zone> --json > /tmp/opencode/everyapp-setup.log 2>&1\|- | loop | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | read output cut at 5716 chars | - | - |
| source_read\|setup --domain apps.<zone> --json > /tmp/opencode/everyapp-setup.log 2>&1\|- | docs | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | /work/every-app/packages/cli/src/lib/cf/deploy.ts | - | - |
| tool_output_truncated\|--filter everyapp exec cf workers list --quiet\|- | loop | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | grep output cut at 38672 chars | - | - |
| ended_turn_without_done\|setup --domain apps.<zone> --json > /tmp/opencode/everyapp-setup.log 2>&1\|- | loop | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | Open [your owner setup link](<url>). Enter your name, email, and a password of at least 8 characters, then click **Create owner account**. The l | - | - |
| repeated_command\|setup --domain apps.<zone> --json\|- | cli | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | setup --domain apps.<zone> --json | - | - |
| background_killed\|setup\|- | skill | flaky | 2026-10-24 (6b142b18) | 2026-10-24 (6b142b18) | opencode×1 | everyapp setup (pid 533) vanished with no exit line: the harness killed its background task | - | - |
