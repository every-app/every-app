# Proactive next steps

Date: 2026-10-25. Status: design; the slice in section 8 follows on this branch (lane C2 of the agent-forward thread). Reopens the "no usage-mined suggestions" position of [2026-10-code-mode-and-skills.md](2026-10-code-mode-and-skills.md) sections 5 (S4) and 11, for suggestions only, not for skills.

## 1. The ask

Ben, 2026-10-24: "How will people become aware of all of this? All the features available on Every App, specifically apps versus provider apps and these MCPs we added. Should we have a comprehensive llms.txt that walks people through how to make the most of it, and suggests things they might want to do based off their history or the apps they're currently using the most? Maybe it should almost be proactive."

The smallest answer: the Gateway says what to do next from what is installed and used, where a person already looks, once.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Where suggestions come from | State the Gateway holds: registry rows, Worker secret names, counters, the audit trail. No new table, no model, no per-member profile. |
| Who gets operator suggestions | Owners and admins. Members get one: connect an AI client. |
| How often | Once per state: a line is a function of state and goes when the state changes; nothing is stored to dismiss it. |
| Usage as a nudge | Never. Usage ranks (row 10); it does not prompt. The one usage-shaped rule (row 6) waits for Ben. |
| First surfaces | `everyapp status` (`Next:`, `data.next`) and one `/mcp` instructions line when an MCP app (tier `provider`) is off with its key set. |
| Boundaries | No new tool, no write, no new capability. The built-ins stay read-only (`toolbus.builtins-readonly-reserved`); the head stays under 4,096 characters. |

## 3. The four surfaces

1. **An AI client over `/mcp`.** The instructions head (`gatewayInstructionsHead`, `packages/toolbus/src/view.ts`) and `everyapp_list_apps` (`packages/toolbus/src/builtins.ts`), both from the view `gatewayView` builds in `apps/every-app-gateway/src/server/toolbus/gateway-mcp.ts`. Today: the header, the app list, one line per app that needs setup (`needsSetupReason`, the command only when `canFix`), and `everyapp_list_apps` entries with `available: false, reason`. Measured on the five launch apps: 295 characters; 1,320 with all five needing setup; 1,461 compact (`view.test.ts` asserts each stays under `CLAUDE_CODE_INSTRUCTIONS_READ`). Room for one line. The principal carries `orgRole` (`packages/toolbus/src/types.ts`). Instructions arrive once per session, at `initialize`.
2. **The gateway home and Admin.** `apps/every-app-gateway/src/routes/_app/index.tsx` (`OnboardingBanner` while there are no apps) and `routes/_app/admin/*.tsx`. The first-screen and shell siblings own them; section 7 proposes content only.
3. **The CLI.** `everyapp status` (`packages/cli/src/commands/status/index.ts`, `problems.ts`, `render.ts`): `problemsFor` yields `Problem { code, severity, headline, detail, run, runNote, fix, where }`, `fixData` puts them in `data.fixes`. The done screens already carry `data.next`: `nextAfterInstall(mode)` in `packages/cli/src/commands/setup/index.ts` (create, `access on`, an AI key, email; hosted mode drops Access), `mcp list`, `email show`, `deploy`; `packages/cli/src/lib/output/events.ts` renders it as a `Next:` block (`nextItems`, `formatNext`); `landing-page/content/agent/json.md` documents it. `status` has `fixes` and no `next`; its Access row already recommends `access on`.
4. **The coding agent reading the docs.** `landing-page/content/agent/setup.md` ("What to tell the person after a deploy", "Invite people", "Connect an AI client") and `packages/cli/skills/everyapp/SKILL.md`, which sends the agent to `status --json` and `data.fixes`. The `gateway.md` page this thread writes carries the playbook: section 5 in prose.

## 4. Signals and where they are readable

