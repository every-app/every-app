# Agent parity: everything the UI can do, the CLI and MCP can do

Status: built 2026-10-24 (launch week) as #614 (the MCP tools), #617 (the CLI), #610 (browser installs narrowed) and the docs PR that carries this document. The matrix at the end is a
test fixture: `packages/cli/src/docs/parity.test.ts` reads it, so a new UI
action without a CLI or MCP twin (or a written reason) fails CI.

Ben, 2026-10-24: "You should totally be able to manage the workspace in the
CLI. The CLI should include everything you can do in the UI, and more. The
UI should be simpler than the CLI, because we want agents to be able to do
basically everything. There should be as little as possible that an agent
can't do. An agent should be able to do as much as possible in the gateway
and the apps."

## The three surfaces and who they act as

| Surface | Who acts | Authority | Audit |
| --- | --- | --- | --- |
| Gateway UI (Admin → Users, Groups, Apps, Tokens, Usage, Activity; AI connections; the account menu) | a signed-in person | their role in the active organization (owner, admin, member); server functions in `apps/every-app-gateway/src/serverFunctions/*.ts` gated by `organizationAdminMiddleware` (owner or admin; nothing is owner-only at the middleware since 2026-10-25) | `logEvent` lines |
| CLI, `everyapp workspace …` | the operator: the Cloudflare login or API token that owns the Gateway's account | root (ADR-0003: write access to the Gateway's D1 is operator authority); the commands write D1 directly like `email set` and `provider on`, with the same guards the services hold (never the last owner; never an owner by an admin) written as SQL conditions | none in the Gateway (Cloudflare's audit log has the D1 writes); a workspace changes log is a follow-up |
| Gateway MCP, `everyapp_workspace_*` tools on `/mcp` | the person behind an OAuth connection, a personal access token or a Cloudflare Access assertion | their live role, re-read on every request (`mcp-auth/validate.ts`), and the connection's access (read only, or read & write): a write tool is hidden from and refused for a read-only connection like any app write tool; a tool is hidden below its role; a credential narrowed to apps (a personal token bound to one app, a connection consented for selected apps) sees no workspace tool at all; the service's own rules apply on top | one `mcp_tool_calls` row per call, shown in Admin → Activity like any tool call (app `everyapp`, `via` when wrapped) |

Why the CLI does not go through the Gateway: the Gateway's personal
tokens are HMAC-hashed with `BETTER_AUTH_SECRET`, a Worker secret the CLI
never holds, so the CLI cannot mint itself a credential; and the
self-host model (ADR-0003) is that the Cloudflare login is root and the
Gateway may be down. The cost is that the CLI re-implements each action as
SQL; the tests run that SQL against the Gateway's real migrations
(`packages/cli/src/test/fakeCloudflare.ts`).

Decisions taken as defaults (Ben can flip any; TODO.md "Agent parity (2026-10-24)"):

1. **The CLI group is `workspace`**, matching the UI's "Manage workspace"
   and Ben's words. `admin` was the alternative; it is also a role name.
   The UI review thread owns `workspace rename` and `workspace role`.
2. **MCP admin tools never return a credential.** No invite link, no
   password-reset link, no token plaintext. `everyapp_workspace_invite`
   creates the invitation and says whether it was mailed; where the Gateway
   has no email, the admin gets the link from Admin → Users or
   `everyapp workspace invite-link`. Personal access tokens are listed and
   revoked over MCP, never created (a revocable connection must not mint
   itself a year-long credential). Flipping this is a small change per tool.
   The decision is about credentials that open the Gateway: the one secret
   a tool returns is the webhook signing secret
   `everyapp_workspace_events_add` generates, once, for a URL the caller
   chose; it signs deliveries there and opens nothing here
   (docs/design/2026-10-events-out.md, section 9).
3. **Irreversible tools ask for `confirm: true`** (`remove`, `app_delete`,
   `mcp_remove`, `events_remove`) and are an owner's or admin's (Ben's
   ruling of 2026-10-25: owners and admins control the Gateway; before it
   the first three were owner-only); they are `write` risk (a `destructive`
   tier stays hidden until approvals exist, `packages/toolbus/src/policy.ts`).
   Removing an owner stays the service's owner-only rule.
4. **Workspace tools are listed in the full listing only.** In the compact
   listing an admin finds them with `everyapp_search_tools` and runs them
   through `everyapp_call_read` / `everyapp_call_write`, like app tools.
5. **A CLI command acts on the install organization** unless `--org
   <slug|id|name>` names another; the operator is root in every
   organization of the Gateway.
6. **`everyapp workspace invite` needs the operator to be a member** (an
   invitation records its inviter; the operator's Cloudflare login email,
   verified, names the user). An API-token operator with no account is told
   to claim the Gateway or get invited.

## Identifiers the tools and commands take

- a user: their email, or the user id
- an app: its manifest id (`crm`), or the row id (`apps.id`)
- a group: its name, or the id (`grp_…`)
- an invitation: its id, or the invited email
- a month: `YYYY-MM` (UTC), default the current one

## The MCP tool catalog (`everyapp_workspace_*`)

Definitions (name, schema, risk, role) live in
`packages/toolbus/src/workspace.ts` so the docs drift test and the policy
read them; the Gateway supplies the handlers
(`apps/every-app-gateway/src/server/toolbus/workspace-tools.ts`), which
build an `OrgContext` from the caller and call the same services the UI's
server functions call. A `PublicError` becomes the tool's error result
(`CODE: message`). Role: `admin` means owner or admin. Every tool is
`admin` (no tool is owner-only since 2026-10-25); the services' finer rules
(only an owner changes an admin or an owner, makes or demotes an owner,
never the last owner, never yourself) apply on top and come back as errors.

| Tool | Risk | Role | Input | Service |
| --- | --- | --- | --- | --- |
| `everyapp_workspace_show` | read | admin | – | organization (id, name, slug), your role, whether email is configured, counts of members, pending invitations, groups, apps |
| `everyapp_workspace_users` | read | admin | – | `AdminService.listMembers`: members with role, deactivated flag, created; pending invitations with role and expiry |
| `everyapp_workspace_invite` | write | admin | `email`, `role` (member, admin; default member) | the invitation row + link token + mail when configured (`InvitationService`, session-less variant); returns `invitationId`, `email`, `expiresAt`, `emailed`; never the link |
| `everyapp_workspace_uninvite` | write | admin | `invitation` (id or email) | cancel a pending invitation (`AdminService.cancelInvitation`, session-less) |
| `everyapp_workspace_role` | write | admin | `user`, `role` (member, admin, owner) | `MembershipService.changeRole` (owner promotion/demotion stays owner-only) |
| `everyapp_workspace_deactivate` | write | admin | `user` | `MembershipService.deactivate` |
| `everyapp_workspace_reactivate` | write | admin | `user` | `MembershipService.reactivate` |
| `everyapp_workspace_remove` | write | owner | `user`, `confirm: true` | `AdminService.deleteUser` (deactivates instead where Access would let them back in; says which) |
| `everyapp_workspace_reset_email` | write | admin | `user` | `MembershipService.sendPasswordResetEmail` (needs email configured; the link goes to the user, not the caller) |
| `everyapp_workspace_groups` | read | admin | – | `GroupService.listGroups` |
| `everyapp_workspace_group_create` | write | admin | `name`, `description?` | `GroupService.createGroup` |
| `everyapp_workspace_group_set` | write | admin | `group`, `name?`, `description?` | `GroupService.updateGroup` |
| `everyapp_workspace_group_delete` | write | admin | `group` | `GroupService.deleteGroup` |
| `everyapp_workspace_group_members` | read | admin | `group` | `GroupService.getGroupMembers` |
| `everyapp_workspace_group_members_set` | write | admin | `group`, then `users` (the full list) or `add` / `remove` | `GroupService.setGroupMembers` (add/remove read the list, change it, set it) |
| `everyapp_workspace_group_apps` | read | admin | `group` | `GroupService.getGroupApps` |
| `everyapp_workspace_group_apps_set` | write | admin | `group`, then `apps` (the full list) or `add` / `remove` | `GroupService.setGroupApps` |
| `everyapp_workspace_apps` | read | admin | – | `AppService.getAllWithAccessCounts`: every app with who can open it, whether everyone can, setup state, status |
| `everyapp_workspace_app_set` | write | admin | `app`, `name?`, `description?`, `everyone?` (boolean: available to everyone) | `AppService.update` |
| `everyapp_workspace_app_access` | read | admin | `app` | `AppAccessService.getAccessStateForApp` |
| `everyapp_workspace_app_access_set` | write | admin | `app`, then `users` (the full list) or `add` / `remove` | `AppAccessService.updateAccessForApp` |
| `everyapp_workspace_app_cap` | write | admin | `app`, `cap?` (whole calls per month, or null), `costUsd?` (dollars of provider-reported cost per month, or null), each left out to keep it; `unlimited?` alone: no cap of either kind even under the workspace defaults | `AppCapService.setMonthlyCap`; answers the `AppCapState` (the app's own caps, `capUnlimited`, the effective caps and their sources) |
| `everyapp_workspace_cap_default` | write | admin | `cap?` (whole calls per month for every app without a call cap or `unlimited` of its own, or null), `costUsd?` (dollars the same way, or null), each left out to keep it | `AppCapService.setDefaultMonthlyCap` |
| `everyapp_workspace_app_delete` | write | owner | `app`, `confirm: true` | `AppService.delete` (the catalog row; the Worker stays until `everyapp delete`) |
| `everyapp_workspace_usage` | read | admin | `month?` | `UsageRepository.summarize` |
| `everyapp_workspace_activity` | read | admin | `app?`, `user?`, `decision?`, `risk?`, `since?` (ISO time), `limit?` (1–`TOOL_CALL_PAGE_MAX`, default 50), `before?` (the previous page's cursor) | `McpToolCallRepository.listForOrganization` |
| `everyapp_workspace_audit` | read | admin | `actor?`, `type?` (a type, a prefix like `member.*`, or `*`), `since?` (ISO time), `limit?` (1–`AUDIT_PAGE_MAX`, default 50), `before?` (the previous page's cursor) | `listAudit` (`server/events/audit.ts`) over `EventRepository.listForAudit` |
| `everyapp_workspace_rename` | write | admin | `name` | `OrganizationService.rename` (the UI review thread adds it; until it lands the tool is omitted and the matrix says so) |
| `everyapp_my_tokens` | read | member | – | `UserPatService.listForUser`: the caller's own personal access tokens (never a value) |
| `everyapp_revoke_token` | write | member | `token` (id or name) | `UserPatService.revoke` (own tokens only) |
| `everyapp_my_connections` | read | member | – | `McpConnectionService.listForUser`: the caller's AI connections in every organization |
| `everyapp_revoke_connection` | write | member | `connection` (id) | `McpConnectionService.revokeForUser` (own connections only; revoking the one in use ends it on the next request) |
| `everyapp_mcp_list` | read | admin | – | each MCP app row through `McpAppService.get`: kind, on / off / needs setup, tool count, a remote one's URL and auth kind, the credential's name and whether it is set and bound; twin `mcp list` |
| `everyapp_mcp_show` | read | admin | `app` (id or row id) | `McpAppService.get`: the same, then every tool with its listed and server names, risk and source, on or off, and why it isn't listed; twin `mcp show` |
| `everyapp_mcp_add` | write | admin | `url`, `id?`, `name?`, `description?`, `auth` (`kind`, `secret?` the setting's name, `header?`, `prefix?`), `risk?` | `McpAppService.add` (`planRemoteMcpAppAdd`); answers the `secret set` command for a credentialed server, the tool count for an open one; twin `mcp add` |
| `everyapp_mcp_remove` | write | owner | `app`, `confirm: true` | `McpAppService.remove` (the tombstone; the credential stays set); twin `mcp remove` |
| `everyapp_mcp_on` | write | admin | `app` | `McpAppService.setStatus` active (a built-in's first row stays `mcp on`'s); twin `mcp on` |
| `everyapp_mcp_off` | write | admin | `app` | `McpAppService.setStatus` disabled (access, tokens and the snapshot kept); twin `mcp off` |
| `everyapp_mcp_refresh` | write | admin | `app` | `McpAppService.refreshTools` (listed within the call; the names added and removed); twin `mcp refresh` |
| `everyapp_mcp_tool` | write | admin | `app`, `tool` (listed or server name), `risk?` (read, write, destructive, annotations), `enabled?` | `McpAppService.update` with one tool's override; twin `mcp tool` |

The `everyapp_mcp_*` rows are defined in `packages/toolbus/src/mcpApps.ts`
(listed in `WORKSPACE_TOOLS`) and handled in
`apps/every-app-gateway/src/server/toolbus/mcp-app-tools.ts`, merged into
the workspace handlers' map. A remote server's credential is a setting's
name on every surface: its value is typed in a terminal (`secret set`) and
never passes through MCP.

Listing and calling, in `packages/toolbus`:

- `evaluateToolPolicy` takes the tool's `minRole` (member, admin, owner)
  and hides a tool below it (`reason: "role_required"`), before the
  existing read/write rule. A hidden tool is absent from `tools/list` and
  answers "Unknown tool" on call, so a member learns nothing.
- Workspace tools are `listedIn: ["full"]`. `everyapp_search_tools` finds
  them in either mode (they are the caller's tools like any other); the
  wrappers may run them (`everyapp_call_read` only the read ones). A
  wrapper still never runs a wrapper, and a workspace tool delegates
  nothing.
- A workspace tool is a built-in of kind `host`: `ToolBusDeps.workspace`
  supplies `run(name, args, principal)`; without it (the app surface,
  `everyapp dev`) the tool is not listed. Arguments pass the shape checks
  and the tool's own schema, whatever their value count, like every
  built-in. Every call is audited: `appId: "everyapp"`, the argument
  digest, `via` when wrapped.

## The CLI (`everyapp workspace …`)

Every command takes `--json`, `--gateway` and `--account-id`; all but `rename` and `role` (the UI review thread's, which act on the install organization) take `--org`; each acts
under the Cloudflare login (ADR-0003) and prints what changed; `--yes`
skips the confirmation of `remove`, `group delete` and `app delete`.

| Command | What it does | Writes |
| --- | --- | --- |
| `workspace show` | the organization, its owners, email configured, counts | – |
| `workspace users` | members and pending invitations | – |
| `workspace invite <email> [--role admin]` | create the invitation (72 hours, the auth config's `invitationExpiresIn`), print the link (`/accept-invitation?token=einv_…`); the Gateway mails nothing from here | `invitations`, `invitation_link_tokens` |
| `workspace invite-link <email\|id>` | a new link for a pending invitation | `invitation_link_tokens` |
| `workspace uninvite <email\|id>` | cancel a pending invitation | `invitations.status` |
| `workspace role <email> <owner\|admin\|member>` | UI review thread's | `members.role` |
| `workspace rename <name>` | UI review thread's | `organizations.name` |
| `workspace deactivate <email>` | ban, end sessions, revoke tokens and connections, in one batch; never the last live owner | `users.banned`, `sessions`, `user_access_tokens`, `mcp_connections` |
| `workspace reactivate <email>` | lift the ban (revoked tokens stay revoked) | `users.banned` |
| `workspace remove <email>` | remove the membership (and the account when it belongs to no other organization); like the UI, deactivates instead where Access would let them back in, decided from whether an Access auto-join setting is set (its value is a secret the CLI cannot read, so it errs on the safe side and says how to delete anyway) | `members`, grants, groups, tokens, connections, `users` |
| `workspace reset-link <email>` | a one-hour, single-use password-reset link to hand over (Better Auth's `verifications` row, `reset-password:<token>`); unlike the UI it works for an owner too (the operator is root: the way back in for a sole owner who lost their password; a decision for Ben) | `verifications` |
| `workspace groups` | the groups with counts | – |
| `workspace group create <name> [--description]` | | `groups` |
| `workspace group set <group> [--name] [--description]` | | `groups` |
| `workspace group delete <group>` | | `groups` (+ members, apps) |
| `workspace group members <group> [--add <email>…] [--remove <email>…] [--set <email>…]` | list, or change | `group_members` |
| `workspace group apps <group> [--add <app>…] [--remove <app>…] [--set <app>…]` | list, or change | `group_app_access` |
| `workspace apps` | every app with who can open it and its setup state (`status` has the operator's view; this is the admin's) | – |
| `workspace app set <app> [--name] [--description] [--everyone on\|off]` | | `apps` |
| `workspace app access <app> [--add <email>…] [--remove <email>…] [--set <email>…]` | list, or change | `user_app_access` |
| `workspace app cap <app> <n\|off>` | the organization's monthly cap on the app's provider calls; `off` removes the app's own cap (once the Caps thread's default exists: inherit it; `--unlimited` then means no cap at all) | `org_app_settings` |
| `workspace cap default <n\|off>` | the workspace default for every app without its own cap (after the Caps thread's migration 0009) | `org_settings` |
| `workspace usage [--month YYYY-MM]` | per app, member and provider; after 0009 also the effective cap, its source and whether the app is paused | – |
| `workspace activity [--app] [--user] [--decision] [--risk] [--since] [--limit] [--before]` | the tool-call audit trail, with the Activity page's filters and its cursor (`done.data.nextBefore`) | – |
| `workspace audit [--actor] [--type] [--since] [--limit] [--before]` | the audit log (the organization's events, 90 days), with the Audit view's filters and its cursor (`done.data.nextBefore`); the type's label and the subject, no summary line (the catalogue lives in the Gateway) | – |
| `workspace tokens [--user <email>]` | personal access tokens (every member's for the operator; never a value) | – |
| `workspace token revoke <id>` | | `user_access_tokens.revoked_at` |
| `workspace connections [--user <email>]` | AI connections (every member's for the operator) | – |
| `workspace connection revoke <id>` | | `mcp_connections.revoked_at` |

Not in the CLI, and why: `workspace token create` (the token hash is keyed
by `BETTER_AUTH_SECRET`, which the CLI never holds; an operator who needs a
token creates it in Admin → Tokens); sending mail (the Gateway's sender;
the CLI prints links instead). `everyapp delete <app>` already removes an
app's Worker and row, so `workspace app delete` is not added.

## Follow-up contract: caps (the Caps thread's #621, t3/caps-core)

Once #621's migration (`caps_defaults`, numbered after the Events-out core PR's) is on main (`org_settings` with `default_monthly_call_cap`; `org_app_settings.unlimited`; `usage_cap_notices`), this thread extends the cap verbs and tools. Landed as the parity caps follow-up PR (#659): the migration is `0014_caps_defaults`, the guard's code is `GATEWAY_PREDATES_DEFAULT_CAPS`, `workspace usage` refuses a Gateway without the rows too, and the `cap.raised` for an app's cap follows the effective cap before and after (its own, else the default), as the Gateway's `raised()` does. The contract:

- `workspace app cap <app> <n>` upserts `monthly_call_cap = n, unlimited = 0`; `workspace app cap <app> --unlimited` upserts `monthly_call_cap = NULL, unlimited = 1` in the same statement (the row invariant: exactly one of a cap or `unlimited = 1`; the Gateway reads "cap wins", so a row with both is capped); `workspace app cap <app> off` deletes the row (inherit the workspace default, if any).
- `workspace cap default <n|off>` writes or deletes the `org_settings` row (`updated_by` NULL from the CLI).
- A Gateway whose D1 predates 0014 has neither the table nor the column: guard with `PRAGMA table_info` like `hasSecretNamesColumn` (registry.ts) and refuse with a named code ("the Gateway predates default caps; run `pnpm everyapp update`"), with a test shaped like registry.test.ts's "a Gateway from before apps.secret_names (migration 0004)".
- `workspace usage` shows `getUsage`'s new fields: the default cap, and per app the effective cap, its source (`app`, `default`), `unlimited`, `paused`.
- MCP: `everyapp_workspace_app_cap` gains `unlimited?`; new `everyapp_workspace_cap_default` (`cap`) calls `AppCapService.setDefaultMonthlyCap`; the matrix row for `usage.setDefaultMonthlyCap` is added then.
- Refusal messages never name owners or admins (the directory is refused to agents and to apps without the `members` capability).

## Parity matrix

The fixture `packages/cli/src/docs/parity.test.ts` reads this section:

- Every `export const <name> = createServerFn` in
  `apps/every-app-gateway/src/serverFunctions/*.ts` must appear once in the
  first table as `<file>.<name>`; a new server function fails the test
  until its row exists.
- The CLI cell is a command path `commandPaths()` knows, or `—`; the MCP
  cell is a tool `listBuiltinTools()` knows, or `—`. A `—` needs the Note
  to start with `no CLI:`, `no MCP:` or `no twin:` and give the reason.
- Every `workspace …` command and every `everyapp_*` built-in must appear
  in some row, so the matrix stays complete both ways.
- A row whose Note starts with `pending:` names a function, command or tool
  that another PR is landing; the existence checks skip it, and the test
  fails once all three exist so the prefix gets removed.

### Server functions (the UI's actions)

| UI action | Server function | CLI | MCP | Note |
| --- | --- | --- | --- | --- |
| Setup and sign-up pages ask whether the Gateway has an owner | `admin.hasOwner` | `status` | `everyapp_workspace_show` | public read; `status` reports the owner |
| Admin → Users: the list | `admin.listMembers` | `workspace users` | `everyapp_workspace_users` | |
| Admin → Users → Delete | `admin.deleteUser` | `workspace remove` | `everyapp_workspace_remove` | owners and admins (an admin removes members only, `OWNER_REQUIRED` otherwise); MCP asks `confirm: true` |
| Admin → Users → Change role to admin / to member (and to owner, once the UI review thread widens it) | `admin.updateMemberRole` | `workspace role` | `everyapp_workspace_role` | the service's rules: never yourself, never the last owner; an admin changes members only, an owner changes admins and (after the UI review thread's PR) makes or demotes owners; until #604 lands the tool answers `owner` with `OWNER_ROLE_PENDING`; `workspace role` is #604's |
| Admin → Users → Deactivate | `admin.deactivateUser` | `workspace deactivate` | `everyapp_workspace_deactivate` | |
| Admin → Users → Reactivate | `admin.reactivateUser` | `workspace reactivate` | `everyapp_workspace_reactivate` | |
| Admin → Users → Copy password-reset link | `admin.createPasswordResetLink` | `workspace reset-link` | — | no MCP: a credential is never returned over MCP (decision 2). The service's rules: never yourself or an owner, an admin only for a member, never someone in another organization (`USER_IN_OTHER_ORGANIZATION`), never a deactivated account, and only with password sign-in on; the CLI keeps the other-organization and deactivated rules, has no caller to protect (it is root), and unlike the UI works for an owner: the way back in for a sole owner who lost their password (a decision for Ben) |
| Admin → Users → Send password-reset email | `admin.sendPasswordResetEmail` | — | `everyapp_workspace_reset_email` | no CLI: mail is the Gateway's sender; the CLI prints `reset-link`. The tool keeps every rule of the link variant (the service shares them) |
| Admin → Users → Invite | `admin.inviteMember` | `workspace invite` | `everyapp_workspace_invite` | the CLI prints the link; MCP says whether it was mailed |
| Admin → Users → Copy invite link | `admin.getInvitationLink` | `workspace invite-link` | — | no MCP: a credential is never returned over MCP (decision 2) |
| Admin → Users: whether the Gateway can send mail | `admin.getEmailStatus` | `workspace show` | `everyapp_workspace_show` | |
| Admin → Users → Cancel invitation | `admin.cancelInvitation` | `workspace uninvite` | `everyapp_workspace_uninvite` | |
| Admin → Activity: the list | `activity.listToolCalls` | `workspace activity` | `everyapp_workspace_activity` | the UI's filters are app, decision (allowed, blocked), risk (read, write, destructive) and a time range, paged by cursor at 50; the CLI takes `--app`, `--user`, `--decision`, `--risk`, `--since`, `--limit`, `--before`; the tool the same fields |
| Admin → Activity: the App filter's choices | `activity.listToolCallApps` | `workspace activity` | `everyapp_workspace_activity` | the CLI and the tool take `--app` / `app` directly |
| Admin → Activity → Audit: the list | `audit.listAuditEvents` | `workspace audit` | `everyapp_workspace_audit` | the UI's filters are who (actor), type (one, a group's `member.*`, or `*`) and the same time range, paged by cursor at 50; the CLI takes `--actor`, `--type`, `--since`, `--limit`, `--before`; the tool the same fields; the CLI shows no summary line |
| Admin → Activity → Audit: the Who filter's choices | `audit.listAuditActors` | `workspace audit` | `everyapp_workspace_audit` | the CLI and the tool take `--actor` / `actor` directly |
| Admin → Apps: the list | `apps.getApps` | `workspace apps` | `everyapp_workspace_apps` | |
| Admin → Apps → Edit (name, description, available to everyone) | `apps.updateApp` | `workspace app set` | `everyapp_workspace_app_set` | |
| Admin → Apps → Delete | `apps.deleteApp` | `delete` | `everyapp_workspace_app_delete` | `everyapp delete` removes the Worker too; MCP asks `confirm: true`; owners and admins |
| Admin → Apps → Manage access: who has it | `apps.getAppAccessState` | `workspace app access` | `everyapp_workspace_app_access` | |
| Admin → Apps → Manage access: save | `apps.updateAppAccess` | `workspace app access` | `everyapp_workspace_app_access_set` | `--add` / `--remove` / `--set` |
| Admin → Apps → Add app → Add an MCP server (#629) | `mcpApps.addRemoteMcpApp` | `mcp add` | `everyapp_mcp_add` | the same registry rules on all three (`planRemoteMcpAppAdd`); the credential is never passed, only its setting name: the CLI offers to set it in the terminal, the UI and the tool answer the `secret set` command |
| Admin → Apps → an MCP app → Edit (risk default, per-tool overrides, name) | `mcpApps.updateRemoteMcpApp` | `mcp tool` | `everyapp_mcp_tool` | the CLI and the tool change one tool at a time, by its listed or its server name; the risk default, name and description change in the UI alone after `mcp add` (`--risk` there) |
| Admin → Apps → an MCP app → Turn on / Turn off | `mcpApps.setMcpAppStatus` | `mcp on` / `mcp off` | `everyapp_mcp_on` / `everyapp_mcp_off` | both kinds of MCP app, status active ↔ disabled, access, tokens and the snapshot kept; only `mcp on` adds a built-in's first row |
| Admin → Apps → an MCP app → Remove | `mcpApps.removeMcpApp` | `mcp remove` | `everyapp_mcp_remove` | owners and admins; MCP asks `confirm: true`; the credential and its pin stay |
| Admin → Apps → an MCP app → Refresh tools | `mcpApps.refreshMcpAppTools` | `mcp refresh` | `everyapp_mcp_refresh` | the UI and the tool list within the request and say which names are new or gone; the CLI drops the snapshot and the Gateway lists again on first use |
| Admin → Apps → an MCP app → the edit dialog's facts (URL, auth, credential state, tools) | `mcpApps.getMcpApp` | `mcp show` | `everyapp_mcp_show` | never a credential's value; the tool leaves out the origin a credential is bound to |
| Admin → Events: the subscriptions (the Events tab, docs/design/2026-10-events-out.md section 10) | `events.listEventSubscriptions` | `events list` | `everyapp_workspace_events` | the CLI and the tool show a webhook's host and path, never its query |
| Admin → Events → Add subscription | `events.createEventSubscription` | `events add` | `everyapp_workspace_events_add` | a generated secret is returned once by every surface and never listed again (the one secret a workspace tool returns: it signs deliveries to the target the caller chose and opens nothing on the Gateway) |
| Admin → Events → Edit, Disable / Enable | `events.updateEventSubscription` | `events enable` / `events disable` | `everyapp_workspace_events_set` | the CLI pauses and resumes, the tool and the UI also change the name and the event list |
| Admin → Events → Remove | `events.deleteEventSubscription` | `events remove` | `everyapp_workspace_events_remove` | a built-in row (Cap alerts) is disabled instead, and every surface says so; MCP asks `confirm: true` |
| Admin → Events → Send test | `events.testEventSubscription` | `events test` | `everyapp_workspace_events_test` | a `ping` to that one subscription, paused or not |
| Admin → Events → Deliveries (and the Dead filter) | `events.listEventDeliveries` | `events deliveries` | `everyapp_workspace_event_deliveries` | the tool pages with `before` / `nextBefore` like the activity tool, and shows each event's type and summary, never its data (the UI's Show payload) |
| Admin → Events → Deliveries → Redeliver | `events.redeliverEvent` | `events redeliver` | `everyapp_workspace_event_redeliver` | resets a failed or dead delivery to pending with the schedule starting over |
| Admin → Events → Add subscription: the event types to pick from | `events.listEventTypes` | `events types` | — | no MCP: the catalogue is in the docs and in everyapp_workspace_events_add's description, and the add and set tools take type names and patterns in `events` |
| Admin → Sign-in: each sign-in provider on, off or needing setup, its settings by name with whether each is set, the redirect URL and the command; passwords and Access beside them (the Sign-in tab, docs/runbooks/sign-in-providers.md) | `signin.listSignInProviders` | `signin list` | `everyapp_signin_list` | Never a value on any surface; owners and admins (the operator from the CLI) |
| Home: the apps I can open | `apps.getMyApps` | `status` | `everyapp_list_apps` | |
| Admin → Providers: every provider the Gateway brokers (kind, built in or registered here, whether its key or client is set and bound, connections) | `providers.listProviders` | `provider list` | `everyapp_provider_list` | owners and admins; never a value (docs/design/2026-10-oauth-providers.md section 9) |
| Admin → Providers: the OAuth providers with each one's client source (a Worker secret from the terminal, or pasted here), redirect URI, scope sets and connection count | `providers.listOAuthProviders` | `provider list` | `everyapp_provider_list` | the CLI lane adds the OAuth columns (client source, redirect URI, connections) to both; the client's value is never listed |
| Admin → Providers → Add OAuth provider: the presets to pick from (the catalog's clients with a Gateway flow, marked built in, and the shipped presets) | `providers.listOAuthPresets` | `provider presets` | — | no MCP: the preset ids are in `everyapp_provider_add`'s description and on the providers page |
| Admin → Providers → Add OAuth provider: from a preset or a custom spec, with the client pasted in | `providers.addOAuthProvider` | `provider add --oauth <preset \| file>` | `everyapp_provider_add` | the CLI lane adds `--oauth`; the CLI uploads the client as Worker secrets (`secret set`), the tool takes a preset id or a spec and never a secret |
| Admin → Providers → Set client or Replace client: paste a provider's client id and secret (stored sealed, never shown again) | `providers.setOAuthClient` | `secret set` | — | no MCP: a secret never travels in a tool argument; the terminal sets `<ID>_CLIENT_ID` and `<ID>_CLIENT_SECRET` as Worker secrets, which win over a client pasted here |
| Admin → Providers → Forget pasted client | `providers.removeOAuthClient` | `secret unset` | — | no MCP: the terminal's `secret unset` of `<ID>_CLIENT_ID` and `<ID>_CLIENT_SECRET` is the twin of the pasted client's removal; a Worker secret stays until it is unset there |
| Admin → Providers → Remove provider (a registered one; refused while an app lists it; its client and connections go with it) | `providers.removeProvider` | `provider remove` | `everyapp_provider_remove` | owners and admins |
| Admin → Providers → Scope sets → Add: a scope set on a built-in OAuth client (Google, Microsoft, Slack), checked as a built-in set is | `providers.addScopeSet` | `provider scope-set add` | `everyapp_provider_scope_set_add` | owners and admins on a self-hosted Gateway; the CLI takes a JSON file or URL and `--replace`, the UI and the tool one route at a time and never a replace (docs/agent/providers, "Scope sets an operator adds") |
| Admin → Providers → Scope sets → Remove (an added set; refused while a deployed app lists it) | `providers.removeScopeSet` | `provider scope-set remove` | `everyapp_provider_scope_set_remove` | owners and admins on a self-hosted Gateway; `--force` is the terminal's |
| Account menu → Connected accounts: my OAuth accounts | `connections.listMyConnections` | `provider connections` | `everyapp_provider_connections` | any member, their own |
| Account menu → Connected accounts: the providers I may connect (those with a live client) | `connections.listConnectableProviders` | `provider list` | `everyapp_provider_list` | any member, by id and name only |
| Admin → Providers → Connections: every connection in the organization | `connections.listAllConnections` | `provider connections --all` | `everyapp_provider_connections` | owners and admins; never a token |
| Connected accounts → Disconnect (my own), Admin → Providers → Disconnect (anyone's or the organization's) | `connections.disconnectConnection` | `provider disconnect` | `everyapp_provider_disconnect` | revokes at the provider when its flow has a revoke endpoint |
| Account menu → AI connections: the list | `mcpConnections.listMyMcpConnections` | `workspace connections` | `everyapp_my_connections` | any signed-in user, across every organization they belong to; the operator sees every member's (`--user` narrows) |
| AI connections → Revoke | `mcpConnections.revokeMyMcpConnection` | `workspace connection revoke` | `everyapp_revoke_connection` | |
| Admin → Groups: the list | `groups.listGroups` | `workspace groups` | `everyapp_workspace_groups` | |
| Admin → Groups → New group | `groups.createGroup` | `workspace group create` | `everyapp_workspace_group_create` | |
| Admin → Groups → Edit | `groups.updateGroup` | `workspace group set` | `everyapp_workspace_group_set` | |
| Admin → Groups → Delete | `groups.deleteGroup` | `workspace group delete` | `everyapp_workspace_group_delete` | |
| Admin → Groups → Members: who is in it | `groups.getGroupMembers` | `workspace group members` | `everyapp_workspace_group_members` | |
| Admin → Groups → Members: save | `groups.setGroupMembers` | `workspace group members` | `everyapp_workspace_group_members_set` | |
| Admin → Groups → Apps: which it opens | `groups.getGroupApps` | `workspace group apps` | `everyapp_workspace_group_apps` | |
| Admin → Groups → Apps: save | `groups.setGroupApps` | `workspace group apps` | `everyapp_workspace_group_apps_set` | |
| After sign-in: the onboarding checklist's state, fetched and shown nowhere since the four-app home (#583) | `onboarding.getOnboardingStatus` | `status` | — | no MCP: dead code (`onboardingCollection.ts` warms it after sign-in; no component reads it); TODO: delete the function and the collection, then this row |
| OAuth consent: what the AI app asks for | `oauthConsent.getConsentContext` | — | — | no twin: the consent page is the human's decision by design; an agent connects with a personal access token or OAuth instead |
| The active organization and my role | `organizations.getActiveOrganization` | `workspace show` | `everyapp_whoami` | |
| Accept an invitation | `organizations.acceptInvitation` | — | — | no twin: joining is the invited person's own act in their browser |
| Account menu → Rename workspace (#605) | `organizations.renameOrganization` | `workspace rename` | `everyapp_workspace_rename` | owner or admin; 1 to 64 characters (`packages/sdk/src/internal/organizationName.ts`); the slug stays |
| Admin → Tokens: the list | `userTokens.listUserTokens` | `workspace tokens` | `everyapp_my_tokens` | any member's own tokens: the page sits under the admin-gated `/admin`, the functions do not (TODO "Tokens for members"); the operator sees every member's |
| Admin → Tokens → Create (an access token: name, one app or all, expiry 1 day to 1 year; or, where the platform deploys third-party apps, a deploy key with the `deploy` scope alone) | `userTokens.createUserToken` | — | — | no twin: both kinds are hashed with a Gateway secret the CLI never holds; over MCP a connection must not mint itself a credential (decision 2) |
| Admin → Tokens → Revoke | `userTokens.revokeUserToken` | `workspace token revoke` | `everyapp_revoke_token` | own tokens only through MCP; any token for the operator |
| Admin → Usage: the month | `usage.getUsage` | `workspace usage` | `everyapp_workspace_usage` | both twins show the summary's cap fields (#621): the workspace default (`defaultMonthlyCallCap`) and, per app, the effective cap (`effectiveMonthlyCallCap`), its source (`capSource`: `app`, `default`), `capUnlimited` and `paused`, and since the dollar caps `defaultMonthlyCostCapMicros`, per app `monthlyCostCapMicros`, `effectiveMonthlyCostCapMicros`, `costCapSource` and `pausedBy`; the CLI refuses a Gateway from before migration 0014 with `GATEWAY_PREDATES_DEFAULT_CAPS` |
| Admin → Usage → Cap an app | `usage.setAppMonthlyCap` | `workspace app cap` | `everyapp_workspace_app_cap` | `off` removes the app's own cap (the workspace default then binds it); `--unlimited` and the tool's `unlimited` mean no cap even with a workspace default; a cap or no cap, never both, written in one statement; both answer the app's own cap and the effective one with its source; `cap.raised` follows the effective cap before and after, so a cap set under the default is no raise and `--unlimited` under a default is a removal. The dollar cap beside it (2026-10-25): the dialog's "or dollars per month", `--usd <dollars\|off>`, the tool's `costUsd`; a kind left out keeps the app's own, so `--usd` alone keeps the call cap; `cap.raised` carries `costCap`/`previousCostCap` in dollars when it changed; the CLI refuses `--usd` on a Gateway from before migration 0018 with `GATEWAY_PREDATES_COST_CAPS` |
| Admin → Usage → AI default: what the default model provider resolves to | `ai.getAiDefault` | `ai show` | `everyapp_ai_show` | the resolution (provider, model, source, via, candidates); `ai list` is the candidates alone; the tool shows `configured` and `settings` to owners and admins only |
| Admin → Usage → AI default: choose or clear it | `ai.setAiDefault` | `ai default` | `everyapp_ai_default` | `provider` (+ `model?`) or null / `clear: true` / `off`; refused for an API provider, Cohere or AI Gateway; the model is stored as that provider's chat model (`ai_models`, as `ai model --chat` stores it); a change emits `ai.default_changed`; the CLI refuses a Gateway from before migration 0019 with `GATEWAY_PREDATES_AI_DEFAULT` |
| Admin → Usage → Default monthly cap | `usage.setDefaultMonthlyCap` | `workspace cap default` | `everyapp_workspace_cap_default` | `off` / `cap: null` removes the default; first set, raised or removed it emits `cap.raised` with `source: "default"` and no app (a lowered one is no event), and the organization's first cap, default or an app's, makes the Cap alerts subscription; the CLI writes `o
rg_settings` in the write's own batch with the subscription and the event, and refuses a Gateway from before migration 0014 with `GATEWAY_PREDATES_DEFAULT_CAPS`. The dollar default beside it (2026-10-25): the dialog's "or dollars per month", `--usd <dollars\|off>`, the tool's `costUsd`, a kind left out kept; clearing one keeps the other columns of `org_settings` (the other default, `ai_default`), and the row goes only when it holds nothing; `--usd` is refused on a Gateway from before migration 0018 with `GATEWAY_PREDATES_COST_CAPS` |

### Other UI actions (not server functions)

| UI action | How the UI does it | CLI | MCP | Note |
| --- | --- | --- | --- | --- |
| Switch organization | Better Auth `organization.setActive` (session) | `workspace show` | — | no MCP: a connection is made in one organization; connect again from the other. The CLI has no session: `--org` on every workspace command picks the organization |
| Pin an app; grid or list layout | `localStorage` in the browser (`useAppLibrary.ts`) | — | — | no twin: per-browser preferences, not Gateway state |
| Home: open an app (a card, a list row, a pinned link) | a link to the app's hostname (`AppListItem.tsx`; prefetched on hover); an app that needs setup opens the dialog instead | `status` | `everyapp_list_apps` | opening is the browser's act; both twins carry the URL |
| Home with no apps, and Admin → Apps → Add app: the four app cards and Build your own | dialogs that show `pnpm everyapp install <repo>` and copy the build prompt (`AppGallery`, `AddAppDialog`, `featuredApps.ts`, `buildPrompt.ts`); nothing installs from the browser here | `install` | — | no MCP: a pointer to the CLI, like the Needs-setup dialog; `create` is what the prompt has the agent run |
| Organizations page and the sidebar switcher: the organizations I belong to | Better Auth `organization.list` and `getActiveMemberRole` (auth client) | `workspace show` | — | no MCP: a connection is made in one organization; `everyapp_whoami` names it. The CLI shows one per `--org`; a `workspace list` of the operator's organizations is a follow-up |
| Theme | `localStorage` | — | — | no twin: per browser |
| Sign in (password, or Continue with Cloudflare Access, Google, Microsoft, GitHub, Apple, Cloudflare or SSO: one button per provider that is on), sign up (with an invitation token, or while the Gateway has no owner), sign out (through Access's logout behind the outer ring), forgot and reset password, verify email and resend, Connect <provider> to my account (the account menu, one item per provider not yet linked), Switch account on the consent page | Better Auth routes and the auth client (`/api/auth/*`, `signIn.social`, `linkSocial`, `listAccounts`, `sendVerificationEmail`), `/cdn-cgi/access/logout`, `GET /api/auth/sign-in-methods` | `access show` | — | no twin: the person's own credentials and identity links; `access show` and `signin list` report the operator's side |
| Admin → Sign-in → Set up, Needs setup or Details: one provider's setup dialog (the OAuth app to make, the redirect URL, the settings, the command) | the Sign-in tab's listing (`signin.listSignInProviders`), one entry of it in a dialog | `signin show` | `everyapp_signin_show` | Never a value |
| Sign-in provider settings (`<ID>_SIGNIN_<FIELD>`): add or remove a provider | not in the UI (Worker secrets; the setup dialog shows the command) | `signin add` / `signin remove` | — | no MCP: Worker secrets the Gateway can't write to itself, and a twin would let a stolen agent token add a way in (threat model B10, `signin.tools.read-state-only`) |
| Connect <provider> (Settings → Connected accounts, Admin → Providers → Connect for the organization, an app's own button through the SDK's `connectUrl()`): the browser flow `/connect/<id>` → the provider's consent → `/connect/<id>/callback` | a link to `/connect/<id>?account=user\|organization&return=…`; the Gateway stores the tokens sealed | — | — | no twin: a browser flow with the person's consent; `provider list` and the status route report `connectPath` so an agent can hand the link to the person |
| Setup page: claim the Gateway with the one-time link (`/setup#token=est_…`: name, email, password) | `POST /api/setup/claim`, then `signIn.email` | `setup` | — | no MCP: the owner's own credentials in a browser; `everyapp setup` mints and prints the link and waits for the claim |
| Cloudflare Access on/off | Worker secrets `CLOUDFLARE_ACCESS_*` | `access on` / `access off` / `access show` | — | no MCP: a Gateway setting (Worker secret), never writable from inside the Gateway. Interactive `setup` offers it after the claim (the public-surface thread; never under `--json`, where `next` names `access on`) |
| Secrets and Gateway settings | not in the UI (Worker secrets only, `docs/security-model.md`) | `secret set` / `secret unset` / `secret list` | — | no MCP: Worker secrets are the operator's; the Needs-setup dialog shows the command |
| Email senders and inbound | not in the UI | `email set` / `email unset` / `email show` | — | no MCP: same |
| MCP apps (tier `provider`: the built-in DataForSEO, and any remote MCP server by URL since docs/design/2026-10-mcp-by-url.md) on/off | Admin → Apps → Turn on / Turn off on an MCP row (`mcpApps.setMcpAppStatus`): status active ↔ disabled, access and the snapshot kept; Remove is the tombstone | `mcp on` / `mcp off` / `mcp remove` / `mcp list` | `everyapp_mcp_on` / `everyapp_mcp_off` / `everyapp_mcp_remove` / `everyapp_mcp_list` | `off` changed meaning from the tombstone (#599) to serve/stop when remote servers arrived (#631): on serves and off stops serving for both kinds, access, tokens and the snapshot kept, so on is instant; `remove` is the tombstone. `everyapp_mcp_list` lists the rows (`mcp list` also shows a built-in not added yet); `everyapp_list_apps` shows what a member can use
| Install an app from a public release (Admin → Apps → Install, `/install?source=<url>`) | `GET /api/admin/apps/install` (is it on), `GET /api/admin/apps/install/context` (which workspaces), `POST /api/admin/apps/install`, `GET /api/admin/deploys/{id}` (the job); gate: the platform deploys third-party apps, or self-hosted with `BROWSER_APP_INSTALLS` not off and `CF_DEPLOY_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID` set; caller: owner or admin of the chosen workspace and, on self-host since #610, of the install organization only | `install` | — | no MCP: a deploy authority (see "Browser installs" below) |
| OAuth consent: allow or deny, read or read & write, which apps | `POST /oauth/consent/decision` | — | — | no twin: the human's decision by design |
| The Needs-setup dialog | shows the command that opens the app (`pnpm everyapp configure <app>` since #602; `secret set` for an MCP app's key) | `configure` / `secret set` | — | no MCP: the dialog points at the CLI (`configure` asks for each required setting, then the optional ones); `everyapp_list_apps` names the app and the command an admin runs |
| Add to home screen (PWA) | browser | — | — | no twin: a browser feature |
| The "Use it from your agent" dialog of an MCP app (card, Admin chip, `/?mcp=<id>`) | client-only: shows `<gateway>/mcp`, the tool prefix and an example (#599) | `mcp list` | `everyapp_list_apps` | both twins carry the same facts |
| Forgot-password page: whether the Gateway can mail (UI review thread) | `GET /api/auth/sign-in-methods` gains `emailConfigured` | `status` | `everyapp_workspace_show` | a public read field; `status` and the tool say the same |
| Accept-invitation page: look an invite token up while signed out (UI review thread) | `POST /api/invitations/lookup` (token → organization name, masked address) | — | — | no twin: a sign-in page lookup, nothing an agent needs |
| A provider's default chat and embeddings models (`org_settings.ai_models`, seeded by the catalog; Platform shortcuts lane 5, 2026-10-26) | not a UI action yet: the AI default dialog's model field sets the chosen provider's chat model, nothing sets embeddings (TODO "Platform shortcuts (2026-10-26)/lane 5 catalog") | `ai model` | `everyapp_ai_model` | owners and admins; a model name, or `seed` (CLI) / `null` (tool) for the catalog's seed, a field left out kept; refused for a provider the default can't be or embeddings on a provider without them; a change emits `ai.model_changed`; the CLI refuses a Gateway from before migration 0019 with `GATEWAY_PREDATES_AI_DEFAULT` |
| Cloudflare AI Gateway in front of the model providers | not a UI action: `ai gateway on` finds or makes the Cloudflare resource under the login and sets `AI_GATEWAY_ID` | `ai gateway on` / `ai gateway off` | — | no MCP: it creates a Cloudflare resource and writes a Gateway setting, both the operator's; `everyapp_ai_show` reports `aiGateway.on` |
| The API provider registry: list the providers this Gateway brokers (no UI page; docs/design/2026-10-provider-registry.md section 8) | not a UI action: `provider list` reads the catalog and the `providers` rows | `provider list` / `provider show` | `everyapp_provider_list` | every member; whether a setting is set, and a row's key binding, show to owners and admins only; the apps listing a provider are the caller's organization's; `provider show <id>` prints one entry's whole spec, which the list tool carries per entry |
| The API provider registry: register a provider from its spec | not a UI action: `provider add` writes a row under the Cloudflare login | `provider add` | `everyapp_provider_add` | owners and admins on a self-hosted Gateway only (hidden on hosted); the tool takes the spec object, never a URL, and never replaces a row (`--replace` is the terminal's) |
| The API provider registry: remove a registered provider | not a UI action: `provider remove` deletes the row | `provider remove` | `everyapp_provider_remove` | owners and admins on a self-hosted Gateway only; the tool refuses a row whose key is bound and a row an app lists (`--force` is the terminal's) |
| OAuth providers: register one from a preset, a built-in client or a spec with `auth.kind: "oauth2-user"` (docs/design/2026-10-oauth-providers.md section 9) | Admin → Providers → Add OAuth provider (the UI lane's server functions) | `provider add --oauth` | `everyapp_provider_add` | the tool takes `{ preset }` or the spec object, names only; the CLI sets the client in the same run from piped `NAME=value` lines or `--from-env` (Worker secrets, which bind the row); the UI pastes it into D1 sealed; no tool ever carries a client id or secret |
| OAuth providers: the presets the picker offers | the Add OAuth provider dialog's first step | `provider presets` | `everyapp_provider_list` | the list tool's `presets` array; no Gateway read |
| OAuth providers: a built-in client's scope sets with where each is from (its catalog entry, or added here, by whom) | the Scope sets dialog's list | `provider show` | `everyapp_provider_list` | each OAuth entry's `scopeSets[]` carries `source` (`catalog` or `row`), `scopes` and `hosts` |
| OAuth providers: the redirect URI to register at the provider's console, the client's source and the connections count | the dialog and the Providers table | `provider show` / `provider list` | `everyapp_provider_list` | `redirectUri`, `client`, `connections`, `connectPath` on each OAuth entry |
| OAuth providers: list connected accounts (own under Settings → Connected accounts; everyone's under Admin → Providers) | the UI lane's `connections.listMyConnections` / `listAllConnections` | `provider connections` | `everyapp_provider_connections` | a member their own, an owner or admin the organization's (`--all` / `all: true`); never a token; the CLI reads D1 as the operator |
| OAuth providers: disconnect an account | Disconnect (the UI lane's `connections.disconnectConnection`) | `provider disconnect` | `everyapp_provider_disconnect` | a member their own, an owner or admin anyone's or the organization's; the service revokes at the provider where the preset knows how; the CLI holds no token, so it deletes the row and says where to revoke |
| OAuth providers: connect an account (the authorize flow) | Connect buttons → `/connect/<id>` and its callback | — | — | no twin: a browser flow with the person's consent at the provider; `everyapp_provider_list` and `provider show` carry `connectPath` |

## Browser installs and the deploy token (Ben's Q11c)

**Where the token is entered.** The token is `CF_DEPLOY_TOKEN`, a Cloudflare API token kept as a secret on the Gateway Worker; the browser never sees it. Interactive `pnpm everyapp setup` on a self-hosted install asks "Configure browser app installs?" (default No; not asked with `--yes`, under `--json`, or when the Worker already has one) and then a hidden "Cloudflare API token" prompt that lists the permissions (`packages/cli/src/commands/setup/runSetup.ts:393-408`, `:975-990`). The Gateway UI has no prompt for it. The Tokens dialog's "Deploy key" is something else: a personal access token for the hosted deploy API, offered only when `thirdPartyDeploys` holds (`CreateUserTokenModal.tsx:34-40`, `UserPatService.ts:194`, `server/deploy/auth.ts`); TODO.md asks the UI to stop offering it on self-host.

**Settable from the CLI.** Yes, like an app secret: `pnpm everyapp secret set CF_DEPLOY_TOKEN` (hidden prompt, stdin or `--from-env`), because it is in `SETTABLE_GATEWAY_SETTINGS` and is a credential (`packages/sdk/src/internal/gatewaySettings.ts:89`). `BROWSER_APP_INSTALLS` is settable and plain, exactly `on` or `off` (`:91`, `:134`; `packages/cli/src/lib/secretValue.ts:251-254`); `secret unset CF_DEPLOY_TOKEN` turns installs off. `APP_BASE_DOMAIN` and `CLOUDFLARE_ACCOUNT_ID` are install-owned (`:170`, `:175`): setup writes them once and `secret set` refuses them, which is fine since every setup-made Gateway has both. `landing-page/content/agent/secrets.md:205-206` and `docs/runbooks/browser-app-install.md` say so.

**Implemented.** Yes, since #371 (2026-10-21): the routes `GET`/`POST /api/admin/apps/install`, `GET …/install/context`, `GET /api/admin/deploys/{id}` (`src/routes/api/admin/apps/`, `src/server/deploy/install.ts`), the page `/install?source=<url>` and Admin → Apps → Install app (`routes/install.tsx`, `InstallAppForm.tsx`, `client/app-install.ts`), the gate `selfHostedInstallEnabled` (`browser-install.ts:21-31`: self_hosted, `BROWSER_APP_INSTALLS` not `off`, the token, a 32-hex account id, `APP_BASE_DOMAIN`), the release intake, the policy subset and limits (`BROWSER_INSTALL_LIMITS`: 5,000 cpuMs, 200 subrequests, 2 Durable Object classes; D1, own DOs, assets), and the pipeline shared with the hosted deploy API (`run.ts` `startDeploy`, `pipeline.ts`). Not done: the self-hosted upload has never run, in process (the fake Cloudflare serves dispatch namespaces, not account Workers) or live; the empty-home dialogs point at the CLI and offer no "Install in browser" while the authority question is open.

**Who can install.** Before PR #610: any signed-in, non-banned owner or admin of any active organization, role read live (`install.ts` `authenticateAdmin`); on self-host that is everyone the owner made an admin, since users cannot create organizations (`auth/config.ts:459`) and the setup claim makes the one organization. After #610: on self-host the install organization's owners and admins only (the oldest organization with an owner, as the CLI's `installOrganization` names it, `packages/cli/src/lib/gateway/registry.ts:199-207`); any other organization is refused before the download, the context offers no other workspace, and nobody installs before the Gateway has an owner. Members never could. So "any owner or admin should be able to make apps" holds for the organization the Gateway belongs to.

**How it deploys.** The Gateway deploys on the person's behalf with its own REST deployer: `CfRestDeployer.fromSelfHostedEnv(env)` from `CF_DEPLOY_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (`cfRestDeployer.ts:58-76`), run by `startDeploy` inside the request and `waitUntil` after (`run.ts:223-340`) under the app lease `app:<worker>` in `_everyapp_deploy_lease`, the table and ids the CLI holds, so browser and terminal installs serialize (`browser-install.ts:57-98`). It registers the row (`service_binding`, hostname `<appId>.<APP_BASE_DOMAIN>` for the install organization), refuses Workers it does not own (`WORKER_OWNED`, `WORKER_CHANGED`, `APP_ALREADY_INSTALLED`), creates the D1 and migrates it, uploads assets and the private account Worker `every-<orgKey>-<appId>` with workers.dev off, records the version in the ledger, then `publishBoundApp` takes the `gateway` lease, patches the Gateway's bindings with `inherit` plus `APP__<worker>`, attaches the Custom Domain on the Gateway Worker (refusing a hostname DNS or another Worker owns), reads the bindings back and writes the CLI's install record (`_everyapp_install`; `cfRestDeployer.ts:245-367`, `browser-install.ts:34-54`). The `deploy_jobs` row with the release source is what the page polls; the app activates on its first request like a CLI deploy.

### What exists

- Gate: `apps/every-app-gateway/src/server/deploy/browser-install.ts:21-31`; hosted gate `server/platform-policy.ts:199` (`THIRD_PARTY_DEPLOYS` exactly `on`), `:172` (false on self-host).
- Routes and handlers: `src/routes/api/admin/apps/install.ts`, `install/context.ts`, `routes/api/admin/deploys/$id`; `src/server/deploy/install.ts` (`authenticateAdmin`, `mayInstallForOrganization`, `serveInstall` with `assertAvailable()` and `deployerSettings()` before any download).
- Page and hook: `src/routes/install.tsx`, `src/client/components/admin/InstallAppForm.tsx:183-191` (the off and the owners/admins copy), `src/client/app-install.ts:48-70`.
- Pipeline and deployer: `src/server/deploy/run.ts:36-40`, `:121-155`, `:223-340`; `cfRestDeployer.ts:58-76`, `:100-152`, `:175-195`, `:245-367`; `pipeline.ts`; lease and install record `browser-install.ts:34-98`; the CLI's side `packages/cli/src/lib/gateway/install.ts:22-42`, `lease.ts`.
- The install organization: `browser-install.ts` `installOrganizationId()` (this PR; the SQL the registry had inline at `registry.ts:198-204` and the CLI has at `packages/cli/src/lib/gateway/registry.ts:186-207`); the bare hostname rule `packages/perimeter/src/registry/registration.ts:174`, `:215`.
- Settings: `packages/sdk/src/internal/gatewaySettings.ts:89`, `:91`, `:134`, `:168-177`; `packages/cli/src/lib/secretValue.ts:251-254`; setup `runSetup.ts:393-408`, `:975-990`; `everyapp status` has no browser-install line (`packages/cli/src/commands/status/index.ts`, `render.ts`).
- Docs for agents: `landing-page/content/agent/deploy.md:430-432`, `secrets.md:205-206`, `setup.md:26`, `:88`, `:117`, `errors.md:1421-1433`; the setup skill `packages/cli/skills/everyapp/setup/gateway.md:25-26`, `:59` (`secret list --json` → `data.gateway.names` has `CF_DEPLOY_TOKEN` means on), `:143`.
- Threat model: `docs/threat-model.md` B7 (`:962-1090`), known gaps 1 and 32, credentials table (`:1204`: no expiry, never rotated by the gateway); `docs/threat-model-invariants.md` B7 rows `gateway.no-deploy-api-on-self-host`, `gateway.nothing-public-registers-or-deploys-on-self-host` (NOT ENFORCED), `browser-install.policy-subset-and-intake`, B8 rows `install.admin-live-gate-before-download`, `install.self-hosted-default-on`; `docs/security-model.md` Operator Authority; `docs/adr/ADR-0003` Decision 3's note; `docs/runbooks/browser-app-install.md`.
- TODO.md: the Needs Ben entry (line ~409), `CF_DEPLOY_TOKEN` in the public Worker for the preview (~184), `setup --yes` answers No (~477), the Deploy key in the Tokens dialog (~742), no "Install in browser" button (~985), the thin deployer Worker (~1075).

### What a deploy token needs

- A custom Cloudflare API token: Account > Workers Scripts > Edit, Account > D1 > Edit, Zone > DNS > Read, limited to the one account and the Gateway's zone (what setup's prompt and the runbook ask for; whether attaching a Custom Domain needs more than DNS Read is unverified live, since no self-hosted browser install has run).
- Knowing it is account-wide anyway: Workers Scripts Edit cannot be scoped to Worker names, so the token can rewrite every Worker, the Gateway included, and read or write every D1. The code narrows what the Gateway does with it (registry names, ownership tags, `inherit` bindings, hostnames below `APP_BASE_DOMAIN`), not what the token could do.
- A home off the public Worker: a thin deployer Worker holding the token behind `DeployerPort` (`port.ts`), accepting only the install's exact operations over a service binding, so an escape in the Gateway isolate (which also holds `JWT_PRIVATE_KEY`, `BETTER_AUTH_SECRET` and D1) cannot become the operator (TODO ~1075).
- Rotation: no expiry, never rotated by the Gateway; rotate with `secret set CF_DEPLOY_TOKEN` and delete the old token in the dashboard; stop installs with `BROWSER_APP_INSTALLS=off` or `secret unset`; an in-flight job runs to its deadline (TODO ~440).
- The organization restriction: the install organization only (this PR), because the token is the account its owner set up; owners only is the further narrowing.
- A record: `deployed_by_actor` (the admin's email), the `deploy_jobs` row with repository, tag, version and commit, and the CLI's install record; a `deploy_events` log is TODO ~1018.

### The smallest safe slice

(a) Restrict self-hosted browser installs to the install organization's owners and admins: a pure narrowing, one shared query, one check before the download, one filter on the context, one test. Built. (b) `everyapp status` reporting browser installs: a report, but not small today, since a Worker secret's value cannot be read back (names only, read today only when an app declares settings) and #594 rewrote the status page and its drift tests this afternoon; in TODO.md with the exact shape. (c) A setup prompt already exists; widening it was out of scope.

### What was built (PR #610)

- `browser-install.ts`: `installOrganizationId()`; `registry.ts` reuses it for the naming rule.
- `install.ts`: `mayInstallForOrganization` (hosted: every organization; self-hosted: the install organization only, nobody before an owner exists), checked in `authenticateAdmin` after the role check, so availability, install and poll refuse any other organization with `APP_INSTALL_FORBIDDEN` before any download; `serveInstallContext` offers only workspaces the install accepts.
- `install-api.sqlite.test.ts`: a self-hosted describe: the gate on with the three settings and off with `BROWSER_APP_INSTALLS=off` or no token; a second organization's owner and an admin of both who chooses the second refused with no GitHub request and nothing registered, while the install organization's admin passes up to the download; nobody installs before the Gateway has an owner. The existing "self-hosted" refusal is retitled to say it checks a Gateway with no deployer.
- Register row `deploy.browser-install-install-org-only` (B7, 39 invariants; `install.self-hosted-default-on` from unpinned to partial), the B7 row and gap text in `docs/threat-model.md`, `docs/security-model.md`, the runbook, ADR-0003's note, `deploy.md` and `errors.md`, TODO.md. The parity matrix row for the browser install should now read "caller: owner or admin of the chosen workspace; on self-host, of the install organization only".
- Invariant: browser installs spend the account-wide token only for the install organization's owners and admins.

### Decisions for Ben

- Owners only, or owners and admins (today admins are whoever the owner made one, so the two are equal on a fresh Gateway).
- Default `BROWSER_APP_INSTALLS` to off until the token moves out of the public Worker, or keep on-by-default once the token exists.
- Move `CF_DEPLOY_TOKEN` into a thin deployer Worker behind `DeployerPort` (medium), or accept the account-wide token on the Gateway for launch.
- Extend the fake Cloudflare with account-Worker routes so the self-hosted upload is tested in process, or run one live browser install on a test account before Monday.
- `everyapp status` reporting browser installs by secret names (TODO.md has the line shape), and whether `setup` should ask only on the owner-creating install (TODO ~477).

## Threat model

New rows in `docs/threat-model-invariants.md` (B5 and B7):

- `toolbus.workspace-tools-role-gated`: a workspace tool is listed and runs
  only for a caller whose live role reaches its `minRole`; its write tools
  are hidden from and refused for a read-only connection like any write
  tool; the services' own rules apply on top; every call is audited.
- `toolbus.workspace-tools-no-credentials`: no built-in returns a
  credential that opens the Gateway (invite link, reset link, token
  value), and none creates a personal access token;
  `everyapp_workspace_events_add` returns a freshly generated webhook
  signing secret once, which opens nothing.
- `cli.workspace-operator-authority`: `everyapp workspace …` writes the
  Gateway's D1 under the Cloudflare login (ADR-0003) with the services'
  guards as SQL conditions (never the last owner; an admin's role is
  changed only to the roles the UI hands out; a deactivation revokes
  sessions, tokens and connections).
