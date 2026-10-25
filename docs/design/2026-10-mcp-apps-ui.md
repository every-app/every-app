# MCP apps: how the Gateway shows an app that has no page

Date: 2026-10-24 (evening). Status: built; see section 9. Superseded in part on 2026-10-25 by [2026-10-mcp-by-url.md](2026-10-mcp-by-url.md): remote MCP servers are MCP apps too (`everyapp mcp add <url>`, Add app → Add an MCP server), "Turn off" in section 4 now stops serving and keeps everything (status `disabled`, shown "Off"), and the tombstone is a separate "Remove" (`everyapp mcp remove`). Follows [2026-10-mcp-provider-apps.md](2026-10-mcp-provider-apps.md) (the tier itself, PRs #485 and #489) and answers Ben's briefing of 2026-10-24.

## 1. The ask

Ben, over the briefing (trimmed): "We need to frame these provider apps differently. Maybe we just call them MCP apps or something, where there's no UI but you can use them through the MCP. They should be filtered differently, because when you click into them nothing happens. It should just pop up a modal: tell your agent to use the app, you can create skills around it, it's available via the MCP. And why are we offering curated skills? The whole benefit is you can just use their MCP. Look at Executor for how they did this: we're just an MCP gateway for this MCP. Maybe even follow the Executor pattern of dynamic MCPs with dynamic worker loaders, but that's forward-looking, too much for this weekend. Those should be different from a UI app. Maybe a toggle: Apps and MCP apps. Or a different section."

Three things to decide: what the kind is called, where it lives on the launcher and what a click does, and whether we keep curating DataForSEO's tools or pass its own MCP through.

## 2. The name: MCP apps

| Candidate | For | Against |
| --- | --- | --- |
| **MCP apps** | Ben's phrase. Says how it is reached (the workspace's MCP connection) and that it is still an app: the same row, the same access rules, groups, usage counters, audit trail and Admin → Apps. The launch audience already connects Claude, ChatGPT and Claude Code to an address that ends in `/mcp`. Executor shows the same split: "Apps: a page for people, beside the tools for agents." | "MCP" is an acronym. It is the one the docs, the consent page and every client's settings already use, so it is the acronym the person has met. |
| Tools | Short. | Every app has tools: the four launch apps list 187 of them on the same `/mcp`. A section called "Tools" beside apps that also have tools misleads. |
| Connectors | claude.ai's word for an MCP server you plug in. | Collides twice: in claude.ai's sense the connector is this Gateway, not DataForSEO; and the Gateway's own "AI connections" page already means the clients connected to it (the other direction). |

**Decision: MCP apps**, in every person-facing string: the launcher section, the card chip, Admin → Apps, the CLI help, the user docs and the agent docs. The internal names stay as they are, since the code is correct and a rename there buys nothing this week: tier value `provider`, `PROVIDER_APPS`, `PROVIDER_APP_TIER`, `providerAppManifest`, the error codes `PROVIDER_APP_UNKNOWN` and `PROVIDER_KEY_UNSET`, the directory `commands/provider/`. The agent docs say once that "MCP app" is the person's name for tier `provider`. The CLI group is `everyapp mcp on|off|list` (section 5), `provider` kept as an alias through launch week. A documented default, not a hold.

## 3. Three UIs