| Signal | Gateway (D1 from the Worker) | CLI (`cf d1 query` and the Cloudflare API; ADR-0003, `docs/security-model.md`) | Cost |
| --- | --- | --- | --- |
| Apps: status, tier, manifest, `secret_names` | `apps` (`src/db/apps.schema.ts`) | `listApps(db)`, `packages/cli/src/lib/gateway/registry.ts` | One statement; read today |
| MCP apps on or off | Tier `provider` rows (`PROVIDER_APP_IDS`, `packages/sdk/src/internal/providerApps.ts`) | `listProviderApps(db)`, `packages/cli/src/lib/gateway/providerApps.ts` | One statement; not read by status yet |
| Gateway settings set (AI keys, `DATAFORSEO_API_KEY`, `EMAIL_FROM`, Access) | `env` names (`SETTABLE_GATEWAY_SETTINGS`, `packages/sdk/src/internal/gatewaySettings.ts`); email by `isEmailConfigured` (`src/server/email/sendEmail.ts`) | `listGatewaySecretNames(cf)` (`packages/cli/src/lib/app/settings.ts`), names never values; `accessStateOf(secretNames, record)` (`packages/cli/src/lib/access/settings.ts`; it was `readAccessState(cf, db)`, which listed the names itself, until the slice shared one listing) | One `cf secret list`; status runs it only when an app declares settings |
| An app needs setup | `appSetupFor` (`src/server/app-setup.ts`) | `appSetupFrom`, one `cf secret list` per app Worker | Read today |
| Members and roles | `members` (`src/db/auth.schema.ts`) | `readOwner(db)` reads one row | One count statement |
| AI connections and tokens | `mcp_connections` (`revoked_at`; `src/db/mcp.schema.ts`), `user_access_tokens` (`revoked_at`, `expires_at`; `src/db/user-tokens.schema.ts`) | Not read | Two counts, one batch |
| Tool calls per app and member | `mcp_tool_calls` (`created_at`, `app_row_id`, `user_id`, `decision`; index `(organization_id, created_at)`; kept `MCP_AUDIT_RETENTION_DAYS`, 90): `McpToolCallRepository`; Admin → Activity (`src/serverFunctions/activity.ts`) | Not read | One group-by over the organization's rows in the window |
| Provider spend per app, member, target | `usage_daily`, `usage_monthly` (`src/db/usage.schema.ts`): `UsageRepository.summarize`; Admin → Usage (`src/serverFunctions/usage.ts`) | Not read | One statement; one row per app and month |
| Groups, grants, caps (`groups`, `group_app_access`, `user_app_access`, `org_app_settings`) | Read by Admin | Not read | Not a rule (section 6) |

## 5. The rules

Commands are `pnpm everyapp …`. "Who" is who may act, which is who sees it; `status` runs as the operator, so every row shows there.

