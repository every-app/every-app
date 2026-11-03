# Every App simplification audit

Date: 2026-11-02. Status: **research only. No product code changed.** You pick what to build.

Method, in one line: 14 area audits on `main` (`500fba5cd`), each checked by a second agent that tried to refute it, then 3 gap audits and a review pass. It skips what oauth-simplify and the L5 deletion lane already do. Details are in the [appendix](#method).

## The short version

- **What we found.** The OAuth pattern repeated in at least nine places. Each step made sense alone:
  - Access;
  - who can open an app;
  - events;
  - caps;
  - AI defaults;
  - credentials;
  - remote MCP;
  - docs;
  - process.

  See [How it grew](#how-it-grew).
- **Most of it is unused.** On everyapp.team there are:
  - 0 groups, webhooks, caps or MCP apps;
  - 0 of 6 sign-in providers turned on;
  - 0 browser installs;
  - 0 write admin tool calls, ever.

  On the demo, the groups and Cap alerts are seed data. You set its $20 OpenSEO cap by hand on 10-31, and its DataForSEO pack has 0 calls. All of this evidence comes from your two Gateways, so "unused" means you haven't needed it.
- **Six standing rules make every feature cost several times over.** In two weeks, 51–58% of code commits also edited the agent docs. See [Rules to change](#rules-to-change).
- **Size.** About **85–90k lines of product code and tests** could go, roughly a quarter of ~370k. Adding docs (~30k), dev tooling (~50k) and generated migration snapshots (~74k), it's **about 240k of the repo's ~564k lines**.
- **Before and after:**

  | | Today | After |
  |---|---|---|
  | Concepts a person meets | 138 | 12 |
  | CLI | 24 commands, 96 subcommands | ~15 commands, ~25 subcommands |
  | Admin tabs | 9 | 4 |
  | Manifest fields | 29 | ~15 |
  | Docs sidebar pages | 28 | 9 |
  | Agent docs | 17.6k lines | ~3.5k |
  | Words an agent reads before its first edit | ~12k | ~1.3k |
  | Six user journeys, total steps | 84 | 43 |
- **The biggest lever on each goal:**
  - **Interface:** Access becomes an opt-in add-on (I1), keys go in the browser (I2), and setup asks nothing it can default (I3).
  - **Building apps:** one short skill, read from `node_modules` instead of copied into every app (B1), one `providers` map (B2), and one release train (B3).
  - **Understanding:** one paragraph for what Every App is, with the three jobs and what it doesn't support (U1), and agent docs a fifth the size (U2).
- **Start here:** the [quick wins](#quick-wins-under-an-hour-each), then I1, I2 and I3.
- **Thirteen items reverse or narrow an earlier call of yours,** marked ⟲. Most are the "build it all" calls of 10-23 to 10-26, which your 11-02 guidance overrides.

## What Every App is, in one paragraph

> Every App runs your team's apps in your own Cloudflare account, and your AI agent uses all of them through one address. Start with open source apps (OpenSEO, OpenCRM, OpenAnalytics and OpenMail), or have your coding agent build the tool you need. Your team signs in once. Shared keys (AI, DataForSEO, Google) stay in the Gateway; apps never see them. You own the code and can change it, and you pay Cloudflare, about $5 a month, instead of paying per seat.

**Home page subtitle,** one line. The #729 H1 "Make every app open source" stays.
> Open source apps and the ones your agent builds, in your Cloudflare account, with one address for your agent.

The agent job leads because it's the one in use. In October on everyapp.team there were 2,103 app tool calls (all but 74 yours, 2,003 of them in CRM), $6.12 of provider spend, and 0 admin writes.

**The three jobs**
1. Run open source business apps for a small team, instead of paying per seat.
2. Put what your coding agent builds online for your team. Sign-in, the database and keys are handled.
3. Let your AI agent use every app you can open, through one address, acting as you.

Supporting all three: you own and change the code, pay Cloudflare by use, see spend, update, and undo.

**After the changes, Every App supports:**
- One Gateway per team, at `apps.<your domain>` in your own Cloudflare account.
- Installing open source apps from a GitHub release.
- Building and deploying your own apps with a coding agent: D1, KV, R2, Hyperdrive, Durable Objects, Workflows, crons, public routes and tools.
- One sign-in for every app: a password, or Cloudflare Access if you turn it on.
- Two roles, with each app open to everyone or to admins only.
- Keys the Gateway holds for providers, and each person's own connected accounts.
- One `/mcp` address for every member's AI client, plus outside MCP servers an admin adds. Tools read or write.
- Activity, one monthly $ cap per app, restore points, status and one update command.

**It does not support** (the test for new work):
- several teams per Gateway, or a hosted service;
- groups or per-person app grants;
- Google, GitHub or SSO buttons on the Gateway's own sign-in (use Access);
- webhooks or event subscriptions;
- read-only or single-app tokens;
- agents with their own identity and permissions;
- installing apps from the browser;
- a `/mcp` per app;
- Cloudflare resource kinds no app uses;
- choosing an AI default beyond "the first key you set".

15 of the 46 top-level features today serve none of the three jobs. All 15 have zero live use.

## One end state

The area audits pointed different ways on sign-in, admin, tokens and AI. These are the leans this doc takes, read together.

| Area | End state |
|---|---|
| Name | "Gateway" is the one name for the place, and Admin is its settings page. "Organization" stays in code. |
| Sign-in | A password. Cloudflare Access is a one-command add-on in one shape. No other sign-in providers. |
| People | Admin and member. One Remove. Each app is open to everyone (the default for new apps) or to admins. |
| Admin | The Gateway UI for people: People, Apps, Providers, Activity. For agents and the terminal, one admin API: the Gateway's own tools, which `everyapp call` reaches. The CLI writes only the 5 tables a deploy needs. |
| Agents | One `/mcp` address. Consent is one Allow. One personal token that acts as you. Tools read or write. An agent acts as the member who connected it. |
| Settings and keys | Pasted in Admin and stored encrypted in D1: the Gateway's keys first, then each app's own. |
| AI | `providers.ai` is the first provider whose key is set, plus one `AI_MODEL` setting. |
| Activity | The audit log and tool calls. One $ cap per app with a default. Usage per app. The Gateway pushing events to apps waits on Birds' branch; `emit()` goes with webhooks. |
| Apps | Installed with `everyapp install`, usually by your agent. Built with `create`, `dev` and `deploy`. A manifest of ~15 fields. No copied skills. |
| Hosting | Self-host only, one team per Gateway. The Gateway holds no Cloudflare token of its own. |
| Docs | 9 user pages, ~3.5k lines of agent docs, one security page. |

Together these mean setup and invites finish without a terminal rerun, keys go in one form, and the Gateway never needs a hand-made Cloudflare token.

Six journeys were walked step by step: first setup, invite, connect an agent, build an app, install an app, and day two. Totals go from 84 steps to 43, 26 CLI commands to 9, and 15 terminal-only steps to 4. The gap that's left: 21 of the 35 live setup items are apps' own secrets, which reach the browser only when they move into the Gateway's store (I2).

## Rules to change

These six rules multiply every feature. Changing them matters as much as any deletion.

| Rule today | Change | Where |
|---|---|---|
| Parity: every UI action also exists as a CLI command (raw SQL) and an MCP tool | One admin API, the Gateway's tools; `everyapp call` reaches them from a terminal. Parity holds by construction. | I6 |
| Drift tests: a prose page must list every flag, code, tool, setting and tab | One test: generated pages match, links resolve, docs name only things that exist | U2 |
| The threat-model register: 425 rows, regenerated when a boundary changes | One ~200-line security page | U4 |
| An event type per admin action (63 today) | Stop | I9 |
| "Defaults taken, confirm" sections in TODO.md for every swath | TODO.md holds questions, one line each, deleted when decided (your 10-13 rule stays) | U4 |
| `pnpm security-review` and "HELD for Ben" on most PRs | Security review for perimeter and identity changes only | U4 |

Also: **a new platform concept lands only when an app running on a Gateway uses it.** #912 shows the cost without that rule: 28 PRs and 30.8k lines of features for an app that runs nowhere.

## Open questions only you can answer

1. **Sign-in (I1, I11) ⟲.** Password by default, with Cloudflare Access as an opt-in add-on in one shape, and no Google or SSO buttons on the Gateway's own sign-in? This reverses #842 ("Access forced on").
   - The Access policy admits your email domain, or any verified email. With any email, Access filters no one, and the invite list is the only gate.
   - Lean: yes, with a domain policy when you have one.
2. **Keys and installs (I2, I12) ⟲.** Three parts:
   - Keys are pasted in Admin, accepting that an admin session can add keys.
   - The Gateway holds no Cloudflare token.
   - Browser installs go, reversing #937.

   Without a token, the first app deploy still re-uploads the Gateway (~2.5 min versus 44 s), and apps' own secrets reach the browser only once they move into the Gateway's store, which touches every app repo. Lean: yes to all three.
3. **Admin (I6).** Replace the CLI's SQL copy with `everyapp call <tool>` over the Gateway's own tools, which keeps your 10-24 parity rule? Or make admin UI-only by deleting the tools (~10k more; 0 write calls ever)? Lean: `everyapp call`.
4. **People (I4) ⟲.**
   - Two roles.
   - One Remove that works like Deactivate.
   - Each app open to everyone or to admins, with everyone the default for new apps (you declined that default on 10-24).
   - No groups or per-person grants.
   - Delete the rule that cancels a demoted admin's pending invites and reset links (it undoes #709).

   Lean: yes.
5. **Hosted tier (M3) ⟲.** Delete it now, overturning `hosted-vision.md` as the contract? git keeps it. Lean: yes.
6. **Birds.** Keep #912's agents with their own identity off main until Birds runs on a Gateway, with an agent acting as the member who connected it meanwhile? Should the Gateway pushing events to apps (#901) also wait on Birds' branch? Lean: yes to both.
7. **MCP apps (I13) ⟲.** Rebasing #938 on oauth-simplify drops its organization-account option, which reverses your 11-02 Decision 1 (shared ElevenLabs credits): members would each connect. Keep the option by keeping organization connections for MCP apps only, or drop it? Lean: drop it.
8. **One release train (B3).** The CLI would refuse an app SDK from another rc and a Gateway schema older than it needs. So after each merge you run `everyapp update` before other commands against everyapp.team. Is Knowledge Base (Carter's) part of the fleet that re-pins each rc, and does it keep its own Google, GitHub and Discord OAuth? Lean: yes, yes, and fold it in later.
9. **The onboarding loop (M2) ⟲.** Delete the only end-to-end test of the setup prompt, which you commissioned on 10-23? Lean: yes; rerun setup by hand before a release.
10. **Security docs (U4) ⟲.** Replace the threat model and its register with one page, and run `security-review` only for perimeter and identity changes? Lean: yes.
11. **Setup defaults (I3) ⟲.**
    - Turn on Email Sending at setup.
    - Install the four apps without asking, which drops #595's "which to skip" question.
    - Make your #762 early-adopter question a notice instead of a stop.

    Lean: yes.
12. **Live Gateways (M4).** After the cuts, reinstall everyapp.team and the demo from one fresh baseline schema instead of writing ~15 drop migrations? It's your live step. Lean: yes.
13. **Repos.** Develop the public apps in their public repos and archive the private twins? Lean: yes.

**Confirm these leans** (say no to any you disagree with):
- **Tokens and tools (I8) ⟲:** one full-access token, one Allow, tools read or write. This ends the launch promise that agents can't delete.
- **Events (I9) ⟲:** the audit log only, and caps exactly your 10-24 ask: one $ cap per app with a default, plus an email.
- **"Gateway" as the one name (I7):** this renames the 35 `everyapp_workspace_*` tools.
- **Unused resource kinds go (B6) ⟲**, reversing "provision every kind" (10-24).
- **Linked dev:** it stays, and its off switch goes.
- **Home page (U1) ⟲:** the one-line subtitle above, leading with the agent job.

---

## 1. Simplify the interface (Gateway UI, CLI, concepts)

Ranked by how much simpler Every App feels to use.

| # | Change | Lines out | Effort | ⟲ |
|---|---|---|---|---|
| I1 | Access: an opt-in add-on in one shape | ~6–8k | L | #842 |
| I2 | Settings and keys pasted in the browser | net ~1–3k | XL | |
| I3 | Setup asks nothing it can default, and ends with apps ready | ~3.5k | M | #762, #595 |
| I4 | People: two roles, one Remove, Everyone or Admins per app | ~5k | L | 10-24 default; #709 |
| I5 | Admin: 9 tabs → 4, plus one "Your account" page | ~0.6k | M | |
| I6 | One admin API; the CLI stops being a second Gateway | ~17k (~6k new) | L | |
| I7 | One word per concept | ~0 | M | |
| I8 | One token, one Allow, tools read or write | ~1.5–2k | M | "agents can't delete" |
| I9 | Events are the audit log; one $ cap; Usage per app | ~14k | L | 10-25 events |
| I10 | CLI: ~15 commands | ~2k | M | |
| I11 | Delete the six sign-in providers | ~7.7k | L | 10-25 sign-in swath |
| I12 | One install path | ~9.6k | M | 10-24, 10-26, #937 |
| I13 | MCP apps: land #938 slimmed; delete per-app `/mcp` | ~1.9k (+3.5k never added) | M | 11-02 Decision 1 |

### I1. Access: an opt-in add-on in one shape ⟲
- **Today:**
  - Setup puts Access in front by default, which asks for a permanent team name, creates 6 Cloudflare resources and waits up to 15 minutes for the owner.
  - Two Access apps: the Gateway, and the app wildcard.
  - A Gateway session counts on app hosts only alongside Access's signed header on that same request.
  - Bypass lists are synced on every deploy.
  - Four activation triggers work around Access blocking the deploy probe.
  - Plus: Access OIDC sign-in, Managed OAuth on `/mcp`, auto-join (by domain or for everyone), an identity-provider list, a passwords-off switch, account linking, reconcile on every `update`, and a remembered opt-out in D1.
  - `bearerRoutes` mainly tells Access which paths let a bearer token through.
  - Invites don't get past Access until someone reruns `access on`.
  - No onboarding-loop run ever exercised the default path.
- **Change:** setup stops asking about Access, and the owner page ends setup. `everyapp access on` becomes a one-command add-on with:
  - one Access app on the Gateway host;
  - Access signing people in (PIN, Cloudflare login, Google or SSO), after which the Gateway session is the truth everywhere;
  - app hosts kept private by the Gateway's session;
  - a policy that admits your email domain or any verified email, while the Gateway's invite list decides who's a member. Invites need no rerun, and the Gateway needs no Cloudflare token;
  - a fixed recipe (team, PIN, one app, two settings), so its 10 flags drop to about 2.

  Everything else above goes.
- **Lines out:** ~6–8k of ~11.5k Access code, plus ~1.5k of docs. The 886-line runbook drops to ~150.
- **Users lose:**
  - Access by default on new installs.
  - The edge check on app hosts: a stolen Gateway session cookie would work on them without an Access cookie.
  - SSO through Access OIDC.
  - Auto-join by domain.
  - Turning passwords off.
  - With "any verified email", Access filters no one. Only a domain policy keeps strangers away from the sign-in page, and each stranger who passes the PIN uses a Zero Trust seat (50 free).
- **Breaks:**
  - Both live Gateways delete their apps Access application. everyapp.team can keep the add-on.
  - Talk's and the Birds hub's `bearerRoutes` become `public` entries with `bearer: true` (B6).
  - "Delete becomes Deactivate" (`access-rejoin.ts`) goes with auto-join.
  - **Order matters.** The Better Auth plugin refuses a session on an app host without Access's signed header on that request (`cloudflare-access/plugin.ts:316–338`). That check, and the rule that tells the two Access app IDs apart, must go in the same change. Otherwise every app request fails.
- **⟲ #842.** In the new shape, Access on by default would still cost a team-name question, a Zero Trust team and a PIN email at sign-in. Off by default costs the edge filter on new installs. Open question 1.

### I2. Settings and keys pasted in the browser
- **Today:**
  - OAuth clients live in two stores: the UI's encrypted D1 row, and Worker secrets from the CLI. The Worker secret wins.
  - API keys and sign-in clients can only be set from a terminal. The UI prints `pnpm everyapp secret set …` 18 times.
  - There are 113 settable Gateway setting names, and adding one means editing 6 lists.
- **Change:**
  - Every Gateway-held key is stored encrypted in D1 and pasted in Admin.
  - "Needs setup" becomes a form.
  - Delete the Gateway branch of `secret set/unset/list`, the precedence rules, and the docs' "three ways a key gets in".
- **Lines out:** small net, ~1–3k. The win is UX: setup and install finish in the browser.
- **Users lose:** the rule "a stolen admin session can't add a way in". That threat-model row flips on purpose.
- **Breaks:**
  - A one-off copy of the existing keys on both Gateways.
  - The full fix also moves apps' own secrets (MAIN_SECRET, GITHUB_TOKEN…) into this store, with apps reading them through the SDK. That's one change in about 9 app repos (XL). Without it, 21 of 35 live setup items still need a terminal.
  - Land after oauth-simplify, which keeps both stores for OAuth clients.

### I3. Setup asks nothing it can default, and ends with apps ready ⟲
- **Today:**
  - The setup prompt is 521 words and always asks 3 questions: early adopter, domain, which apps.
  - It deploys a throwaway "hello" app, the only reason setup needs pnpm, git and a local build.
  - After the four apps install, a person still sets OpenRouter, DataForSEO, MAIN_SECRET, EMAIL_FROM/EMAIL_FROM_NAME and Email Sending, all in a terminal.
- **Change:**
  - **Domain:** with one zone, use `apps.<zone>`.
  - **Apps:** install the four without asking, which drops #595's "which to skip"; any of them can be deleted later.
  - **Prompt:** drop "hello"; shrink to ~60 words; your #762 early-adopter question becomes a notice in setup's output.
  - **Email:** setup starts Cloudflare Email Sending on `apps.<domain>` as `noreply@`, named after the Gateway, and doesn't wait for it. Invites use links until DNS passes (5–15 min).
    - Delete Resend, the REST transport and `EMAIL_PROVIDER` (~950 lines; no app reads them).
    - Caveats: Email Sending is in beta with a low daily quota, and no one has checked that the `cf` login can call its API.
  - **AI:** the default model is the first provider whose key is set (OpenRouter, OpenAI, Anthropic, Workers AI), plus one `AI_MODEL` setting.
    - Delete the stored choice, per-provider models, AI Gateway fronting, `ai default|model|list|gateway` and 3 AI tools (~2–2.6k).
    - Not Workers AI with no key: its model writes OpenMail's tool calls out as text.
  - **Generated secrets:** `generate: true` on a manifest secret (Analytics' MAIN_SECRET, Knowledge Base's BETTER_AUTH_SECRET).
  - **Preflight:** one check, before anything is created, for Workers Paid, R2, the workers.dev name and a zone.
- **Lines out:** ~3.5k, with ~0.3k added.
- **Users lose:** being asked first; Resend; picking a default model in a UI.
- **After:** the only person steps are DataForSEO's key, and OpenMail's inbound address (`email set --inbound` plus Email Routing).

### I4. People: two roles, one Remove, Everyone or Admins per app ⟲
- **Change:**
  - Delete groups (L5) and per-person app grants: the Manage access modal, AppAccessService and its repository, and the rows written for every member when an app is "available to everyone".
  - Who can open an app is computed: `app.everyone OR role is admin`.
  - Merge owner into admin, keeping a last-admin guard.
  - Replace Deactivate, Reactivate and Delete with one **Remove** that works like Deactivate:
    - it signs the person out everywhere and revokes their tokens, AI connections and connected accounts;
    - it keeps the account row, so app data keyed by their user id keeps its owner;
    - inviting the same email again restores them.

    This needs I1's auto-join removal first. Auto-join is why Delete quietly becomes Deactivate today.
  - An invite is one page: "Join <Gateway>", with name and password and the email locked. Creating the account accepts the invite.
  - Delete the rule that cancels a demoted admin's pending invites and reset links.
  - Delete the Edit-app dialog: every deploy overwrites its name and description.
  - New apps open to everyone by default ⟲. You declined that default on 10-24 (TODO.md:760), and the docs home's "Private by default" line changes. Mission Control sets `access: "admins"`.
- **Lines out:** ~5k: groups ~2.5k, grants ~1.2k, Remove ~0.3–0.8k, the demoted-admin rule ~0.65k, Edit app ~0.4k, roles ~0.25k.
- **Users lose:** opening one admins-only app to a single member; named groups; the owner tier; hard-deleting an account.
- **Breaks:**
  - A migration adds `apps.everyone` from today's live `is_default`, not from the manifests, which have drifted. It drops the grant and group tables.
  - Nobody on everyapp.team holds a grant without being an admin.
  - oauth-simplify's "may use the app" check reads the new rule.
  - Undoes #709: a demoted admin's invites and reset links stay valid until they expire (72 h, 1 h).
  - #915 `listGroups` doesn't land.

### I5. Admin: 9 tabs → 4, plus one "Your account" page
- **Admin keeps:** People, Apps, Providers, Activity.
- **Goes:**
  - Sign-in (read-only);
  - Groups and Events (I4, I9);
  - Usage as its own tab (its table moves onto Apps or Activity);
  - Tokens (members can already create them; the page just sits behind admin).
- **Your account:** Agents (AI connections, devices, tokens), Connected accounts, Sign-in.
- **Renames:**
  - "Manage workspace" → "Admin" (docs already say "Admin →" 129 times);
  - "Users" → "People" (keep the `/admin/users` route, which apps link to);
  - "AI connections" → "Agents" (after open question 6).
- **App status chips:** 9 → 4 (Open, Needs setup, Deploying, Off).
- **Keep your calls:** pinned-first in the launcher (#571) and "Add it to your phone".
- **Lines out:** ~0.6k beyond the feature cuts (tabs ~150, the Tokens move ~450).
- **Breaks:** `/admin/tokens` redirects; four app repos link to it. The `agentDocs.test.ts` tab checks change.

### I6. One admin API; the CLI stops being a second Gateway
- **Today:**
  - The CLI reads or writes raw SQL on 33 of the Gateway's 41 migration tables (47 with the 6 it creates itself): 282 SQL lines and 104 INSERT/UPDATE/DELETE statements.
  - It writes audit events from 13 files, keeps an event outbox, and probes for older schemas in 50 lines.
  - ADR-0003 allowed it 7 tables.
  - The parity rule then makes every UI action exist three times.
- **Change:**
  - The Gateway's admin tools, which run through its real services, become the one admin API: for agents in chat, and for the terminal through `everyapp call <tool> [json]` (and `everyapp call --list`). That's ~200 lines.
  - Delete the CLI groups that are SQL copies: `workspace` (24 subcommands), `events`, `ai` and `signin`, plus the outbox, the `setup_state` writes and the schema probes (9 codes).
  - `provider` goes after oauth-simplify, which keeps `provider add` for OAuth clients. Fold it into `configure` there, or keep it until I2.
  - The CLI writes only the 5 tables a deploy needs: the install row, the deploy lease, app resources, the `apps` row, and the setup or recovery link.
    - A recovery link is the way back in for a locked-out owner. The `recovery` kind already exists, unused.
    - Write that contract into ADR-0003 as step one.
  - Parity holds by construction, so the parity test and matrix go.
  - Admin tools are found through search, not listed. Owners stop seeing 59 extra tools, and the demo owner's list (261) drops back under the 256 cap.
- **Lines out:** ~17k. About 10k of it is L5's `workspace` and `events` cut, and 1.3k is I11's `signin`. New here: ~6k.
- **Users lose:** per-command flags and help (`workspace invite --role`) become JSON arguments to a named tool. Terminal admin needs a personal token.
- **Breaks:** about 500 doc and skill mentions, and the Gateway strings that print CLI commands (`secret set` ×18, `signin add` ×7, `provider add` ×7).

### I7. One word per concept
- **The place:** it has four names (Gateway, workspace, organization, team). Use **Gateway**: it has a name, such as "EveryApp Team", and people join it by name.
  - "Manage workspace" → "Admin"; "Join organization" → "Join EveryApp Team".
  - "Workspace" leaves the UI, CLI and tools, and the 35 `everyapp_workspace_*` tools are renamed in the same breaking batch.
  - "Organization" stays in code (`orgId`, the SDK, the apps).
- **One word each:**
  - "Provider" absorbs capability and integration.
  - "Agent" absorbs AI client, AI app, AI connection, connector and assistant.
  - "Settings" absorbs secret, setting, Gateway setting and key.
  - "Connection" gets one meaning: the AI-client `connection.*` events become `agent.*`, and `my_connections` becomes `my_agents`.
  - Always "Cloudflare Access", never "outer ring".
- See the [concept list](#minimal-concept-list).

### I8. One token, one Allow, tools read or write ⟲
- **Tokens:** name plus expiry, acting fully as you. Only full-access tokens reach app routes today, and CRM checks for one.
  - Delete the Read only / Read & write presets, App scope, the custom date and the hosted-only Deploy key.
  - Tokens move to Your account (I5).
- **Consent:** one Allow. Delete the "Only these apps" picker and the read-only choice. Native and dev grants keep their one app.
- **Tools:** drop the hidden `destructive` level.
  - 13 tools are hidden "until approvals exist", and approvals were never built.
  - OpenSEO already declares its deletes as `write` to get around it.
  - Apps keep `destructiveHint`, so clients still ask before calling.
- **Lines out:** ~1.5–2k.
- **Users lose:** read-only and single-app tokens and connections. ⟲ This ends the launch promise "agents can't delete", which `connect-ai.mdx` still makes.
- **Breaks:** tool tests in about 8 app repos pass read and write scopes.

### I9. Events are the audit log; one $ cap; Usage per app ⟲
- **Events:**
  - Delete webhooks, the email sink, subscriptions and deliveries, signing, retries, redeliver, `ping`, the per-minute delivery cron, `apps.setup_state`, `tool.*` events, Admin → Events, `everyapp events` and the event tools.
  - Stop adding an event type per admin action.
  - Keep the event bus and catalogue while the audit log reads them.
  - Delete SDK `emit()` (#643, from the 10-24 events swath): with webhooks gone, nothing reads app events.
  - Move the Gateway pushing events to apps (#901) and the manifest `events` field to Birds' branch until Birds runs on a Gateway. Apps that care who left call `listMembers()`, as CRM and Analytics already do.
- **Caps:** you asked on 10-24 for a default cap ("say, $20 a month and stop") and an email when it's hit. Keep exactly that:
  - one $ cap per app with a Gateway default, and a direct email to admins;
  - delete call caps, `unlimited`, the `cap.*` events and the Cap-alerts subscription.
- **Usage:** one table per app.
- **Lines out:** ~11–13k for events (L5 counted ~7.4k of it), ~2–3k for caps, ~0.9k for usage.
- **Users lose:**
  - Slack and Zapier webhooks (none set up);
  - per-member provider spend (near-empty, since background calls carry no person);
  - per-model spend (3 models in October).
- **Breaks:** Workout's `workout.finished` and the starter's `todo.completed` emit calls; the demo's Cap-alerts row.
- **⟲:** these were built under your 10-25 "assume we want all of this".

### I10. CLI: ~15 commands
- **Commands:**
  - building apps: `create`, `dev`, `deploy`, `release`, `db`;
  - running the Gateway: `setup`, `update`, `install`, `configure`, `status`, `delete`, `access`, `login`;
  - admin: `call`, plus `recover` for a locked-out owner (I6).
- **Folds and cuts:**
  - `secret`, `email set` and later `provider add` fold into `configure`; `deploy-token` goes with I12.
  - Keep `update`: it refuses to install a second Gateway. Keep `login`: about 8 errors name it as the rerun.
  - `--json`, `--verbose`, `--gateway` and `--account-id` become global. They're ~370 of the 556 flag rows. `--org` (37 more) is deleted.
  - The five override flags become two: `--force` for DNS and email routing, and `--delete-data` for Durable Objects and Workflows.
  - Delete `dev --mode mirror` and `--base-host`.
- **`update` takes the Gateway and every installed app** to their latest releases. Install records each app's origin, and `status` shows "newer release". The operator stops keeping a list of install URLs. Adds ~200 lines.
- **Lines out:** ~2k beyond I6, plus ~1.6k of `cli.md`.

### I11. Delete the six sign-in providers ⟲
- **Change:** delete Google, Microsoft, GitHub, Apple, Cloudflare and generic OIDC sign-in, along with:
  - the read-only Admin → Sign-in tab;
  - `everyapp signin` and its 15 `<ID>_SIGNIN_*` settings;
  - six setup recipes and the runbook;
  - the sign-in sections of the generated provider pages;
  - Apple's callback exception.
- **Lines out:** ~7.7–8.4k: code 6.1k, docs 1.6k, generated pages 0.4k.
- **Users lose:** "Continue with Google…" on a Gateway without Access. None is turned on, on either Gateway.
  - Access offers a PIN and Cloudflare login with no setup.
  - Google or SSO through Access need one identity-provider setup in Zero Trust, not one per sign-in button.
- **Breaks:** nothing live. Passwords stay.
- **⟲:** your 10-25 sign-in swath, "build the best thing long term".

### I12. One install path ⟲
- **Today:** two deploy engines: the CLI's, and the Gateway's own copy for browser installs, behind `CF_DEPLOY_TOKEN` plus `BROWSER_APP_INSTALLS=on`. Every install on both Gateways came from the CLI.
- **Change:** delete browser installs: `server/deploy` after the hosted cut, the install UI, `deploy_jobs`, `deploy-token`, `BROWSER_APP_INSTALLS` and `CF_DEPLOY_TOKEN`.
  - The gallery cards become a prompt to paste into your agent, as Build your own already does: "Install OpenSEO on my EveryApp: `everyapp install https://github.com/every-app/open-seo`".
  - Setup installs the four apps (I3), so a fifth is rare.
- **Lines out:** ~9.6k.
- **Users lose:** installing with a click when no terminal or agent is to hand.
- **⟲:** your 10-24 and 10-26 calls, and #937, merged today.

### I13. MCP apps: land #938 slimmed; delete per-app `/mcp` ⟲
- **Live use:** none on everyapp.team; the demo's DataForSEO pack has 0 calls.
- **Why keep them:** you gave #938 a go this morning. An admin adds a server once, every member's client sees it, and the key stays on the Gateway.
- **Change:**
  - Rebase #938 on oauth-simplify without its `mcp` scope set (oauth-simplify deletes scope sets) and without its organization-account option.
  - Phase 2 is a net cut: the credential becomes a provider row, and the `_MCP_TOKEN` family and `remote_mcp_credentials` go.
  - Keep its "Not metered" label: the one $ cap can't see remote calls.
  - Delete per-app `/mcp` (`mcp: { by, why }`): no app sets it.
- **Lines out:** ~1.9k for per-app `/mcp`; ~3.5k of #938 never lands.
- **⟲:** dropping the organization account reverses your 11-02 Decision 1 (shared ElevenLabs credits). Open question 7.
- **Alternative:** delete MCP apps entirely (~19–22k).

---

## 2. Make apps easier to build

| # | Change | Lines out | Effort | ⟲ |
|---|---|---|---|---|
| B1 | One short skill, read from `node_modules`, not copied into every app | 13.9k per app; ~0.6k in repo; ~6k words | M | |
| B2 | One `providers` map and one `settings` list in the manifest | ~2k + ~2k docs | L | |
| B3 | One release train: one version for everything | ~2.5k + app YAML | L | |
| B4 | The starter is just the app | ~0.7k | M | |
| B5 | Dev: one mode, one way to act as someone; deploy asks for keys | ~1–2k | M | |
| B6 | Manifest: 29 fields → ~15 | ~7k | L | 10-24 every kind |
| B7 | SDK: one way to do each thing | ~3–4k | L | |

### B1. One short skill, read from `node_modules`
- **Today:**
  - `everyapp create` writes 93 files, 54 of which are two copies of the skills: 13,872 lines and ~180k words. 84% of the words are operator setup guides an app author never needs.
  - The copies go stale: Workout carries 52 files, Mission Control 28.
  - Before its first edit, an agent is told to read ~12k words:
    - AGENTS.md: 951 words, repeating SKILL.md;
    - the build SKILL.md: 2,018 words and 14 rules;
    - `patterns.md`: 5,931 words and 88 rows;
    - the operator skill: 3,189 words.
  - About a quarter of the patterns are aspirational: 9 rows cover resource kinds no app uses, plus Turso, and 2 tell agents to copy `currentUser()` usage no app has.
- **Change:**
  - Copy no skills. AGENTS.md (≤15 lines) points to `node_modules/everyapp/skills/*`, which always matches the pinned CLI. Delete `skills update`.
  - SKILL.md: ~1,000 words and 6 rules (in the appendix).
  - `patterns.md` becomes look-up only, ~55 rows, each citing a file that exists.
  - The operator skill becomes routing.
- **Words before the first edit:** ~12k → ~1.3k.
- **Users lose:** auto-triggering of the operator skill inside an app folder.
- **Breaks:** the CLI's `Guide: .claude/skills/...` lines (`settings.ts:292`) and the security-review pointer repoint.

### B2. One `providers` map and one `settings` list
- **Today:** four lists for "something the app needs set": `providers` (AI keys, an array), `capabilities` (API keys, OAuth, email, members), `secrets` and `settings`. They show up as 7 setup kinds, and OpenSEO uses three of the lists. On top of that:
  - every capability entry carries `access: read|write`, though each built-in offers one level;
  - `members` must be declared just to call `listMembers()`;
  - AI is declared up to three ways (`ai.chat`, `providers`, `ai.models`);
  - an extra AI route needs both the manifest's `ai.routes` and the operator's `AI_PROXY_EXTRA_ROUTES`.
- **Change:**
  - One map, `providers: { <id>: { why, optional?, scopes? } }`, with `ai` as the reserved id for the Gateway's default model.
    - Members are implicit.
    - Email send and inbound are one entry.
    - Delete `access` and the catalog's `readMethods`/`writeMethods`.
  - One `settings` list: today's `secrets` and `settings` merged; secret unless marked plain, with an optional `default`.
  - Delete `anyOf` and `secrets[].setup` (0 uses), the `ai.models` allowlist and `AI_PROXY_EXTRA_ROUTES`: the manifest is the grant. Close #914.
  - Rename `integrationFetch` to `providerFetch`.
  - Ship it in oauth-simplify's breaking release, which rewrites these entries anyway.
- **Lines out:** ~1.5–2.5k code, plus ~2k docs (`docs/capabilities.md` and `docs/manifest-settings.md` fold in).
- **Users lose:** read-only grants on the 26 catalog providers that offer both levels (only daytona is used, with write); an operator's second yes for extra AI routes.
- **Breaks:** every manifest (8 apps), about 14 call sites, and Knowledge Base, which is live with no local source.

### B3. One release train: one version for everything
- **Today:**
  - Ten app repos use six different pins: rc.1 (Analytics, 55 SDK commits behind), rc.3 ×5, rc.7, `^rc.10` ×2, a vendored tarball (OpenMail #19) and a `link:` (Birds).
  - About 21 compatibility mechanisms (~1.3k lines) keep mismatched pieces working.
  - The version checks never fire: `compareVersions` drops the prerelease part, and every `package.json` says 0.3.0.
  - About 15 platform waves caused ~68 matching app PRs in 15 days, and 9 are still open or held.
- **Change:**
  - **One train.** Each rc publishes the CLI, SDK and Gateway from one main commit, and every first-party app re-pins to it exactly, one PR each. `everyapp create` writes the exact version.
  - **One real check.** The CLI refuses an app SDK from another rc, and a Gateway whose applied migrations are older than it needs.
    - Delete the compatibility code: the hand-written looser manifest check for older CLIs (stored rows get a lenient reader derived from the strict schema), `GATEWAY_PREDATES_*`, `CLI_TOO_OLD`, `DOWNGRADE_REFUSED`, `minSdk`, and the old-bucket adoption.
    - `SDK_VERSION` goes in the breaking batch: the ToolBus still requires it.
  - **One Gateway source:** this CLI's release, or the checkout's build. Delete the four `--release` source forms and the live-release re-fetch.
  - **One way to get the CLI and SDK:** an exact npm pin. Delete `pack-for-app --vendor`, `vendor/` dirs, `link:` and caret ranges.
  - **One workflow:** apps call a shared `app-release.yml@<tag>` (~10 lines), carrying #830's build/publish split, instead of 28–118-line copies.
  - **Land on main or don't land.** #912 is what a long feature branch costs.
- **Lines out:** ~2.5k platform, plus ~450 lines of app YAML.
- **Users lose:** running an app on an older rc without re-pinning. After each merge, you run `everyapp update` before other commands against everyapp.team.
- **Breaks:** each rc needs one re-pin PR per app before the apps redeploy.

### B4. The starter is just the app
- **Change:** the starter (38 files, 1,376 lines → ~28 files, ~700) drops:
  - the "What this app was allowed" tour, most of `home.ts`, and `/health`;
  - the `emit()` example (I9);
  - the knip and prettier config, and the stale `jose`;
  - the theme copy: follow the launcher's cookie, or move it into the SDK (5 copies across apps today);
  - the hidden `delete_todo` tool.
- **#912:** its D1 test helpers (`createTestDb`, `chunkRows`) go into `@every-app/sdk/testing`, not the starter, and `starter-changes.md` never lands.
- **New apps** get no `release.yml`, or B3's 10-line call.
- **Users lose:** examples that now live only in `patterns.md`.

### B5. Dev: one mode, one way to act as someone; deploy asks for keys
- **Mirror mode:** delete it. No app uses it, and it was flagged dead on 10-24. ~0.7k.
- **Linked dev:** keep it; you asked for it on 10-28. Drop the off-by-default switch you had to flip by hand on both Gateways.
- **Acting as someone else:** keep one way, #912's switcher page without its CSRF nonce. Today it's `dev token`, an anon header and a cookie, and #912 adds `--as` too.
- **#912's other dev additions:**
  - Drop `dev url`, `dev.json` and the dev event delivery unless Birds needs them.
  - Shrink the cascading-drop guard (929 lines of SQL parsing) to a skill rule plus a ~30-line `ON DELETE` check inside migrate and deploy, with no `db check` command.
- **Keys and tools:**
  - At a terminal, `deploy` asks for missing keys.
  - `everyApp()` takes lazy tools, so CRM and OpenSEO stop hand-routing `/__everyapp/`.
- **Lines out:** ~1–2k.

### B6. Manifest: 29 fields → about 15 ⟲
- **Delete fields no app sets:**
  - `main` and `devPort` ("read by nothing");
  - `database` and the Postgres/Prisma path;
  - `limits`;
  - `serverFnGuard` and `serverFnBase`;
  - `mcp` (counted in I13);
  - the documented-but-nonexistent top-level `scopes` row.
- **Delete the 9 unused resource kinds:** queues, ai, browser, images, vectorize, aiGateway, sendEmail, secretsStore, analyticsEngine (~6k across the SDK, perimeter and CLI; L5's count).
- **Fold:**
  - `publicAssets` and `bearerRoutes` become `public` entries (`{ path, methods?, bearer? }`);
  - `capabilities`, `ai`, `email` and `settings` fold in through B2;
  - `events` waits on Birds' branch (I9).
- **Infer:** the `migrations` engine and binding.
- **Pick one place for R2 and crons.**
- **Lines out:** ~7k, most of it the resource kinds.
- **Breaks:**
  - Talk and Birds move `publicAssets`/`bearerRoutes` into `public`.
  - CRM, OpenSEO and OpenMail move R2 from `cloudflare.config.ts` into `resources.r2`.
- **⟲:** your 10-24 "provision every kind".

### B7. SDK: one way to do each thing
- **Today:** 701 public exports, of which apps import 69 and 502 live in `/internal`. There are 7 ways to call a model (apps use 1) and 5 ways to say whom a call is for.
- **Change:**
  - **Delete exports with 0 app importers:** `ai()`, `aiStatus()`, `AI_DEFAULT_BASE_URL`, `isAiNotConfigured`, `gatewayAiBinding`, `gatewayEmailBinding`, `fromMcpTools`, `nodeServerHandler`, `authorizeUrl`, `withOrganization`, `currentUser`, `requireCurrentUser`, 3 error classes and `everyApp`'s 3-argument form. Mostly L5's list, confirmed.
  - **`for`** shrinks to `{ userId }` once hosted goes (M3). CRM and OpenSEO can delete their own attribution modules today.
  - **One local-dev path:** the local Gateway supplies the binding, so the SDK drops its second, in-app copy of the provider, email and members logic (~0.6–0.9k).
  - **Package boundary:** move `/internal` to a private package (no line change; clarity; see M5).
  - **Tests:** CRM and RepoLens use `sdk/testing`.
- **Lines out:** ~3–4k.

---

## 3. Make Every App easier to understand

| # | Change | Lines out | Effort | ⟲ |
|---|---|---|---|---|
| U1 | One paragraph, three jobs and "does not support", everywhere | 0 | S | #729 subtitle |
| U2 | Agent docs: ~3.5k lines, not 17.6k; one docs test | ~13k | L | |
| U3 | User docs: 9 sidebar pages, not 28; provider pages behind one table | ~1k | L | |
| U4 | One security page; TODO.md holds questions only | ~6k | M | security-review rule |

### U1. One paragraph, three jobs and "does not support", everywhere ⟲
- **Today:** 12 different one-liners pull three ways:
  - "replace SaaS" (home H1, README);
  - "host what your agent builds" (docs home);
  - "one agent across your apps" (the blog post, the clearest).

  Also:
  - The home page shows the MCP point only in an image's alt text.
  - "EveryApp launched this week" is stale.
  - The CRM line is wrong in 7 places: CRM #17 removed its agents, OpenRouter and Context.
  - The Gateway and `llms.txt` tell npm users to run `pnpm everyapp` from a checkout they don't have.
- **Change:**
  - Put [the paragraph](#what-every-app-is-in-one-paragraph) on the docs home, `llms.txt` and the README.
  - Change the home subtitle only; your #729 H1 stays.
  - Add each "does not support" line when its deletion merges, so the page is never false.
  - Reorder "Why": one address for your agent, you own and change the code, ~$5 a month instead of seats, then security.
  - Make `featuredApps.ts` the one source for app lines.

### U2. Agent docs: ~3.5k lines, not 17.6k; one docs test
- **Today:**
  - `llms.txt` is a ~3.5k-word index in front of 25 pages: 325k words, ~430k tokens.
  - `errors.md` has 390 hand-written entries, mostly restating the message.
  - `cli.md` repeats each command's `--help` block (1,574 lines) and four flags on every command.
  - About 1.1k lines are "## Sources" sections.
  - Aligned tables pad 24% of the bytes, and agents hit tool-output truncation reading `setup.md` (165 KB).
  - The site mirrors 13 internal docs (87k words) and serves `llms-full.txt` (~360k words).
  - The cause: about 30 drift tests require a prose page to list every flag, code, tool, setting and Admin tab.
- **Change:**
  - `errors.md`: one line per code. Keep the `### CODE` headings, because 415 links point at them.
  - `cli.md`: tables plus each command's description; global flags once.
  - Drop the Sources sections; unpad the tables.
  - One reference per feature: the agent page is the reference, the user page is one screen, and there's no runbook unless it's operational.
  - Stop mirroring `docs/` (except the security page, U4); drop `llms-full.txt`.
  - Replace the "documents every X" tests with one test: generated pages match, links and anchors resolve, docs name only things that exist (both directions for manifest fields). Move generation from vitest UPDATE mode into a plain script.
- **Pages:** ~13 (`cli.md` and `errors.md` stay, shorter).
- **Lines out:** ~13k, plus ~1k of test lines.
- **Users lose:** prose per error code; the guarantee that every new flag gets prose (the generated `cli.md` still lists it).

### U3. User docs: 9 sidebar pages, not 28
- **Pages:** What it is, Set up, Apps, Connect your agent, Invite people, Build an app, Keys and accounts, Troubleshooting, Commands. ~5k words.
- **Moves:**
  - `events` and `usage` go.
  - `native-sign-in` moves to the agent docs.
  - `google-personal-accounts` becomes a row in the Google section.
- **Provider pages:** the 81 generated pages (24k words) stay for SEO and your #753 ask, but leave the sidebar, behind one table.
- **Lines out:** ~1k.
- **Breaks:** ~10 Gateway and CLI links into docs pages; add redirects.

### U4. One security page; TODO.md holds questions only ⟲
- **Security today:** 3,931 lines, ~900 KB:
  - `threat-model.md` (2,061 lines);
  - the 425-row invariant register (531 KB, touched in 73 commits in two weeks; about a third of its rows cover features cut here);
  - `security-model.md` (1,314 lines).

  The documents disagree on their own row count.
- **Security change:** a `docs/security.md` of ~200 lines:
  - who it's for, and the one rule: a person's credential stops at the Gateway;
  - ~24 invariants, each naming the test that pins it, including hosted-vision's three core ones;
  - the top 10 gaps.

  Keep the `/docs/agent/repo/threat-model` slug, which vendored skills link to. `pnpm security-review` reads the new page and runs for perimeter and identity changes only ⟲.
- **TODO.md today:** 2,378 lines, 1,351 open boxes, touched by 194 of 546 commits.
- **TODO.md change:** ~200 lines: Questions for Ben (a default to confirm is one line), Next, Known gaps, Parked. Delete the history docs (L5).
- **Lines out:** ~3.7k security and ~2.2k TODO, plus L5's ~5.2k of history docs.
- **Users lose:** per-invariant `path:line` pointers.

---

## Order of work

Breaking changes land together, so each app takes one re-pin PR, not one per change. About 24 manifest, SDK and wire changes touch the apps:

| App | Rows |
|---|---|
| CRM | 14 |
| OpenMail | 13 |
| OpenSEO | 12 |
| Analytics | 9 |
| Talk | 9 |
| Birds | 8 |
| Workout | 7 |
| Mission Control | 5 |
| RepoLens | 4 |
| Knowledge Base | 3 (blind) |

0. **Now:**
   - the quick wins;
   - close #896 and #909;
   - split #912 ([In-flight PRs](#in-flight-prs));
   - rebase #938 on oauth-simplify.
1. **Prep wave on rc.10,** one PR per app:
   - an exact pin;
   - tests move from `sdk/internal` to `sdk/testing`;
   - CRM mail moves to `connectUrl` + `integrationFetch`;
   - OpenSEO leaves the organization connection;
   - the shared release workflow;
   - OpenMail drops `vendor/`.
2. **Changes that don't touch apps,** in any order:
   - M1 (snapshots) and M2 (dev tooling);
   - I6 and I10 (CLI);
   - I1 (Access shape);
   - I5 (tabs);
   - I9's Gateway side;
   - I11 (sign-in);
   - I12 (installs);
   - M3's Gateway side;
   - B1 (skills);
   - U1–U4 (docs).
3. **One breaking batch on main,** with one CHANGELOG section:
   - oauth-simplify;
   - B2 (providers and settings);
   - B6 (manifest);
   - B7 (`for`, exports);
   - I8 (read/write tools);
   - I9's `emit()` removal;
   - I7's tool renames;
   - B3's version check and `SDK_VERSION`.
4. **Publish 0.4.0-rc.1** and the Gateway tag.
5. **Re-pin wave:** one PR per app.
6. **Update the Gateways:** demo, then everyapp.team, redeploying every app that session. Reinstall `agentic-inbox` as `openmail`, or reinstall both Gateways from a fresh baseline (M4).
7. **Then the bigger UX pieces:**
   - I2 (keys in the browser);
   - I3 (setup defaults);
   - I4 (people);
   - B4 and B5 (starter, dev).

---

## Quick wins (under an hour each)

These change what a person or agent sees, and none waits on an open question. Housekeeping for agents is in the [appendix](#housekeeping-quick-wins).

| What | Where | Min |
|---|---|---|
| Build-your-own prompt and gallery cards for npm users: drop "every-app folder", `create ../` and "never npx"; cards give a prompt for your agent | `client/lib/{buildPrompt,firstScreen,featuredApps}.ts` and their tests | 45 |
| Setup and status "Next": `create my-app`, not `create ../my-app`; one AI line that matches the docs | `commands/setup/index.ts:134–153`, `status/next.ts:251` | 30 |
| Fix the `llms.txt` header, which says the CLI runs "as `pnpm everyapp` from the EveryApp checkout" | `landing-page/src/lib/llms.ts:127` | 10 |
| OpenCRM line: "A CRM that files your conversations for you", needs "Nothing required" (or relax the test) | README, home page, `docs/index.mdx`, `apps/{index,crm}.mdx`, `featuredApps.ts`, `agent/apps.md` | 25 |
| Remove the "launched this week" bar | `landing-page/src/routes/index.tsx` | 5 |
| Accept the invite when the account is created; skip the "Join organization" screen | `routes/accept-invitation.tsx:225–241` | 60 |
| Drop name and description from Edit app: every redeploy overwrites them (keep the everyone switch) | `EditAppModal.tsx` | 20 |
| One "Reset password" item instead of two | `UserActionsMenu` | 30 |
| Rename in the UI only: "Manage workspace" → "Admin", "Users" → "People" (keep routes; "Agents" waits on Q6) | sidebar, headings, `agentDocs.test.ts:588`, `gateway.md`, UI tests | 60 |
| Hide `setup --name/--release/--force-dns` from help | `commands/setup/command.ts` | 10 |
| With one zone under `--json`, default to `apps.<zone>` | `runSetup.ts` | 45 |
| Exact pins: `everyapp create` writes the exact version; re-pin Workout and Talk | `lib/app/publishedVersions.ts:23`, 2 app repos | 20 |
| `cli.md`: stop emitting the duplicated `--help` blocks | `packages/cli/src/docs/cliReference.ts`, then `docs:update` | 45 |
| `cli.md`: list the four global flags once | same | 30 |
| Unpad the agent docs' tables (−24% bytes); add `content/agent/` to `.prettierignore` | `landing-page`, `docs:update` | 45 |
| Drop `llms-full.txt` | `routes/llms-full[.]txt.ts`, `lib/llms.ts` | 15 |

---

## Machinery

| # | Change | Lines out | Effort |
|---|---|---|---|
| M1 | Delete drizzle snapshots 0000–0023 (keep `_journal.json` and the newest). drizzle-kit diffs only against the latest, and nothing reads the old ones. | ~73.6k | S |
| M2 | ⟲ Delete dev tooling that never runs, or whose job is done: the onboarding loop and `teardown` (11k test lines on every PR), `EVERYAPP_EVENT_LOG`, the `claude -p` harnesses (CLI 5.9k, toolbus 2.9k), the provisioner live tests, the pinned deploy snapshots | ~50k | M |
| M3 | ⟲ Self-host only, one team per Gateway: delete `GATEWAY_DEPLOYMENT_MODE`, personal orgs, open sign-up, hosted email verification, shared apps, the hosted app runner, host sessions, third-party domains, the hosted deploy API and its 43 error codes, the never-written `suspended` status, the organization switcher, `hosted-vision.md`'s contract, ADR-0001 and `hosted-install.md`. git keeps it. | ~7.5k + ~1.5k docs | L |
| M4 | D1: 47 tables → ~24 in one fresh baseline. These deletions plus 8 merges: dead `user_onboarding`, `owner_bootstrap`, invite link tokens into `invitations`, `mcp_connection_apps` into one column, one encrypted `providers` table, and others. | ~1.2k | L |
| M5 | Four packages: the public SDK; one private core (`sdk/internal`, ToolBus core and the perimeter's request path, which `everyapp dev` also runs); the CLI with the deploy engine; the Gateway with its admin tool definitions next to their handlers | ~1k (25k move) | L |
| M6 | An app request costs one D1 read, not 2–3 plus an Access check (after I1 and I4). Optionally, a 60 s session cookie cache makes it zero, at the cost of Remove taking up to 60 s to reach app hosts. | ~0.3k | M |
| M7 | Runtime: one hourly cron, no activation queue or launcher probes, no unread `CF_VERSION_METADATA` binding (S). Drop Better Auth's organization and admin plugins, installed then fenced off with 27 disabled endpoints (L; needs `security-review`). | ~2k | S + L |
| M8 | Cold start: the Gateway's 1.79 MB main chunk loads on every app request. Lazy-load the provider catalog (~125 KB), the events catalogue and the remote MCP client; find why zod bundles 167 KB of locales. | ~0 | M |
| M9 | Generate `cli.md`, `build.md` and `patterns.md` in the site build instead of committing them | ~4.9k | L |

## In-flight PRs

| PR | Recommendation | Why |
|---|---|---|
| **P1.** #912 Birds feature branch (+30.8k) | **Don't merge as one.** After oauth-simplify, land a keeper PR: #917 (helpers into `sdk/testing`), #918, #919, #922 (the switcher, no nonce), #925/#928/#930 (the drop guard, slimmed), #926, #931, #936. | 14k of it is generated snapshots; ~3.6k is OAuth that oauth-simplify deletes. The keepers conflict in 9–11 files each (L effort). This replaces the rc.11 plan ("merge #912, then publish"): rc.11, Talk and Workout wait for the keeper PR. |
| ↳ #902 #916 #921 #923 #924 #934 | Drop | oauth-simplify deletes scope sets, optional scopes, dev overlays, write-set routes and the keep-alive. |
| ↳ #907 agent attribution and caps | Drop | It routes agent calls to organization connections, which oauth-simplify deletes. |
| ↳ #904–#906 agents with their own identity | Keep off main until Birds runs on a Gateway (open question 6) | 6.8k hand-written lines, 5 tables, ~17 codes, every decision "Agent-assumed". If they land later, slim them so an agent is an AI connection the app holds: no tool globs, no team or sponsor kinds, one call path. The server `callTool` also clashes with `sdk/testing`'s. |
| ↳ #914 optional AI routes, #915 `listGroups` | Drop | Replaced by B2 and I4. |
| #938 MCP apps OAuth (+13.6k) | Rebase on oauth-simplify; drop the `mcp` scope set and the organization account (I13) | Your go today; phase 2 is a net cut. Dropping the organization account reverses Decision 1 (Q7). |
| #909 WebSocket re-check | Close; keep the 15-minute cap | #909 itself reverses your earlier call, and its timer path is unproven live. Simpler later: pass sockets straight through and drop the cap (~360 lines). |
| #830 release build/publish split | Land on your go; it fixes a HIGH | Net −473 lines. Trade-off: `release --publish` goes, and the starter's release.yml grows from 26 to 80 lines until B3's shared workflow. |
| #896 | Close (duplicate of #830) | |
| #435 overnight notes | Close; **keep the branch** (8 citations on main) | |

---

## Minimal concept list

Twelve concepts and about fifteen verbs. Everything else folds in or goes.

| Concept | One line | Folds in |
|---|---|---|
| Cloudflare account | Where everything runs; you pay Cloudflare | |
| Gateway | Your team's private home at `apps.yourco.com`; **Admin** is its settings page | workspace, organization, installation, operator |
| App | Something you install or build, with its own address, database and settings | helper Worker, MCP app |
| People | Admins and members; each app is open to everyone or to admins only | user, owner, group, access grants, "available to everyone" |
| Sign-in | A password, or Cloudflare Access if you turn it on (an email code, Google or your company login) | sign-in providers, outer ring, Access OIDC, auto-join |
| Providers | Outside services the Gateway holds the key for (AI, DataForSEO, Google…), listed under `providers` | capability, integration, model provider, catalog, AI default |
| Connected accounts | Your own Google or GitHub account that one app uses for you | connection, scope set |
| Settings | Values an app needs; it shows **Needs setup** until they're set | secret, setting, Gateway setting, key |
| Agents | Claude, ChatGPT, Codex or Cursor using your apps through one address (`/mcp`) | AI client, AI app, AI connection, connector, personal token |
| Tools | What an app lets agents do; each one reads or writes | toolbus, risk levels, destructive |
| Public routes | The parts of an app anyone can reach without signing in | public assets, bearer routes |
| Activity | What happened, and what it cost | audit log, agent activity, usage, events |

Verbs: `setup`, `update`, `install`, `create`, `dev`, `deploy`, `release`, `db`, `configure`, `status`, `delete`, `access`, `login`, `call`, `recover`.

## Keep (looks deletable, shouldn't be)

| Keep | Why |
|---|---|
| One `/mcp` per Gateway, `<app>_<tool>` names, the 5 built-ins, automatic compact listing | The product's main promise; claude.ai drops tools past 256 |
| The `call_read`/`call_write` split | Clients key confirm prompts on it; directory rules require it |
| The Gateway's MCP OAuth server | How every client connects |
| Native sign-in | Talk's Mac app and Birds' devbox use it |
| Activity and the audit log | The only record of what agents and admins did; this audit relied on it |
| Usage per app | The only per-app cost view (OpenRouter $5.97 in October) |
| `release` and `install <url>` | The four apps install this way in ~75 s each |
| Restore points and `db restore` | One-command undo for a bad migration |
| The D1 cascading-drop refusal, slimmed | Prevents the silent data loss Workout hit |
| The `--json` protocol, `action_required`, rerun | Five agent harnesses drove setup with it |
| `update` refusing to install a Gateway | It fixed a real surprise found in the launch gate |
| Invitations with a copyable link | Work with no email set up |
| Named Gateways | The demo runs beside everyapp.team |
| PR Checks (~110 s) and the integration workflow | Already lean; they caught real breaks |
| Better Auth's core, `workers-oauth-provider`, `organizationId` in the identity token | Replacing them is XL for no user gain |

## How it grew

The OAuth chain, repeated. Each arrow is a PR that made sense alone.

- **Access:** in front of everything → two Access apps → bypass sync on every deploy, written twice (CLI and Gateway) → `bearerRoutes` for native apps → the deploy probe blocked, so a cron → the cron slow, so a queue, launcher probes and polling → Managed OAuth for AI clients → linking password accounts → a passwords-off switch → member emails copied into the policy → "rerun `access on` after inviting" → auto-join lets deleted people back in, so Delete becomes Deactivate.
- **Who can open an app:** manifest default → per-person grants → "available to everyone", written as a row per member → groups (a UNION everywhere) → "via group" boxes → access counts and events → OAuth's "may open the app" check → #909 re-checking every WebSocket each minute. Live: every app open to every member, 0 groups.
- **Events:** audit log → webhooks → email sink → built-in Cap alerts → the Gateway pushing to apps → apps' own `emit` → a `setup_state` column to emit `app.ready` → a per-minute retry cron. Live: 0 subscriptions.
- **Caps:** call cap → $ cap → default cap → per-app override → `unlimited` → Paused → alerts → agent caps (#912). Live: 0 caps on everyapp.team.
- **AI:** per-provider routes → an inference allowlist → operator plus manifest extra routes → a model allowlist → a default provider → a stored choice → per-provider model memory → AI Gateway in front. Live: no choice, no models, AI Gateway off.
- **Credentials:** token scopes → deploy keys → single-app tokens → read/write MCP scopes → chosen-apps connections → native and dev grant kinds → #912's agents with their own grants, consent, sponsors and token prefix. Live: 0 tokens; one connection, all apps, write.
- **Remote MCP:** a provider pack → servers by URL without OAuth → a credential family pinned to an origin → caps on remote apps → #938's unmetered mode, OAuth discovery, client registration and organization accounts.
- **Docs:** a drift test per page → every flag, code, tool, setting and tab needs prose → `errors.md` at 390 entries and `cli.md` at 4.6k lines → 325k words of agent pages behind `llms.txt`, and agents hitting truncation reading `setup.md`.
- **Process:** "Fix now" verdicts from an agent-written analysis → a feature per verdict, every choice "Agent-assumed, pending Ben's review" → review-fix PRs stacked on top → 56 new TODO boxes from one PR.

---

## Appendix

### Method
- **Areas:** 14, read on `main` at `500fba5cd`: Gateway UI, Gateway server, identity and Access, MCP and agents, CLI, SDK and manifest, building an app, docs and value proposition, setup, app usage, decisions and threat model, in-flight PRs, vocabulary, and dev machinery.
- **App repos,** read at `origin/main`: CRM, OpenSEO, Analytics, Mission Control, OpenMail, RepoLens, Workout, Birds and Talk.
- **Live state** on everyapp.team and the demo, through read-only MCP tools only.
- **Checking:** a second agent tried to refute each area's findings (every "unused" claim, line count and hidden dependency), and its corrections are applied. A critic found gaps, and three more audits covered them: product scope and journeys, the app fleet and release contract, and platform architecture. Four reviewers then checked this doc.
- **Counts:** lines include tests unless a cell says otherwise. "~" means rounded.
- **Lanes already running,** not repeated here:
  - oauth-simplify ([2026-11-oauth-simplify.md](2026-11-oauth-simplify.md));
  - L5 `simplify-deletions`: webhooks, caps, groups, hosted mode, browser installs, unused resource kinds, dead SDK modules, the onboarding loop, harnesses and history docs, as code-level cuts.

### Notes for the other lanes
**oauth-simplify:**
- OpenSEO's `main` calls `connectUrl({ account: "organization" })`, and everyapp.team's organization Google connection was last used 10-29. "No app uses organization connections" is false, so OpenSEO moves to per-person connections first.
- Knowledge Base runs its own Google, GitHub and Discord OAuth with app secrets, outside the Gateway: a third OAuth path.
- While in `commands/provider`, delete the hidden `provider on|off` alias (`command.ts:384–400`, `hideRoute` at :429).
- While in the manifest schema, delete `main` and `devPort` (`manifest.ts:1074,1180`).
- `provider-migration.test.ts` guards a refactor that merged in #626, so delete it rather than port it.

**L5:**
- Workout and the starter call `emit()`.
- Knowledge Base calls Granola live (392 calls in November), so don't delete `catalog/comms.ts` wholesale.
- The pinned snapshots run in the integration job.
- `toolbus/claude-code` (2.9k) is a harness the survey missed; deleting it also means removing TESTING.md's section.
- Your two surveys disagree on MCP apps.
- In `patterns.md`, delete the 9 rows for kinds no app declares and the Turso row, but keep Artifacts: Birds uses it.

### Housekeeping quick wins
Agents can do these without a decision.

| What | Where | Min |
|---|---|---|
| Delete drizzle snapshots 0000–0023 (M1) | `apps/every-app-gateway/drizzle/meta` | 20 |
| Drop the `everyapp:contract` rule; keep `SHIPPED_MIGRATIONS` until M4's baseline | `src/db/release-migrations.test.ts` | 10 |
| Delete `toolbus/claude-code`, its vitest config, its script and its TESTING.md section (keep conformance) | `packages/toolbus`, `docs/TESTING.md` | 20 |
| Delete the `user_onboarding` code (repository, service, server function, collection, `cache-utils.ts` line); the table goes in M4 | Gateway | 30 |
| Delete the unread `CF_VERSION_METADATA` binding | `cloudflare.config.ts:232`, `patchBuildOutput.ts:106` | 15 |
| Delete `minSdk` (written, never read) | `build-release.ts`, `lib/app/release.ts` | 20 |
| Fix RELEASE.md's "Publishing is paused" opening and its "turning publishing back on" section | `.github/RELEASE.md` | 15 |
| Resolve `app-releases.md` saying vendoring is retired (line 39) and documenting `--vendor` (line 99) | `docs/runbooks/app-releases.md` | 10 |
| Fix `json.md`'s claim that `dev` has no `--json` | `agent/json.md` | 15 |
| Move `pnpm audit` from PR checks to nightly | `.github/workflows` | 10 |
| TODO.md rule: a default to confirm is one line under Questions; no "defaults taken" narratives | `TODO.md` header, AGENTS.md | 10 |
| Close #896 and #909; close #435 but keep its branch | GitHub | 5 |
| Your step: archive `private-postiz-everyapp`; delete the 59 legacy GitHub releases (v0.1.14 from July is still marked Latest) | GitHub | 15 |

### The six skill rules (B1)
1. The Gateway signs people in. Read the user only as `context.user` (pages, server functions) or `user` (tools). No login, session or cookie of your own.
2. Every route is private. Give each row `userId` (private) or `orgId` (shared) and filter every query by it.
3. Schema in `src/db/schema.ts`, then `pnpm db:generate`, then commit the migration.
4. Page → server function → query in `src/server`. Tools in `src/tools.ts` call the same queries.
5. A value: list it under `settings` (yours) or `providers` (the Gateway's). Locally `.dev.vars`; deploy asks for it.
6. `pnpm dev` to try, `pnpm test`, `pnpm run deploy` to ship. Anything else: everyapp.com/llms.txt. Look rows up in `patterns.md` when you need one.

### More measurements

| Measure | Today | After |
|---|---|---|
| Tracked text lines | ~564k (78k generated snapshots) | ~325k |
| Test lines per source line | 0.85 | about the same |
| MCP tools an owner sees on everyapp.team | 244 (59 host tools + 3 built-ins + 182 app) of a 256 cap | ~185 |
| Admin routes, dialogs | 23, 28 | ~12, ~12 |
| Ways to sign in | 9 | password, plus the Access add-on |
| Credential kinds | ~14 | ~7 |
| Identity settings | 25 | 2 |
| Gateway-own settings | 26 (113 settable names) | ~13 |
| SDK public exports | 701 (apps import 69) | ~31 app-facing values |
| Ways to call a model | 7 | 1–2 |
| Files from `everyapp create` | 93 (54 skill copies) | ~28 |
| Steps from zero to a deployed app | 6–7 commands + 5 handoffs | 3 commands: install, create, deploy (deploy offers a Gateway) |
| Operator's first setup: steps, CLI commands, concepts | 23, 8, 15 | 11, 2, 5 |
| Invite through to the teammate opening an app (Access on) | 14 steps, a terminal rerun | 7 steps |
| Setup prompt | 521 words; 3 questions always asked | ~60 words; none |
| Cloudflare resources setup makes | 11 (6 for Access, 1 queue) | 4 (Worker, D1, KV, domain) plus Email Sending DNS; ~8 with the Access add-on |
| Keys pasted after installing the four apps | OpenRouter, DataForSEO, MAIN_SECRET, EMAIL_FROM/NAME, email onboarding | DataForSEO and one AI key, in the browser; OpenMail's inbound still needs `email set --inbound` |
| Security docs | 3,931 lines, 425 register rows | ~200 lines |
| TODO.md | 2,378 lines, 1,351 open boxes | ~200 lines |
| Event types | 63 | ~25 |
| D1 tables | 47 | ~24 |
| App pins in use | 6 (rc.1 to `^rc.10`, a tarball, a `link:`) | 1 |
| App PRs caused by platform changes (15 days) | ~68 | one per app per rc |