The launcher today lists DataForSEO in the grid between the real apps with an "AI tools" chip, and a click does nothing: no link, no dialog (TODO "UI states", pass 2, and the design review's "inert provider card"). Every option below gives the click a dialog (section 3.4); they differ in where the card sits.

### 3.1 A: a segmented toggle, Apps | MCP apps

```
All apps 5                                              [⚙ Manage apps]
[🔍 Search your apps…                       ⌘K]   [Apps | MCP apps]  [▦|☰]

┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│ [A] Agentic Inbox ↗│ │ [O] OpenCRM      ↗│ │ [O] OpenSEO      ↗│
│ Mail your agents… │ │ Pipeline…         │ │ Keyword…          │
└───────────────────┘ └───────────────────┘ └───────────────────┘

                      …  "MCP apps" chosen  …

[🔍 Search your apps…                       ⌘K]   [Apps | MCP apps]  [▦|☰]
Your agent uses these through this Gateway's MCP address. Nothing to open.
┌───────────────────┐
│ [D] DataForSEO MCP│
│ SEO data for…     │
└───────────────────┘
```

For: the cleanest separation; each mode explains itself. Against: a mode hides a kind. With one MCP app at launch the second tab is a near-empty page, the heading's count ("All apps 5") and the sidebar's count disagree with what is on screen, the toolbar already carries a mode (grid or list) and a second one on a 390-wide phone has no room, and search would have to choose between "this tab" and "both tabs". The Pinned tab was just removed for the same reason (#571: one order, no modes).

### 3.2 B: a section below the grid

```
All apps 5                                              [⚙ Manage apps]
[🔍 Search your apps…                       ⌘K]                    [▦|☰]

┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│ [A] Agentic Inbox ↗│ │ [O] OpenCRM      ↗│ │ [O] OpenSEO      ↗│
│ Mail your agents… │ │ Pipeline…         │ │ Keyword…          │
└───────────────────┘ └───────────────────┘ └───────────────────┘
┌───────────────────┐
│ [R] Research Desk │ Needs setup
└───────────────────┘

MCP apps
Your agent uses these through this Gateway's MCP address. Nothing to open.
┌───────────────────┐
│ [D] DataForSEO MCP│
│ SEO data for…     │
└───────────────────┘
```

For: one page, one scroll, no mode; the heading explains the kind once, so the card needs only a short chip; the counts stay honest (an MCP app is still one of the person's apps); a search narrows both sections and an empty section disappears; more MCP apps (Treg, Monid) fill the section; none at all and the section is gone. Against: on a phone the section is below the fold when the person has many apps; a pinned MCP app still sorts first inside its own section only.

### 3.3 C: one grid, a distinct card

```
┌───────────────────┐ ┌───────────────────┐ ┌─────────────────────────┐
│ [A] Agentic Inbox ↗│ │ [O] OpenSEO      ↗│ │ [D] DataForSEO           │
│ Mail your agents… │ │ Keyword…          │ │ ⟡ Via your agent          │
└───────────────────┘ └───────────────────┘ │ SEO data for…            │
                                            └─────────────────────────┘
```

For: nothing moves; the fewest new elements. Against: the grid mixes two behaviours (a link and a dialog) with only a chip to tell them apart, so the chip has to carry the whole explanation ("Via your agent"), which truncates beside a long name at 390 and has nowhere to go in the list layout, where the status column is already shared with the pin; and the design review's rule for cards is one open cue everywhere.

### 3.4 The dialog (all three options)

```
┌─────────────────────────────────────────────────────────┐
│ Use DataForSEO from your agent                           │
│ DataForSEO has no page. Claude, ChatGPT and Claude Code │
│ reach it through this Gateway's MCP address:            │
│ ┌───────────────────────────────────────────────┐ [⧉]   │
│ │ https://everyapp.team/mcp                     │       │
│ └───────────────────────────────────────────────┘       │
│ Its tools start with dataforseo_. Try saying:           │
│ "Use DataForSEO to find keyword ideas for a page        │
│  about running shoes."                                  │
│ Agents can build skills on its tools, like any app's.  │
│ Connect Claude or ChatGPT, in the docs ↗                │
│ MCP apps, in the agent docs ↗                           │
│                                               [Close]  │
└─────────────────────────────────────────────────────────┘
```

The address is this Gateway's own origin plus `/mcp` (the UI is served from the Gateway, so it is `window.location.origin`), with the copy button every command and token already has. The example sentence is the provider's, from the registry (`PROVIDER_APPS[id].example`), so a second provider gets its own. The two links follow the first screen's "…, in the docs" pattern: the person's page ([/docs/connect-ai](https://everyapp.com/docs/connect-ai)) and [/docs/agent/mcp#mcp-apps](https://everyapp.com/docs/agent/mcp#mcp-apps), for the agent that was told to use it. One noun for the caller throughout the feature: "your agent" (Ben's word), with Claude, ChatGPT and Claude Code named once; and "this Gateway's MCP address", not "this workspace's", since `/mcp` is one address across organizations.

### 3.5 Recommendation: B, with C's chip

Build the section (B) and give its cards a short "MCP" chip where the open arrow would be (C's idea, reduced to what the section heading leaves unsaid), in the badge's soft tint rather than a status chip's outline, so a kind never reads as a state. A click on the card, on the chip in Admin → Apps, or on a pinned MCP app in the sidebar opens the dialog. The "AI tools" status goes: a ready MCP app is Active like any other (plain text in Admin → Apps, no chip on the card), its kind is a chip beside the name, and Needs setup and Disabled keep their meaning and their colours. This resolves the provider-app half of the design review's "one status vocabulary" item (TODO "UI review (2026-10-25)"); the Deploying and Needs deploy colours stay that thread's.

## 4. Admin → Apps

The row's developer string (`dataforseo · tools on /mcp as dataforseo_<tool>`) becomes plain words that say what the dialog says, short enough for the name cell: `dataforseo · agents call dataforseo_<tool>`. The kind chip "MCP" sits beside the name and opens the same dialog, as the "Needs setup" chip opens the setup dialog. The Status column reads Active. The rest of the row's strings (Deployed by, the mail and integrations lines, "Everyone") are the design review's item 22c, owned by the UI review thread; this note touches only the MCP-app parts.

The row menu's "Delete app" on an MCP app reads "Turn off" (a power icon, still in the destructive group: it is the same tombstone), and its dialog says what `everyapp mcp off` does: the tools leave the Gateway's MCP address, the people lose access, tokens for it stop working; `everyapp mcp on <id>` turns it on again, for owners and admins first (TODO "UI states", pass 2: "Delete app on a provider app").

## 5. The CLI: `everyapp mcp`

`everyapp mcp on <id>`, `everyapp mcp off <id>`, `everyapp mcp list` (alias `ls`), with `everyapp provider …` kept as an alias of the whole group through launch week (`commandPaths()` lists both, so a document that still says `provider on` passes the setup-skills check). The group's help says "MCP apps" and what one is in one sentence; `--json` shapes, the `provider.update` step name and the error codes are unchanged. The verb `mcp` leaves room for the forward-looking command in section 8 (`everyapp mcp add <url>`).

## 6. Curated tools, or the provider's own MCP

Ben: "why are we offering curated skills? The whole benefit is you can just use their MCP." First the word: no skills are curated. DataForSEO is seventeen *tools* over its REST Live endpoints; the one file under `setup/` (`setup/dataforseo.md`) is the operator's setup skill for the key, not a usage skill. Skills around its tools are the member's agent's to write, which is what the dialog says.

### 6.1 What DataForSEO's own MCP is

Verified 2026-10-24 against the README of `dataforseo/mcp-server-typescript` (3.1.3, Apache-2.0) and the research doc's section on it:

- A hosted remote MCP exists: `https://mcp.dataforseo.com/v3/mcp` (Streamable HTTP, 2025-era, stateless). Auth, in this order: an `Authorization: Basic` header (the API login and password), an `Authorization: Bearer` OAuth token (the default the README leads with; the server publishes protected-resource metadata), then the server's own environment credentials. So the Gateway's key would work as a Basic header on every forwarded call (`requestInit.headers`, since the MCP client SDK's `authProvider` only writes Bearer).
- The v3 server exposes four tools: `docs_index`, `docs_list_sections`, `docs_search`, and `api_request`, a catch-all that takes `method` and any `/v3` path and sends it with `.ai` appended by default (`noAiMode: true` to turn that off). Its annotations say `readOnlyHint: false`. The sandbox is unreachable from it (host pinned to `api.dataforseo.com`).
- The older paths `/mcp` and `/http` are, by the research doc's inference from their metadata payloads (not confirmed by a `tools/list`), the deprecated v2 server: about 90 module tools, write and paid-heavy families included (OnPage Lighthouse, AI Optimization at $0.10 a call, Merchant, Business Data).

### 6.2 The trade-off

| | Curated set (today) | Pass the v3 MCP through | Pass the v2 MCP through |
| --- | --- | --- | --- |
| What the member's client sees | 17 named read tools (`dataforseo_keyword_overview`, …), each with a title, `readOnlyHint` and a price in its description | `dataforseo_api_request` plus three docs tools; the model must read DataForSEO's docs to compose a path and body on every call | ~90 tools, names like `dataforseo_dataforseo_labs_google_keyword_ideas` |
| Tool count on the compact surface (#567), from the 187 a read & write member of the four launch apps sees (TODO "MCP apps") | 204; under the 256 at which the listing goes compact | 191 | ~277: every such member's listing goes compact automatically, and claude.ai would drop tools past 256 |
| Per-tool policy, argument check, audit column (the code-mode thread's ruling against catch-all wrappers) | Hold | Lost: one write-risk tool that can reach any endpoint, paid or not; path scoping would have to be rebuilt by inspecting `arguments.path` | Hold per tool, but the allowlist is ours to keep in step with a deprecated server |
| Cost control (Admin → Usage caps read `cost` off each answer) | Works | `.ai` mode drops `cost` and `data.tag`; the Gateway would force `noAiMode` (bigger answers) or reconcile from `id_list` later | As curated, if every module returns `cost` |
| The Gateway's own key | Basic on the REST call through the capability proxy, hosts allowlisted | Basic header on the MCP call; works | Same |
| ChatGPT | Read tools run without confirmation | A tool without `readOnlyHint` asks for confirmation on every call | Mixed |
| The live check with Ben's key | The free sandbox (`DATAFORSEO_SANDBOX`) | No sandbox: every test call is billed | Same |
| Keeping up with DataForSEO | 17 handlers to maintain | Nothing to maintain | A deprecated server |

### 6.3 Recommendation

Keep the curated set for DataForSEO. Passing its MCP through is feasible to wire this weekend (Basic auth, one URL) and not acceptable to ship: for the one provider we have, "their MCP" is a single catch-all tool that sidesteps the per-tool policy and audit the gateway is built on, hides the cost the caps read, and cannot be tested against the sandbox. The member gets a worse surface (compose a REST path from the docs) for less control.

Ben's broader point stands for providers whose MCP is a real tool list: Treg (10 tools, bearer key, usage by tag) and Monid once its MCP takes a key. That is the remote-MCP proxy kind the TODO plans as PR 3, and it is not built this weekend for three reasons: its first upstream has no account or key yet (Ben's call of 2026-10-24: "not now"), so it would merge untested against anything live in launch week; it changes two security boundaries (B4, B5: a new outbound MCP client with the operator's credential, catalog normalization, annotation-to-risk mapping) whose invariants the threat model register would have to take, a reviewed change; and the UI reframe is what Ben asked for this weekend. What this note adds to PR 3's plan: the DataForSEO facts above (Basic in `requestInit.headers`, `noAiMode`, no sandbox), so that if DataForSEO is ever proxied it is the v2 module list behind an allowlist, never the v3 catch-all.

## 7. Executor, in five lines

1. Executor (executor.sh; UsefulSoftwareCo/executor, MIT, Y Combinator, founder Rhys Sullivan; not E2B) is "the missing integration layer for AI agents": paste an OpenAPI, GraphQL or MCP URL and it indexes the tools and holds the credential. "Everything you use, connected in one place. Then build whatever you need on top."
2. One MCP endpoint for everything (`/mcp`, hosted, self-hosted or local) that exposes six tools whatever is connected: `skills`, `search`, `describe`, `call`, `execute`, `resume`; tools are addressed as `tools.<app>.<tool>` and found by search, so "the tool list stays the same size".
3. `execute` is code mode: a short JavaScript program in a sandboxed interpreter (no fetch, filesystem, timers or imports; 100 tool calls, five minutes, 100 KB output), the runtimes QuickJS, a Deno subprocess or a dynamic worker.
4. For people there is a page per app ("Apps: a page for people, beside the tools for agents"); the agent is told to write the tool when something is missing ("Ask your agent to write the tool"); automations are code on a schedule or a webhook, no flow builder; "Executor runs no AI".
5. Where we stand: the Gateway is the same shape at the gateway level (one `/mcp`, the operator's key never in the agent, `everyapp_search_tools` and `everyapp_call_*` since #567) with per-tool policy and audit that Executor's single `call` does not have; what we lack is the "paste a URL" dynamic registration, which is section 8.

## 8. Dynamic MCP via worker loaders (parked)

In TODO.md, "MCP apps (2026-10-24)". The sketch: `everyapp mcp add <url>` (and the Admin → Apps "Add" button) registers a remote MCP server as an `apps` row of tier `provider`, kind `remote_mcp`, with the operator's credential as a Gateway setting; the Gateway snapshots its `tools/list` into `app_tools` behind an allowlist, names them `<id>_<tool>`, maps annotations to risk and forwards each call with the credential, which is exactly PR 3's proxy kind made registrable at runtime rather than from `PROVIDER_APPS`. Worker loaders enter only for the upstreams that are not MCP: an OpenAPI or GraphQL description would need an adapter (the schema-to-tools code Executor generates), and model- or operator-written adapter code must not run in the Gateway's isolate; Cloudflare's `worker_loaders` binding (Dynamic Workers; open beta, Workers Paid) can load a per-app adapter Worker that holds no secret, has `globalOutbound` limited to the upstream's host and a service binding back to the ToolBus, the shape the code-mode design already describes for `everyapp_execute` (C1). Two steps, in order: PR 3 (remote MCP, static registry), then `mcp add <url>` (dynamic registry, remote MCP only), and only then adapters in Dynamic Workers. Not this weekend.

## 9. What landed

One PR against main: the launcher's "MCP apps" section and chip, the "Use it from your agent" dialog (card, Admin → Apps chip, pinned sidebar entry, `?mcp=<id>` on the launcher), Admin → Apps row copy, "Turn off" for an MCP app, `AppStatusLabel.AiTools` removed, the `example` field on the provider registry, the CLI group `everyapp mcp` with the `provider` alias, the docs (agent docs regenerated and renamed, user docs, the skill, `docs/capabilities.md`), TODO.md, and this note. Before the PR opened it was reviewed by a Workflow (four reviewers: UI correctness and accessibility, copy, CLI and docs truth, security and scope; three refuters per finding), and the findings that held went in on the branch. Screenshots are in the PR body and on the branch `ui-screenshots-2026-10-24` under `mcp-apps-2026-10-24/`.