| # | Signal | Suggestion | Command or URL | Who | Where |
| --- | --- | --- | --- | --- | --- |
| 1 | No AI key among the Gateway names (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `WORKERS_AI_API_TOKEN`) while an app's manifest lists `providers`, and no fix names the key | Apps that use AI need a key | `secret set OPENROUTER_API_KEY` (the id the apps name; the others in the note) | Owner, admin | status; docs |
| 2 | `DATAFORSEO_API_KEY` set, `dataforseo` row absent or deleted, and no deployed app lists `dataforseo` (then the key is that app's) | The key is set; offer DataForSEO to AI clients (each call spends its credit) | `mcp on dataforseo` | Owner, admin | status; `/mcp` head (#619, held); home card |
| 2b | `dataforseo` row on, key unset | DataForSEO is on, its key is not set | `secret set DATAFORSEO_API_KEY` | Owner, admin | status (its per-app report skips provider rows today); `/mcp` already says needs setup |
| 3 | Access off, self-hosted, Worker uploaded, owner claimed (`access on` refuses with nobody to let in) | Put Cloudflare Access in front | `access on` | Owner, admin | status (the Access row's advice, now in `data.next`); setup done |
| 4 | One member in the install organization, no pending invitation, an app live | Invite people | `<gateway>/admin/users` | Owner, admin | status; home card |
| 5 | No live `mcp_connections` and no live `user_access_tokens` in the organization, and an app serves tools (`app_tool_catalogs.tool_count` > 0) | Connect an AI client | `<gateway>/mcp`, `/docs/connect-ai` | Owner, admin in status; every member on the home card | status; home card |
| 6 | An app serving tools with no allowed `mcp_tool_calls` row in 30 days, while the organization has a connection | `<app>`'s tools have not been used by an AI client | `everyapp_search_tools` with the app id, from the client | Owner, admin | status only, after Ben's answer; never `/mcp` |
| 7 | An app needs setup | Already `APP_NEEDS_SETUP` in `fixes`; the `/mcp` head and `everyapp_list_apps` name it | `configure <app>` (the SDK's `setupCommand`; an MCP app's is `secret set <key>`, row 2b: it has no Worker for `configure` to read) | Owner, admin; members see "needs setup" | Unchanged; a `next` never repeats a fix |
| 8 | No apps, owner exists | Create your first app | `create my-app` | Owner, admin | status (its empty state says `deploy` today); setup done; the home banner |
| 9 | `EMAIL_FROM` and `EMAIL_FROM_NAME` not both set, and members > 1 or an app lists `email` | Invites and resets go out by link until email is set | `secret set EMAIL_FROM EMAIL_FROM_NAME` | Owner, admin | status; Admin → Users already (`getEmailStatus`) |
| 10 | Most-used apps: `usage_monthly.calls` this month, allowed `mcp_tool_calls` in 30 days, per app | None: a ranking signal for the app order and for where an agent starts | `everyapp_list_apps`; Admin → Usage | Members see the order; admins the page | The shell sibling's order; the docs playbook |

## 6. Noise rules

- Operator actions to owners and admins only: `status` is the operator's by ADR-0003; on `/mcp` the line requires `principal.orgRole` owner or admin; a home card reads the session's role. A member never learns operator state.
- Once per state: nothing is written to remember a suggestion; a satisfied rule disappears. Instructions are read once per session, never per tool result.
- Nothing counted per member beyond the rows that exist; never "you have not used X" to a person. Row 6 is per app, and held.
- At most four `Next:` lines in `status`, in the table's order; one line in the `/mcp` head; three items on a home card. The head stays under 4,096 characters (1,320 measured worst case plus a line under 160; `view.test.ts` extends its assertion).
- A `next` never repeats a `fix` (deduplicated on the command text) and never fires for a caller who cannot run it (`canFix`).
- No cap nudges: limits are a later feature and never a default (Ben, 2026-10-16; [2026-10-teams.md](2026-10-teams.md) section 4.2).

## 7. Options, by value over effort

1. **The docs playbook** (`gateway.md`, this thread): section 5 as prose. No code. Every agent that reads it suggests the same things.
2. **`everyapp status` `Next:` and `data.next`**: the rules as pure functions with tests. Half a day. The agent's one state query gains the field it lacked.
3. **One `/mcp` head line for owners and admins** (rule 2): "dataforseo (DataForSEO) is off and its key is set: an admin runs pnpm everyapp mcp on dataforseo." and an `everyapp_list_apps` entry `{ id, name, available: false, offered: true, reason }` beside the needs-setup ones. Hours. Inside the invariants: no tool changes, nothing writes, the cap holds. Whether an AI client's instructions should carry any nudge is Ben's.
4. **A "What next" card on the gateway home** (the first-screen sibling's). Proposed: for owners and admins rows 5, 4, 2, 9 in that order, one sentence and one link each; for members row 5 alone; hidden when nothing applies; `OnboardingBanner` keeps the no-apps case. A day.
5. **Usage-ranked app order** (the shell sibling's): `UsageRepository.summarize(...).byApp` for the month, or allowed tool calls per app in 30 days. Pinned-first is the one order today (TODO "Gateway shell (2026-10-24)"), so this is Ben's.
6. **A weekly digest email**: needs email configured (rule 9), a cron, a template, a way out. Days, for people who read `status`. Not now.

## 8. The slice to build now

Options 2 and 3; option 1 lands with the docs lane.

- `packages/cli/src/commands/status/next.ts`: `nextStepsFor(facts): NextStep[]`, pure; `NextStep { code, command?, url?, note }`, codes `AI_KEY`, `PROVIDER_OFFER`, `PROVIDER_KEY`, `ACCESS_OFF`, `INVITE`, `CONNECT_AI`, `CREATE_APP`, `EMAIL_UNSET`. The facts: mode, uploaded, owner, the `AppState` list, the Gateway names (null when unread), the Access state, `ProviderAppState[]`, the three counts, the problems (for the dedupe). Rows 1 to 5, 8 and 9; row 6 behind Ben.
- `reportStatus` adds `listProviderApps(db)`, one D1 batch of three counts (`members`; `mcp_connections` with `revoked_at` null; `user_access_tokens` with `revoked_at` null and `expires_at` ahead; all by the install organization), and reads the Gateway names always. A read that fails yields no `next` for its rules, as `Unread` does for fixes.
- Output: `data.next` as `[{ command | url, note }]` through the existing renderer, a `Next:` block after the problems; the empty state says `create`. `json.md` and `cli.md` regenerate (`pnpm -C packages/cli docs:update`); `setup.md` points at it.
- Tests: `next.test.ts`, table-driven (each rule on and off, the dedupe, the four-line cap, hosted mode); one end-to-end case in `status.test.ts` (fresh gateway: Access off, one member, no connection, no key).
- The `/mcp` line: `gatewayView` computes `offered` for owners and admins (`PROVIDER_APP_IDS` whose row is absent or deleted and whose `providerAppKeySetting` is set in `env`); `gatewaySurfaceView` takes `offered?: OfferedApp[]`, `gatewayInstructionsHead` prints one line, `everyapp_list_apps` appends the entries; `view.test.ts` and `builtins.test.ts` cover role, cap and shape; `mcp.md` documents both.

## 9. Boundaries touched

- B5 (AI client → `/mcp`): one more instructions line and one more entry kind in a read-only built-in, from state the gateway holds, to owners and admins only. `toolbus.builtins-readonly-reserved` unchanged; `CLAUDE_CODE_INSTRUCTIONS_READ` still bounds the head.
- The CLI: three count statements and one secret-name listing more, under the operator's credentials (ADR-0003). Names, never values.
- Not touched: mcp-auth, the perimeter, the app access check, the counters, the audit columns.

## 10. What lands

This document, then the section 8 slice (lane C2, 2026-10-25): the `status` half on the same branch (PR #588), the `/mcp` half as PR #619, held for Ben (section 11). The review of #588 (2026-10-25) is folded in below.

- **`everyapp status`.** A `Next:` block after the fixes, in the style of setup's next lines (the command or the page, then the note), and `data.next`: `[{ code, command?, url?, note, why }]`, four at most, rules 1 to 5, 8 and 9 as pure functions in `packages/cli/src/commands/status/next.ts` (`nextStepsFor`), with `next.test.ts` (each rule on and off, the dedupe, the cap, hosted mode) and one end-to-end case in `status.test.ts` (a fresh Gateway, then the claim, two apps, the DataForSEO key, Access on, a fix that names the key, a connection, the provider on, a dropped table). The reads: the Gateway Worker's secret names once (now shared by Access, the settings model and the steps, so one `cf secret list` fewer than before), the provider rows from the `listApps` the report already makes (no `listProviderApps` call), and one `cf d1 query` batch of five counts in the install organization (`packages/cli/src/lib/gateway/counts.ts`: members, invitations pending and unexpired, connections not revoked, tokens live, catalogs serving tools), read only once the owner has claimed and left unread as a whole when it fails. Against section 8 as written: each item carries `why` (the state behind it, an app id, a setting name, a count), rule 8 needs no owner (apps deploy before the claim, and the empty report says "No apps yet." with `create` in Next instead of `deploy`), the human sink's `data.next` renderer takes `url` beside `command`, rule 2 stays quiet while a deployed app lists the provider's capability and says the cost in its note (an operator who set `DATAFORSEO_API_KEY` for OpenSEO would otherwise read it on every run), rule 5's `url` is the connector page `https://everyapp.com/docs/connect-ai` with the Gateway's `/mcp` in the note (`/mcp` answers a GET with 405, `packages/toolbus/src/http.ts`), the Access row reads `off` alone since the Next block carries `access on`, rule 3 waits for the claim (`access on` refuses an unclaimed Gateway with `ACCESS_NOBODY_ALLOWED`, and `NO_OWNER` already says `setup`), rule 4 stays quiet while an invitation is pending (the fifth count), and the dedupe reads an app's unmet settings rather than a fix's command text (`APP_NEEDS_SETUP` runs `configure <app>` since #602). The commands stay `secret set NAME` where a step names a Gateway-wide key (rules 1, 2b, 9): `configure` takes an app, and an MCP app's id is refused by name (`findRegisteredApp` needs a Worker; the SDK's `setupCommand` gives a provider row `secret set <key>` for the same reason). Rule 6 waits for Ben (section 11), so nothing reads `mcp_tool_calls`.
- **The `/mcp` line (rule 2)**, PR #619, held for Ben. `OfferedApp { appId, name, command }` and `offered` on the view (`packages/toolbus/src/types.ts`); the head line `<id> (<name>) is off and its key is set: an admin runs pnpm everyapp mcp on <id>.` after the not-available lines, and `gatewaySurfaceView` dropping `offered` for any role but owner or admin (`isOwnerOrAdmin`, `view.ts`); the `everyapp_list_apps` entry `{ id, name, available: false, offered: true, reason }` (`builtins.ts`). The gateway computes it in `offeredProviderApps` (`apps/every-app-gateway/src/server/toolbus/gateway-mcp.ts`): the role first, then the env, then the catalogs already read for the view as a short-circuit (an app the caller sees has its row), and only then the install organization (`OrganizationRepository.findInstallOrganizationId`) and its live rows (`AppRepository.findSlugsAndManifests`, one statement): offered when no row holds the id and no deployed app lists the capability. The rows decide, never the caller's view (the review of #588: a grant an admin lacks, a connection's chosen apps, a token's one app or a failed catalog sync would otherwise read as off, and the command would change nothing), so the steady state reads nothing more and another organization's owner never sees it. Tests: `view.test.ts` (present for an owner and an admin, absent for a member, the launch-apps head with the line still under `CLAUDE_CODE_INSTRUCTIONS_READ`), `execute.test.ts` (the entry), `gateway-mcp.sqlite.test.ts` (owner, admin, member, another organization's owner, gone once the row is on and the catalog synced, an admin added after `mcp on`, a token bound to todo and a connection that chose todo alone, a deployed app listing the capability). The register is untouched: `toolbus.builtins-readonly-reserved` holds (still answered from the view, read-only) and `perimeter.needs-setup-names-no-setting` describes the not-available lines, which are unchanged.
- **Docs.** `landing-page/content/agent/json.md` (`data.next`, its codes and reads), `setup.md` (the verification checklist, after a deploy), `status.md` (the `Next:` row), the everyapp skill's State line, `mcp.md` (the agent page and the skill's) for the line and the entry (#619); `access.md`, `errors.md`, `json.md`, `secrets.md` and `setup.md` cite `accessStateOf` where `readAccessState` was; a drift test that `json.md` names every `NextCode`. `cli.md` is unchanged (`--help` is).
- `gateway.md` from the docs lane; the TODO section "Proactive next steps (2026-10-25)" for the rest of section 7 and the questions of section 11.

## 11. Open questions

- Ben: should an AI client's instructions carry any suggestion, even one about state (rule 2)? If not, the slice is `status` alone.
- Ben: do members get nudges? The design gives them one (connect an AI client), nothing operator-shaped.
- Ben: rule 6 (an app no AI client has called in 30 days): a `status` line, or noise?
- Ben: a weekly digest email, ever?
- Ben: a usage-ranked app order against pinned-first.
- Hosted Gateway, shared apps: `canFix` is false for another organization's app, so no operator rule fires there; rule 5 still does.
