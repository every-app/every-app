# Onboarding loop: findings

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
