# Building the Every App gateway into an integration hub for agents: mechanisms, client behavior and building blocks (October 2026)

**Key:** `build-patterns` · **Date:** 2026-10-12 · **Repo basis:** `d1112c4d`
**Scope:** how to build "connect Gmail/Slack/GitHub/Linear once; agents use them through one MCP endpoint; internal apps reuse the same connections" inside the gateway. Vendor landscape (Composio, Executor, Nango…) is covered by sibling files in this folder; this file covers standards, client behavior, platform building blocks and a recommended architecture.

**How this was checked**
- I read the repo plan (`docs/research/2026-10-platform-review/impl/mcp-design.md` §0–§2, §8, §11), the prior reviews (`raw/ref-executor.md` §8, `raw/ref-cloudflare-os.md`) and the gateway code that already hoists the OpenAI key (`apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`, `ai-proxy.ts`, `packages/perimeter/src/manifest/manifest.ts`, `packages/cli/src/lib/generateWranglerConfig.ts`).
- I read package source from npm tarballs or shallow clones under `/tmp/everyapp-research-2/bp-*`: `better-auth@1.7.7`, `@cloudflare/workers-oauth-provider` (main at v1.2.3), `agents@0.28.0`, `@modelcontextprotocol/client@2.3.1`, the MCP Apps spec (`ext-apps` 2026-01-26), and Home Assistant's cloud account-linking code.
- Four research sub-agents fetched client, spec, provider-OAuth and vault/webhook material in parallel. I re-fetched the load-bearing claims myself.
- Nothing was deployed, registered, signed up for or posted. The vendor `.well-known` reads were unauthenticated public GETs.
- The session's shared web-search quota ran out partway through; later lookups used direct URLs, so some vendor pages may have been missed.

**Labels**
- **[live]** fetched 2026-10-12 (URL given). **[live ✓]** I re-fetched it myself. **[live, sa]** fetched today by a research sub-agent and not re-fetched by me.
- **[code]** read in source (package and version given). **[docs]** vendor docs. **[prior]** earlier Every App research (2026-10-04/05). **[inference]** my reasoning.

---

## 0. TL;DR

1. **Store third-party connections in their own gateway tables, not in Better Auth's `account` table.** In Better Auth 1.7.7 a linked account becomes a sign-in method, one provider account can belong to only one user, rows have no org scope, and refresh runs with no lock [code]. Use a `connections` table, envelope-encrypted tokens, and one Durable Object per connection as a single-flight refresh lock.
2. **Tokens stay in the gateway by default.** Agents get tool results through ToolBus. Apps get a proxied `fetch` through the existing props-authenticated `AppGateway` service binding, limited to each provider's API hosts. Cloudflare has no outbound hook for ordinary Workers, only for Workers for Platforms dispatch namespaces, Dynamic Workers and Sandboxes [live ✓].
3. **Serve tools in three modes, chosen per MCP grant.**
   - `flat`: real tools, for small scopes and for clients that defer tools themselves.
   - `search`: a fixed set of meta-tools with separate read and write invoke tools. This is the default once a grant sees more than about 25 tools; it is the M3-7 plan.
   - `code`: later, opt-in.
   - Evidence: almost every major client now defers and searches tools itself, but from names only; claude.ai drops server instructions; hard caps exist (Windsurf 100, VS Code 128 without tool search, Gemini 512) [live ✓ / sa].
4. **Connect a third-party account from inside an agent session with a gateway connect link, upgraded to URL-mode elicitation where the client supports it.**
   - URL elicitation works in Claude Code [live ✓], VS Code and Codex [code, sa]. claude.ai, Desktop and mobile document no elicitation; `anthropics/claude-ai-mcp#153` is still open, last comment 2026-10-07 [live ✓].
   - The spec requires the server to check that the user who opens the link is the user who started it, and it forbids token passthrough [live ✓].
5. **Per-install OAuth clients are workable because "internal" apps are both cheap and compliant.**
   - Google Internal apps skip verification and CASA. Slack internal apps skip review and the 2025 rate-limit cuts. Single-tenant Entra apps skip publisher verification [live ✓ / sa].
   - GitHub's App manifest flow and Slack and Linear manifests automate most of the setup [live ✓ / sa].
   - The one hard wall: consumer Gmail users who need restricted scopes.
6. **Some vendor MCP servers need no client registration at all.**
   - Linear, Notion, Sentry, Cloudflare, Stripe, Supabase, Airtable, ClickUp and PayPal advertise CIMD and/or DCR. Atlassian does too, once the customer's org admin allowlists the gateway's domain [live, sa].
   - Google Workspace MCP (Developer Preview), Microsoft Work IQ (needs Copilot licenses), Slack (internal or directory apps only), GitHub, HubSpot, Asana, Salesforce and Box all need a client the customer registers [live ✓ / sa].
   - MCP 2026-07-28 deprecates DCR, so each gateway should publish its own CIMD document [live ✓].
7. **Don't build a hosted OAuth broker first.** Home Assistant's broker relays tokens and handles refreshes for self-hosted instances, but it brokers no Google service [code, live ✓]. Every integration vendor says its managed apps are for development only [live, sa]. Offer a broker later, opt-in, for low-risk providers.
8. **Hosted vaults are a poor default for an MIT self-hosted product.** Each install needs its own vendor account, the vendor holds the tokens, and production still needs the customer's own OAuth apps. Auth0 Token Vault has no org-shared accounts; Composio never exports tokens [live, sa]. Keep a `CredentialSource` seam so an enterprise can plug one in.
9. **Treat upstream tools as untrusted.** Pin and diff upstream catalogs, quarantine new or changed tools, default unannotated tools to `write`, and cap description length. A hub that connects Gmail, GitHub and Slack for one agent is the "lethal trifecta" by construction, so read-only defaults and approvals for outbound writes matter more than catalog size [live ✓].
10. **Triggers: one ingest route, a Queue, and idempotent delivery to apps.**
    - Start with providers that use one app-level webhook URL: Slack, GitHub App, Linear, Notion, HubSpot, Stripe.
    - Add per-resource subscriptions that need renewal (Gmail every 7 days, Graph, Jira every 30 days) plus reconciliation polling later. GitHub, Notion and Asana can lose events [live, sa].
11. **Cloudflare pieces.**
    - Use: `workers-oauth-provider` 1.2.3, D1, SQLite Durable Objects, Queues, Workflows (cron `schedules`, renewals).
    - Interoperate with: MCP server portals.
    - Skip for v1: Access Managed OAuth, the Agents SDK, and Secrets Store as a token store.
    - Later: code mode on Dynamic Workers.

**Decisions**

| # | Decision | Why |
|---|---|---|
| C1 | `connections` + `connection_grants` + `provider_clients` tables. Rename the planned `mcp_connections` to `mcp_grants` before it ships. | Separates identity, AI-client grants and third-party accounts (§3.1, §9.4) |
| C2 | Envelope encryption: a KEK in a Worker secret (Secrets Store optional), per-org DEKs in D1, AES-GCM with AAD per field | D1 at-rest encryption doesn't stop D1 readers (§3.2) |
| C3 | `ConnectionLock` Durable Object per connection: in-memory single-flight plus a CAS row version | Rotating, single-use refresh tokens at GitHub, Slack, Linear, Atlassian, Notion, Stripe (§3.3, §4.1) |
| C4 | Provider packs as code: OAuth config, API hosts, scope→risk map, identity, revoke, webhook verification, tool source | Spec and provider churn stay in one place (§9.3) |
| C5 | Tool sources: vendor MCP via CIMD where it works; curated packs for Google, Microsoft and Slack; OpenAPI and code mode later | §5 |
| C6 | App egress proxy through `AppGateway` RPC, with host allowlists, read/write grants and the agent's scopes carried through | §6 |
| C7 | Connect-link fallback first, then MRTR URL elicitation, then MCP Apps cards | Client support (§2.6) |
| C8 | BYO clients with guided setup; broker deferred and never used for Google restricted scopes | §4.3–4.5 |

---

## 1. Tool count and context management

### 1.1 What platforms and clients do today

Almost every major client now defers tool definitions and searches them on demand, but **only from tool names and the server's name or description**. So names, the first sentence of each description, and the server description carry the load.

| Client / platform | Behavior with a big catalog | Source (date) |
|---|---|---|
| Anthropic Messages API | Server-side Tool Search Tool (`tool_search_tool_regex_20251119`, `tool_search_tool_bm25_20251119`), with `defer_loading` per tool. "Maximum deferred tools: 10,000"; 5 results per search by default; no beta header since 2026-02-17. Docs: selection "degrades once you exceed 30–50 available tools"; "Keep your 3–5 most frequently used tools non-deferred" | platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool [live, sa] |
| Anthropic MCP connector | Beta `mcp-client-2025-11-20`. `mcp_toolset` with `default_config`/`configs` (`enabled`, `defer_loading`). Programmatic tool calling cannot call MCP-connector tools | platform.claude.com/docs/en/agents-and-tools/mcp-connector [live, sa] |
| Claude Code | "Tool search is enabled by default: MCP tools are deferred and discovered on demand… Only tool names and server instructions load at session start."<br>`ENABLE_TOOL_SEARCH` = unset / `true` / `auto` / `auto:N` / `false`.<br>Per-tool `_meta["anthropic/alwaysLoad"]`; `_meta["anthropic/requiresUserInteraction"]` forces a prompt on every call.<br>Descriptions cut at 2,048 characters. Output warns at 10,000 tokens and is capped at 25,000 by default | code.claude.com/docs/en/mcp [live ✓] |
| claude.ai / Desktop / mobile | Per-connector "Tool access": Auto (default) / Always available / On demand. On demand for "10 or more" connectors; 30+ tools → On demand or Auto [live ✓, article 2026-03-16].<br>User reports: custom-connector tools are deferred to bare names `mcp__<uuid>__<tool>`, and server `instructions` are dropped (#1105, 2026-10-03; #93, reconfirmed 2026-10-09) | support.claude.com/en/articles/13730515; github.com/anthropics/claude-ai-mcp [live, sa] |
| OpenAI Responses API | `{"type":"tool_search"}`, with `defer_loading` on functions, namespace members or an `mcp` tool; the model first sees only the server's name and description. Hosted or client-executed search. "Only `gpt-5.4` and later." "Aim to keep each namespace to fewer than 10 functions." The Agents API defers MCP tools automatically | developers.openai.com/api/docs/guides/tools-tool-search [live ✓] |
| ChatGPT (developer mode / plugins) | No documented tool limit and no documented tool search for custom servers. Guidance prefers focused tools and requires `readOnlyHint`, `openWorldHint` and `destructiveHint` on every tool for submission. Company knowledge needs standard `search` + `fetch` tools | developers.openai.com/plugins [live, sa]; help article returned 403 |
| Codex | `tool_search` always on; MCP tools always deferred; 8 results per search | openai/codex source, 2026-10-10 [code, sa] |
| Cursor | Old cap: "only send the first 40 tools". Since 2026-01-06, "dynamic context discovery": names only in context, −46.9% agent tokens in an A/B test | cursor.com/blog/dynamic-context-discovery [live, sa] |
| VS Code Copilot | "Maximum of 128 tools enabled at a time" unless the model endpoint supports tool search; "virtual tools" grouping above 64 | code.visualstudio.com docs and source [live, sa] |
| Gemini CLI | No tool search; the Gemini API rejects more than 512 function declarations | geminicli.com; issue #19083 [live, sa] |
| Windsurf (Devin Desktop) | "Cascade has a limit of 100 total tools" | docs.devin.ai [live, sa; undated] |
| Cloudflare MCP server portals | `optimize_context=minimize_tools` ("up to 5x savings") and Code Mode (`portal_codemode_search`/`_execute`); policies Off / Opt-in / On by default / Enforced | developers.cloudflare.com portal docs; changelog 2026-03-26, 2026-07-30 [live ✓] |
| Cloudflare API MCP server | 2,594 endpoints behind `search`/`execute`: about 1,100 tokens vs 1,170,523 for full flat schemas; `?codemode=false` for clients that already do code mode | github.com/cloudflare/mcp README [live, sa]; blog 2026-02-20 |

### 1.2 Evidence on accuracy and cost

| Source | Finding |
|---|---|
| Anthropic, "Introducing advanced tool use" (2025-11-24) | Tool search on MCP evals: Opus 4 went from 49% to 74%, Opus 4.5 from 79.5% to 88.1%. Tokens fell from about 77K to about 8.7K ("85% reduction"). Programmatic tool calling: 43,588 → 27,297 tokens. Tool-use examples: 72% → 90% [live, sa] |
| Anthropic, "Code execution with MCP" (2025-11-04) | 150,000 → 2,000 tokens ("98.7%") by presenting servers as code APIs; warns that sandboxing adds "operational overhead" [live, sa] |
| Anthropic, programmatic tool calling docs | On a 75-tool benchmark, −38% billed input tokens "with no change in task accuracy"; on τ²-bench, about 8% more expensive [live, sa] |
| Anthropic, "Writing effective tools for agents" (2025-09-11) | "More tools don't always lead to better outcomes"; consolidate, namespace, offer concise vs detailed responses [live, sa] |
| RAG-MCP (arXiv 2505.03275) | Retrieving tools before selection: 43.13% vs 13.62% accuracy; failures dominate past about 100 tools [paper, sa] |
| LiveMCPBench (arXiv 2508.01780) | 527 tools behind route/execute meta-tools: "Retrieval errors account for nearly half of all failures" [paper, sa] |
| MCP-Atlas (Scale, 2026-04-08) | Tool-usage failures are 47.5–68.5% of failed tasks; "No tools called" averages 36% [live, sa] |
| Speakeasy (2025-11-13) | At 400 tools: 405,100 tokens static vs 2,500 progressive vs 1,300 semantic ("preliminary") [live, sa] |
| GitHub MCP server | Dynamic-toolset meta-tools removed 2026-05-20 as tech debt; they were "local-only… never offered by the remote server" (PR #2512) [live, sa] |
| Stainless (undated product page) | Generated servers are now code mode (`search_docs` + `execute`). Claims 94–97% accuracy and 3x fewer calls, with no methodology [live ✓] |

No public 2026 head-to-head comparison of flat tools vs meta-tools vs code mode on one benchmark was found [live, sa].

### 1.3 What the hub should expose by default [inference]

- **Flat tools work where the client defers.** That covers Claude Code, Codex, Cursor, VS Code with tool search, and the Anthropic and OpenAI APIs. Elsewhere they break hard caps and degrade selection past about 30–50 tools.
- **Flat tools keep each client's safety UX working.** Per-tool annotations drive ChatGPT's confirmations and claude.ai Team/Enterprise "Always allow / Needs approval / Blocked" settings, and Claude Code honors `requiresUserInteraction` per tool. Meta-tools collapse all of that into one or two entries.
- **Code mode has the best token numbers, but the numbers are vendor-measured.** It also needs Workers Paid plus Dynamic Workers, runs model-written code, and hides individual writes from client approvals. Cloudflare's own products say to turn it off when the client already does code mode.

**Recommendation: one engine, three modes, chosen per MCP grant.**

| Mode | What `tools/list` returns | When it's the default |
|---|---|---|
| `flat` | Real tools named `<app-or-provider>_<tool>`, with risk-derived annotations and `requiresUserInteraction` on approval-gated tools | The grant sees ≤ about 25 tools, or the user picked it for Claude Code / Codex / Cursor |
| `search` | A fixed set: `everyapp_search_tools`, `everyapp_call_read_tool` (`readOnlyHint:true`), `everyapp_call_write_tool`, `everyapp_integrations` (connected and connectable integrations, with connect links), `everyapp_whoami` | More than about 25 visible tools (M3-7, made the default for big catalogs) |
| `code` (later) | `everyapp_search_tools` + `everyapp_execute` on `@cloudflare/codemode`, with connectors that hold credentials outside the sandbox | Opt-in only |

- **Choosing the mode.** The user picks it on the consent screen, and the resource URL can override it (`/mcp?mode=flat`). `workers-oauth-provider` 1.2.3 maps "a resource indicator that names the protected resource's URL with extra query parameters" to the configured resource [code ✓: release notes 2026-10-07]. This is the same pattern as Cloudflare's `?codemode=` and GitHub's per-URL toolsets.
- **Naming, because clients often see only names.** Prefix every tool with its integration (`gmail_search_threads`) and front-load the first sentence of each description. Put the integration list in the description of `everyapp_search_tools` too, because claude.ai drops server `instructions`.
- **What `search` returns.** Stable opaque IDs plus full JSON input schemas for the top K results (Executor's passthrough pattern [prior]). Keep `tools/list` deterministic, with `ttlMs` and `cacheScope:"private"`, so prompt caches survive.
- **Result size.** Default tool results to a compact format with a `detail` switch, and cap them well below Claude Code's 25,000-token ceiling.

---

## 2. MCP spec features that matter for a hub

2026-07-28 is the current protocol version [live, sa: modelcontextprotocol.io/specification/versioning].

### 2.1 URL-mode elicitation for third-party OAuth

| | 2025-11-25 | 2026-07-28 |
|---|---|---|
| Carrier | Server sends `elicitation/create` with `mode:"url"`, `url`, `message`, `elicitationId`; or the error `URLElicitationRequiredError` `-32042` [live, sa] | Inside `InputRequiredResult.inputRequests` (MRTR); the client retries the original call with `inputResponses` and the echoed `requestState` [live ✓] |
| Completion | `notifications/elicitation/complete {elicitationId}` | Removed: "the client learns the outcome of an out-of-band interaction by retrying the original request… Servers needing to correlate an elicitation across retries encode their own identifier in `requestState`" (changelog minor item 11) [live ✓] |
| `-32042` | Defined | Implementations "MUST NOT emit" it ("2025-11-25 only") [live, sa] |

**Rules that bind a hub** (unchanged in 2026-07-28) [live ✓: …/2026-07-28/client/elicitation]:
- "MCP servers **MUST NOT** rely on URL mode elicitation to authorize users for themselves."
- "The third-party credentials MUST NOT transit through the MCP client"; "The MCP server MUST NOT use the client's credentials for the third-party service: That would be token passthrough"; "the MCP server must be stateful" (it stores the tokens).
- "Servers **MUST** bind elicitation requests to the client and user identity"; identity "**MUST** be derived from credentials acquired via MCP authorization when possible (e.g. `sub` claim)".
- URLs "**MUST NOT** include sensitive information about the end-user" and "**MUST NOT**" be pre-authenticated.
- Phishing: "The MCP Server **MUST** verify the identity of the user who opens the URL before accepting information". The suggested pattern is to elicit your own `https://mcp.example.com/connect?...` page, check that the session user equals the MCP user, and only then redirect to the third party. The check must be "resilient to attacks where an attacker can modify the elicitation URL".
- Clients "**MUST NOT** automatically pre-fetch the URL", "**MUST** show the full URL", and must open it where the client or LLM can't inspect it (SFSafariViewController yes, WKWebView no).
- MRTR `requestState` is attacker-controlled input. Protect it with HMAC or AEAD and embed the principal, a short TTL and a digest of the original request [code, sa: mrtr.mdx].

**Interop traps**
- VS Code 1.141.0 handles `-32042` by opening the URL and then waiting for `notifications/elicitation/complete`, which a stateless JSON-mode gateway can't push. So on the 2025 path, return a tool result with the connect link instead of `-32042` [code, sa + inference].
- Claude Code 2.1.288 waits for "I'm done, continue" when the server can't report completion [live, sa: changelog]. It caps URLs at about 8,000 characters [live ✓: code.claude.com/docs/en/mcp].
- So the gateway avoids `-32042` on the 2025 path, uses MRTR on 2026-07-28, and puts a plain link in the tool result everywhere else (§9.5 A) [inference].

### 2.2 Other 2026-07-28 pieces and what the hub does with them

| Feature | What the spec says | Hub use [inference] |
|---|---|---|
| Stateless core | No `initialize` or `Mcp-Session-Id`; cross-call state uses "explicit, server-minted handles passed as ordinary tool arguments" [live ✓] | Pending approvals and connect intents are D1 records keyed `<user_id>:<handle>`. "MCP servers **MUST NOT** treat possession of a state handle as authentication" [live ✓] |
| `server/discover` | Servers MUST implement it [live ✓] | Already in the SDK path (mcp-design D1) |
| MRTR `input_required` | Replaces server-initiated elicitation, sampling and roots; only on `tools/call`, `prompts/get`, `resources/read` [live ✓ / sa] | Connect and approval prompts for 2026-07-28 clients that declare `elicitation.url` |
| Tasks | Moved to the official extension `io.modelcontextprotocol/tasks` (poll with `tasks/get`, `tasks/update`) [live ✓] | Not needed in v1; candidate for long provider jobs (exports, bulk sends) |
| `ttlMs` / `cacheScope` | Required on list results; `"private"`: "Caches MUST NOT be shared across authorization contexts" [live ✓ / sa] | `tools/list` is per-principal, so always `private` |
| `Mcp-Method` / `Mcp-Name`, `x-mcp-header` | Required on POSTs; mismatches → 400 `HeaderMismatch` `-32020`. Intermediaries enforcing policy "SHOULD reject" requests whose version doesn't require header–body validation [live, sa]. Don't mirror sensitive params into headers [live ✓] | Meter and rate-limit on the headers; enforce policy on the parsed body |
| `subscriptions/listen` | Long-lived stream for `toolsListChanged` and `resourceSubscriptions` only; the server "MUST NOT send notification types the client has not explicitly requested" [live ✓] | `tools/list_changed` when a user connects or revokes an integration; optional resource updates for events (§7.3) |
| Authorization | "Authorization servers and MCP clients **SHOULD** support" CIMD; DCR "is deprecated and retained for backwards compatibility"; `iss` validation; "MCP servers **MUST NOT** accept or transit any other tokens"; step-up via 403 `insufficient_scope` [live ✓] | CIMD first for upstream vendors (§4.2). Use step-up (`insufficientScope()` in `workers-oauth-provider` [live ✓]) to upgrade a read-only grant to read-write without a full reconnect |
| Tool annotations | `ToolAnnotations` unchanged since 2025-11-25 [code, sa]; "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers" [live ✓] | Annotations from upstream servers are hints only (§5.4) |
| Skills extension | `io.modelcontextprotocol/skills`, SEP-2640 "Final"; `skills/list`, `skills/get`, `skill://` resources with SHA-256 manifests; "SDK and host support is still being implemented" [live ✓] | Later: serve per-integration how-to guides as skills (Cloudflare's API MCP server does since 2026-10-10 [live ✓]) |

### 2.3 MCP Apps (UI resources)

- **Status:** SEP-1865 "Stable (2026-01-26)", extension `io.modelcontextprotocol/ui`, `ui://` scheme, `text/html;profile=mcp-app` [code ✓: ext-apps spec].
- **Client support** [live ✓: extensions/client-matrix]: Claude web and Desktop, VS Code Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra, PostHog Code. Claude iOS renders apps in a WKWebView [live, sa].
- **App-only tools:** `_meta.ui.visibility` of `["app"]` hides a tool from the model. "Host MUST NOT include tools in the agent's tool list when their visibility does not include 'model'", and the host "MUST reject `tools/call` requests from apps for tools that don't include 'app'" [code ✓]. The server cannot tell an app click from a model call; it relies on the host enforcing this.
- **Links:** `ui/open-link` asks the host to open a URL; Claude shows an "Open external link" modal [live, sa].
- **Use for a hub [inference]:**
  - "Connect Gmail" and "Approve this send" cards in hosts with MCP Apps but no elicitation (claude.ai, ChatGPT, Cursor).
  - The card opens the gateway's connect or approve URL in the system browser. Never collect third-party credentials inside the iframe.
  - App-only approve buttons are acceptable for medium-risk writes. Keep browser-session approval for high-risk ones.

### 2.4 Enterprise-managed authorization (Cross App Access, ID-JAG)

- **Status:** official extension `io.modelcontextprotocol/enterprise-managed-authorization`, "Stable" since 2026-06-17 (SEP-990 Final). The underlying ID-JAG grant is still an IETF draft [code/live, sa].
- **Flow:**
  1. The client signs the user in with SSO.
  2. It does an RFC 8693 token exchange at the IdP for an `id-jag`.
  3. It presents that to the MCP server's authorization server as a `jwt-bearer` grant.
  4. It receives a token bound to the `resource` [code, sa].
- **IdPs:** Okta "Early Access" (2026-10-09). WorkOS and Auth0 are early access per third-party sources. No primary source for Entra [live, sa].
- **Clients:**
  - Claude Team and Enterprise: generally available since 2026-08-24, across chat, Claude Code and Cowork.
  - VS Code: preview.
  - Codex: behind a flag.
  - ChatGPT and Cursor: no evidence.
  - The extension matrix lists only Archestra and mcpc [live ✓ / sa].
- **Vendor side:** Linear, Notion, Slack, Asana, Supabase, Figma, Atlassian and Zoom advertise the `jwt-bearer` grant with the ID-JAG profile in their metadata [live, sa].
- **`workers-oauth-provider`:** already accepts ID-JAG, as "**Experimental**… exempt from 1.x semver". Its replay marker is "best effort" on KV, and the grant issues no refresh tokens [code ✓].
- **Hub stance [inference]:** defer. Later it could cover client → gateway for Okta customers, and gateway → vendor MCP if the IdP registers the gateway as a requesting app. It does nothing for Google APIs.

### 2.5 Security rules for proxies and gateways (all [live ✓]: security_best_practices and authorization pages, 2026-07-28)

- **Token passthrough:** "MCP servers **MUST NOT** accept any tokens that were not explicitly issued for the MCP server" and "MCP servers **MUST NOT** accept or transit any other tokens." The gateway's `/mcp` token ends at the gateway; upstream calls use the connection's own token.
- **Confused deputy:** this applies when a proxy uses a static client ID at a third party *and* lets MCP clients register dynamically. Proxies "**MUST** implement per-client consent":
  - "Maintain a registry of approved `client_id` values per user" and check it "**before** initiating the third-party authorization flow".
  - The consent page names the client, shows the third-party scopes and the `redirect_uri`, has CSRF protection, and blocks framing.
  - Consent cookies use `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, are signed, and are bound "to the specific `client_id`".
  - Redirect URIs use exact matching.
  - `state` is single-use, about 10 minutes, and stored "**only after** consent has been explicitly approved".
  - In Every App's design, third-party OAuth is **decoupled** from MCP client authorization: Connections are made by a signed-in user on the gateway's own pages. The exposure is therefore smaller than in the classic proxy case, but the same cookie and state rules apply to the connect flow.
  - `workers-oauth-provider`'s `beginConsent`/`beginUpstream`/`finishUpstream` helpers implement these rules for the coupled pattern [code ✓: docs/upstream-sign-in.md].
- **SSRF:** "MCP clients deployed to a server **MUST** consider SSRF risks" when fetching `resource_metadata`, `authorization_servers` and token endpoints. This applies to the gateway as a client of vendor MCP servers, and to its own AS when fetching CIMD documents. Mitigations: HTTPS only, block private and link-local ranges, validate each redirect hop, use an egress proxy, beware DNS TOCTOU. On Workers, `global_fetch_strictly_public` blocks private IPs after DNS resolution on every redirect hop [prior: ref-cloudflare-os §2].
- **Mix-up attacks:** record the issuer before redirecting and validate `iss` in the response (RFC 9207). The gateway must do this as an upstream client.
- **Scope minimization:** "Publishing all possible scopes in `scopes_supported`" is listed as a mistake. Start minimal and step up.

### 2.6 Client support matrix (sub-agent, from source and changelogs where available; modelcontextprotocol.io/clients was removed 2026-05-27)

| Client (evidence date) | URL elicitation | Form elicitation | MCP Apps | 2026-07-28 | CIMD |
|---|---|---|---|---|---|
| claude.ai web / Desktop / mobile (docs 10-12) | No evidence (docs never mention "elicit"; issue #153 open [live ✓]) | No evidence | Yes (iOS via WKWebView) | "Rolling out" (blog 07-28) | Yes |
| Claude Code 2.1.296 (10-09) | Yes [live ✓: docs say it declares `elicitation: {form: {}, url: {}}` on 2026-07-28]; on 2026-07-28 since 2.1.281, on 2025-11-25 since 2.1.287 [sa: changelog] | Yes | No (`ui://` hidden [live ✓]) | Yes (HTTP default by 09-16) | Yes |
| ChatGPT apps / developer mode | No evidence | Yes, via MRTR (09-29) | Yes | Partial (MCP Events requires it) | Yes (`chatgpt.com/oauth/client.json`; offers `none` + `private_key_jwt` [code ✓]) |
| Cursor (undated docs) | Unknown | Yes | Yes | No evidence | No evidence |
| VS Code 1.141.0 (10-07) | Yes, incl. `-32042` | Yes | Yes | No (sends 2025-11-25) | Yes |
| Codex CLI 0.162.1 (10-09) | Declared | Yes | Behind a flag | Behind a flag (initializes 2025-06-18) | Yes |
| Gemini CLI (main, 10-12) | No | No | No evidence | No | No (DCR only) |
| Goose 1.54.0 (10-08) | Not advertised | Yes | Yes | Yes (falls back to 2025-11-25) | Yes |
| Zed 1.23.3 (10-12) | No | No | No | No | Yes |
| Windsurf / Devin Desktop | No evidence | No evidence | No evidence | No evidence | No evidence |

**Consequence [inference]:** the connect and approval UX must work with **no** elicitation (a link in the tool result), get better with MRTR URL elicitation, and get better again with an MCP Apps card. Never depend on a single path.

---

## 3. Third-party credentials on Cloudflare

### 3.1 Better Auth linked accounts vs a dedicated `connections` table

I read Better Auth 1.7.7 (the gateway's pinned version) from the npm tarball.

| Question | Better Auth `account` rows (1.7.7) | Dedicated `connections` table |
|---|---|---|
| Owner | One user. A provider account can belong to only one user; linking it to another fails with `account_ownership_conflict` [code: `dist/oauth2/link-account.mjs`] | A user, or the org (shared mailbox, Slack bot, GitHub App installation), with many grantees |
| Org scoping | None; rows key on `userId` [code] | `organization_id` on every row |
| Side effect | **A linked account is a login method.** OAuth sign-in calls `findAccountOwnerByKey({providerId, accountId})` and signs in the owner [code]. Linking `ops@company.com` Gmail to Alice makes it a way to sign in as Alice whenever Google is a configured provider | None. A connection never authenticates anyone; Executor v2's rule is "a login is not an account" [prior] |
| Email rule | `linkSocial` rejects a different email unless the global `accountLinking.allowDifferentEmails` is on [code: link-account.mjs L47] | Any label (bots, shared inboxes, other domains) |
| Refresh | `getValidAccessToken` refreshes within 5 s of expiry, then read-modify-writes. No lock. Every failure becomes `FAILED_TO_GET_ACCESS_TOKEN`, so "revoked" and "provider down" look the same [code: `dist/api/routes/account.mjs`] | Single-flight with a version check; `invalid_grant` handled differently from transient errors (§3.3) |
| Encryption | Off by default ("Better Auth doesn't encrypt tokens by default and that's intentional" [live ✓ docs]). The option `account.encryptOAuthTokens` uses XChaCha20-Poly1305 with key = SHA-256 of `BETTER_AUTH_SECRET` and a versioned `$ba$<v>$` envelope [code: `dist/oauth2/utils.mjs`, `dist/crypto/index.mjs`] | Envelope encryption under a separate key (§3.2) |
| Non-OAuth credentials | Don't fit (API keys, GitHub App installations, MCP-server OAuth) | `auth_kind` column covers them |

**Verdict [inference]:** keep Better Auth for identity only.
- Don't register connection-only providers (Slack, Linear, Notion…) as Better Auth social providers, and don't use `linkSocial` for tool access.
- If the gateway offers "Sign in with Google", ask for minimal scopes there, and request Gmail scopes only in the separate connect flow. Cloudflare OS does the same: sign-in grants are minimal and transient [prior: ref-cloudflare-os §3.1].

### 3.2 Encrypting tokens in D1

- **Why app-level encryption.** D1 encrypts at rest with Cloudflare-managed keys [docs: developers.cloudflare.com/d1/platform/data-security]. That protects disks, not readers: anyone with D1 read on the account sees plaintext (dashboard console, an API token, an export, a SQL-injection bug). App-level encryption makes a dump useless without a key that lives only in Worker secrets [inference].
- **Envelope scheme [inference].** Every primitive is in Workers Web Crypto: AES-GCM encrypt/wrapKey, AES-KW, HKDF, X25519 [live ✓: web-crypto, updated 2026-09-30].
  - **KEK:** 32 random bytes, versioned (`kek_v1`, `kek_v2`), stored as a Worker secret.
  - **DEK:** one random AES-256 key per org, stored wrapped by the KEK in an `org_keys` row; unwrapped DEKs are cached in isolate memory for a few minutes.
  - **Each token field:** AES-256-GCM with a random 96-bit IV and AAD = `conn:<connection_id>:<field>:<token_version>`, so a ciphertext can't be swapped into another row or field.
  - **Rotation:** a new KEK re-wraps only the DEK rows. Deleting an org's DEK crypto-shreds its tokens.
  - **Separation:** keep this key separate from `BETTER_AUTH_SECRET` and the JWT signing key.
- **Secrets Store** is "Available in open beta", "up to 100 secrets per account", "only be one store per account", 65,536-byte values, Workers and AI Gateway only. "You cannot access production secrets… from your local development setup" [live ✓: secrets-store pages updated 2026-08-14, 2026-09-25, 2026-05-05].
  - Use a Worker secret for the KEK by default (GA, already CLI-managed), with Secrets Store as an option behind a small `KeyProvider` interface.
  - Secrets Store is never the per-user token store: it is capped at 100 secrets, and writes need an API token with "Secrets Store Write".

### 3.3 Refresh concurrency: one Durable Object per connection

- **Why it matters.** GitHub App user tokens, Slack (rotation on), Linear (since 2026-04-01), Atlassian, Notion and Stripe Apps all rotate refresh tokens; GitHub has no grace period [live, sa; §4.1]. Two concurrent refreshes make one fail with `invalid_grant`, and on GitHub that kills the connection until the user re-authorizes.
- **What a DO gives you.** "Each Durable Object is a single-threaded, globally-unique instance", but "Non-storage I/O like `fetch()`… allows other requests to interleave", and the docs recommend optimistic locking [live ✓: rules-of-durable-objects, 2026-08-20]. So the lock is an in-memory promise plus a version check, not the DO alone.

```ts
// One instance per connection: env.CONNECTION_LOCK.idFromName(connectionId)
export class ConnectionLock extends DurableObject<Env> {
  #inflight?: Promise<TokenView>;
  refresh(connectionId: string, seenVersion: number): Promise<TokenView> {
    this.#inflight ??= this.#doRefresh(connectionId, seenVersion)
      .finally(() => { this.#inflight = undefined; });
    return this.#inflight;                                  // concurrent callers share one refresh
  }
  async #doRefresh(id: string, seen: number): Promise<TokenView> {
    const row = await loadConnection(this.env, id);         // D1
    if (row.token_version > seen && !expiringSoon(row)) return view(row); // someone already refreshed
    const r = await providerFor(row).refresh(await decryptRefresh(this.env, row));
    if (r.kind === "invalid_grant") { await markNeedsReauth(this.env, id); throw new ReauthRequired(id); }
    if (r.kind === "transient") throw new Retryable(r.retryAfterMs);
    // Save the new refresh token BEFORE anyone uses the new access token.
    const won = await casUpdateTokens(this.env, id, row.token_version, r); // UPDATE … WHERE token_version = ?
    return won ? viewFrom(r) : view(await loadConnection(this.env, id));
  }
}
```

- **The hot path doesn't touch the DO.** The tool-call path already reads the connection row from D1 for authorization. It decrypts the access token and calls the DO only when the token expires within about 2 minutes. With 1-hour tokens that's about one DO request per active connection per hour, negligible at $0.15 per million requests; SQLite DOs also run on Free [live ✓: DO pricing, 2026-09-30].
- **Health.** A daily cron refreshes idle connections whose refresh tokens expire on inactivity (Google 6 months unused, Atlassian 90 days, Entra 90 days, GitHub 6 months [live, sa]) and marks `needs_reauth` on `invalid_grant`.
- **One grant per user per provider.** Providers silently evict tokens past a cap: Google 100 refresh tokens per client per account; GitHub 10 per user/app/scope; Slack 2 active [live, sa]. Share one grant across all agents and apps; never re-run consent per agent.
- **What not to copy.** `workers-oauth-provider`'s "upstream sign-in" refreshes a third-party token inside the MCP client's own refresh (`tokenExchangeCallback`), storing it in that one grant's encrypted `props` [code ✓]. That ties the GitHub token to one MCP client, so other clients and apps can't reuse it. Borrow its consent and state rules, not its storage.

### 3.4 Agents SDK `MCPClientManager` as the upstream MCP client

| | Finding |
|---|---|
| What it does | `this.mcp` on an Agent (a DO). `addMcpServer(name, url, opts)` returns `{state:"authenticating", authUrl}` or `ready`; `listTools()`, `getAITools()` (AI SDK, namespaced by server id); `configureElicitationHandlers({form, url})`; RPC transport for in-account servers [live ✓: mcp-client-api, 2026-07-27] |
| Auth | The default provider does Dynamic Client Registration. Override `createMcpOAuthProvider(callbackUrl)` for pre-registered clients (v0.4.0, 2026-02-09) [live ✓]. "OAuth tokens are securely stored in SQLite" inside the Agent [live ✓]. The shipped `DurableObjectOAuthClientProvider` has no `clientMetadataUrl`, so no CIMD out of the box [code: agents@0.28.0 d.ts] |
| Protocol | v0.20.0 (2026-07-27) uses `@modelcontextprotocol/client`, probes `server/discover`, falls back to legacy `initialize`, and handles MRTR [live ✓] |
| Safety | Blocks private, link-local and metadata addresses [live ✓] |
| Fit | **Partial.** Good for an agent that consumes MCP itself. For a gateway proxying vendor servers for many users and apps, tokens end up in per-Agent SQLite: not in the org-wide table, not envelope-encrypted, not visible to admins. `agents` also releases weekly with pinned peers (why mcp-design D1 rejected it for the server side) |
| Recommendation | Use `@modelcontextprotocol/client` 2.3.x directly; it is what `agents` wraps, and its `OAuthClientProvider` supports `clientMetadataUrl` [code: client@2.3.1 `index.d.mts`]. Back it with a custom provider over the `connections` table and the §3.3 lock. Revisit `agents` if Every App adds a gateway-hosted agent |

### 3.5 Hosted vaults instead of building one

Small-org example: 10 users, 30 connected accounts, 50k tool calls a month. All rows are [live, sa]; costs are arithmetic on today's price lists.

| Service | Vendor-managed apps | Raw token out? | Org-shared accounts | Small-org cost | Fit for MIT self-host |
|---|---|---|---|---|---|
| Auth0 Token Vault (GA 2025-11-19) | Dev keys only ("strictly for testing") | Yes: token exchange at `/oauth/token`; Auth0 refreshes | **No**: "Token Vault does not create a shared organization account" | Free plan holds 2 connected apps; AI add-on ≈ $53–225/mo | Poor: Auth0 must be the login provider; one tenant per install |
| WorkOS Pipes (2026-01-15) | "Shared credentials" while building | Yes: `POST /data-integrations/{slug}/token`; or Relay mode (token never leaves WorkOS) | Yes (`connection_owner:"organization"`) | Not published | Medium-low: one account per install |
| Arcade.dev | Yes (Arcade branding, shared limits) | Yes | — | ≈ $525+/mo (Team $25 + $0.10 per auth event + $0.01 per call) | Helm self-host needs K8s, Postgres, Redis; license unclear |
| Nango | "Shared developer apps for some" APIs; "strongly recommend registering your own" | Yes: `GET /connections/{id}` refreshes if expired | — | ≈ $50/mo | Free self-host is ELv2, "Auth and Proxy" only, Docker + Postgres + Redis + Elasticsearch |
| Composio | 123 toolkits managed (Gmail, Slack, GitHub, Linear, Notion, HubSpot, Jira, Outlook, Teams…) | **No**: "Reading connected-account state is not a supported token-export workflow" | Yes | $0–70/mo | Self-host is Enterprise; Cloud holds tokens |
| Pipedream Connect (now part of Workday) | Default | Only with your own client | — | ≈ $99–630/mo | No self-host found |
| Scalekit AgentKit | Yes | Only when support enables it | Yes | $99/mo | One account per install |
| Paragon / Merge Agent Handler | Dev keys / default Merge apps | Proxy only / undocumented | — | Custom / $1,000+/mo | Enterprise self-host only |

**Takeaways [inference]:** a hosted vault adds a second vendor account per install, moves token custody outside the customer's Cloudflare account, and still doesn't remove the need for the customer's own OAuth apps in production. Build the store in the gateway; keep a `CredentialSource` seam (`builtin | workos_pipes | auth0_token_vault`) for enterprises.

---

## 4. The OAuth client problem for an open-source, self-hosted product

### 4.1 What each provider requires

All [live, sa]. I re-verified the Google scope table, the Slack MCP page and the Slack rate-limit page myself [live ✓].

| Provider | Cheapest compliant path for one company's own install | What triggers review or verification | Redirect URIs | Tokens and refresh |
|---|---|---|---|---|
| **Google** | OAuth client in the customer's own Cloud project, consent screen **Internal** (needs a Workspace / Cloud Identity org) | **Internal:** exempt from verification even for restricted scopes.<br>**External + Testing:** ≤100 test users, and refresh tokens expire after 7 days.<br>**External, unverified:** 100 new users per project lifetime, "cannot be reset".<br>**Restricted scopes** (`gmail.readonly`, `.modify`, `.compose`, `.metadata`, `.insert`, `mail.google.com`, `drive`, `drive.readonly`) need restricted-scope verification plus a lab assessment "at least every 12 months". `gmail.send` is sensitive; `drive.file` non-sensitive [live ✓ scopes].<br>Projects created from 2026-05-01 get new Workspace API/MCP quota tiers | Exact match, HTTPS, no wildcards | ~1 h access tokens. No rotation. The refresh token dies on revoke, 6 months unused, a password change (Gmail scopes), or the 100-per-client-per-account cap ("silently invalidates the oldest") |
| **Microsoft Entra** | Single-tenant app registration in the customer's tenant | Publisher verification only matters for multitenant apps; higher-impact permissions need admin consent | Exact, case-sensitive, up to 256 | 60–90 min access tokens. 90-day refresh tokens that "replace themselves", but old ones aren't revoked (no race) |
| **Slack** | Internal (undistributed) app, created from a prefilled manifest | Marketplace review only for listing. Unlisted distributed apps created after 2025-05-29 get 1 req/min and 15 objects on `conversations.history`/`.replies`; "Internal customer-built applications are not impacted" [live ✓] | Must match or be a subdirectory | Without rotation, tokens don't expire. With rotation: 12 h access tokens, single-use refresh tokens, and rotation "may not be turned off once it's turned on" |
| **GitHub** | GitHub App created through the manifest flow | No GitHub review; an org owner installs it | Up to 10 callback URLs | User tokens last 8 h. Refresh tokens last 6 months and are single-use ("that refresh token and the old user access token will no longer work"). Installation tokens last 1 h |
| **Linear** | OAuth app (manifest prefill), or no app at all via the vendor MCP server | None documented | Must match | 24 h access tokens. Since 2026-04-01, rotating refresh tokens with a 30-min grace period. `actor=app` tokens last 30 days |
| **Notion** | Internal connection token (org-level), or the vendor MCP server | Public OAuth connections are reviewed | Several allowed | Refresh tokens rotate |
| **HubSpot** | Static-auth token (one account), or an "MCP connector" client for the hosted MCP server | Marketplace listing only | HTTPS, no IPs | 30-min access tokens; long-lived refresh token (rotation coming) |
| **Atlassian** | OAuth 2.0 (3LO) app, which works only for its owner unless shared. Or Rovo MCP via DCR/CIMD after an org-admin domain allowlist. Or API tokens | Shared, unreviewed apps show a warning | Exact | Rotating refresh tokens; 90-day inactivity expiry; 10-min reuse window |
| **Asana / Salesforce / Zendesk** | Asana: console app, or an MCP app for its V2 server. Salesforce: External Client App. Zendesk: local OAuth client per account ("Zendesk doesn't allow developers to create their own global OAuth clients") | — | Asana: one URL; Salesforce and Zendesk not verified | Asana ~1 h; Zendesk 30-min default for clients created from 2026-04-30 |
| **Stripe** | Restricted or "agent" API key | OAuth needs a published Stripe App | Exact | Refresh token valid 1 year, rolled on every exchange |

**Reading of the table [inference].** For one company running its own gateway, per-install registration is usually the cheapest *and* most compliant path. The real costs are:
- setup effort across roughly a dozen consoles;
- consumer-Gmail users, who force the External type and verification;
- refresh-token rotation.

### 4.2 Which vendors' official MCP servers need no client registration

Sources: vendor docs plus unauthenticated reads of each host's `.well-known` metadata [live, sa]. No `/register` calls were made, so "works" means "advertised".

| Works via CIMD and/or DCR | Advertises DCR but gates clients | Needs a client the customer registers |
|---|---|---|
| Linear (`mcp.linear.app/mcp`, DCR + CIMD; `/readonly` variant)<br>Notion (`mcp.notion.com/mcp`, DCR + CIMD; Enterprise admins can restrict)<br>Sentry<br>Cloudflare (DCR + CIMD + `private_key_jwt`)<br>Stripe (DCR)<br>Supabase<br>Airtable<br>ClickUp<br>PayPal<br>Likely Zendesk, Shopify, Monday (metadata only)<br>Atlassian Rovo (DCR + CIMD) **after** an org-admin domain allowlist; calls spend Rovo credits | Vercel ("only supports AI clients that have been reviewed and approved")<br>Figma (catalog / waitlist)<br>Dropbox ("trusted set")<br>Intercom (redirect-URI allowlist via Support) | **Google Workspace MCP** (`gmailmcp.googleapis.com/mcp/v1` etc.): Developer Preview Program enrollment, own Cloud client, restricted scopes [live ✓]<br>**Microsoft Work IQ**: needs Microsoft 365 Copilot licenses<br>**Slack** (`mcp.slack.com/mcp`): "We do not support… Dynamic Client Registration"; "Only directory-published apps or internal apps may use MCP"; "unlisted apps are prohibited" [live ✓]<br>**GitHub** (`api.githubcopilot.com/mcp/`): "Each MCP host application needs to configure a GitHub App or OAuth App" [live ✓]<br>HubSpot (MCP connector)<br>Asana V2<br>Salesforce<br>Box<br>Zoom |

Cloudflare's own changelog agrees: manual OAuth credentials for portals exist for "major SaaS providers such as Slack and GitHub, whose MCP servers do not yet support DCR" (2026-07-31) [live ✓].

**Rule for the gateway as an MCP client [inference]:**
- Try in this order: CIMD, then a customer-registered client, then DCR.
- Publish a per-provider CIMD document, e.g. `https://<gateway>/.well-known/oauth-client/<provider>.json` listing `https://<gateway>/oauth/upstream-callback/<provider>`.
- Key stored client credentials by issuer, as 2026-07-28 requires [live ✓].

**Token audience caveat [inference]:** a token obtained for `mcp.linear.app` is audience-bound to that MCP resource (RFC 8707). It may not work against `api.linear.app`, so store `audience` on the connection, and let the app egress proxy (§6) use only connections whose audience covers the API hosts.

### 4.3 Making BYO clients cheap: setup automation that exists today

| Provider | Automation | Source |
|---|---|---|
| GitHub | App manifest flow:<br>1. POST a manifest to `github.com/settings/apps/new` (or the org URL); the user clicks Create.<br>2. GitHub redirects back with a code.<br>3. `POST /app-manifests/{code}/conversions` returns the app id, client secret, webhook secret and private key.<br>All three steps must finish "within one hour". | [live ✓] docs.github.com/…/registering-a-github-app-from-a-manifest |
| Slack | Prefilled link `https://api.slack.com/apps?new_app=1&manifest_yaml=…` (or `manifest_json`). `apps.manifest.create` with a 12-hour app configuration token [live ✓]; the sub-agent reports it returns the client id, secret and signing secret [live, sa] | docs.slack.dev/app-manifests/configuring-apps-with-app-manifests |
| Linear | OAuth app manifests prefill `linear.app/settings/api/applications/new`, which Linear describes as useful "for self-hosted or open-source projects" | [live, sa] |
| Google, Microsoft, Atlassian, Asana, HubSpot | No one-click equivalent found. Use a guided checklist with copy buttons for the redirect URI and scopes. Google's own Workspace CLI makes every user bring a Cloud project and OAuth client, and notes unverified apps "are limited to ~25 OAuth scopes" | [live ✓] github.com/googleworkspace/cli README |

### 4.4 A hosted broker ("Every App Connect"): what it would look like

**Precedent: Home Assistant Cloud account linking** [code ✓: `home-assistant/core` `components/cloud/account_link.py`; `NabuCasa/hass-nabucasa` `account_link.py`].
- **Authorization.** The self-hosted instance opens a websocket to `https://<account_link_server>/v1`, sends `{"service": …}`, gets an `authorize_url`, and later receives `tokens` on the same socket. The broker owns the OAuth client and redirect URI and does the code exchange.
- **Refresh.** The instance sends `POST /refresh_token/<service>` with `{"refresh_token": …}`. Tokens live on the instance, but every refresh needs the broker.
- **Coverage.** The public list (`https://account-link.nabucasa.com/services`, [live ✓]) has 27 services: OneDrive, Dropbox, Xbox, Netatmo, SmartThings and others. Spotify shows `"accepts_new_authorizations": false`. **No Google service is brokered.** Home Assistant's Gmail integration tells users to create their own Cloud project and to publish the app, "Otherwise, your credentials will expire every 7 days" [live ✓].

**A safer design for Every App [inference]:**
1. **Install key.** Each gateway generates an Ed25519 key at first boot and registers its public key and `GATEWAY_URL` with the broker. Every broker call is signed.
2. **Authorize.** The gateway sends `POST /v1/authorize {provider, scopes, nonce, return_url}`. The broker returns an authorize URL using its own client id, redirect URI and PKCE pair.
3. **Callback.** The broker exchanges the code and **seals the token response to the install's public key** (HPKE/JWE with X25519). It stores nothing and redirects the browser to `return_url?ticket=…`. The gateway fetches the sealed blob with a signed request.
4. **Refresh.** The gateway sends the refresh token sealed to the broker's key; the broker adds the client secret, calls the provider, and seals the answer back.
5. **Webhooks.** For apps registered once per provider (Slack Events API, GitHub App), every customer's events go to the broker's one URL, so the broker would see message bodies. Keep webhooks out of the broker.

| Concern | Effect |
|---|---|
| Custody | The broker sees tokens in transit on every exchange and refresh |
| Availability | A broker outage stalls every brokered connection after access-token expiry (hourly for Google and Microsoft) |
| Provider kill switch | One provider decision disables every install at once (see Home Assistant's Spotify entry) |
| Google | Every App would be "the app" for verification and the annual assessment, while data is processed in customer-run gateways it can't attest to. **Never broker Google restricted scopes** |
| Branding and quotas | Consent screens say "Every App"; per-client quotas are shared; Slack's 2025 rate cut applies to unlisted distributed apps |
| Abuse | A malicious self-hoster could phish users with the broker's client. Needs install verification, rate limits and revocation |

**Recommendation:** BYO first, with the setup automation in §4.3. A broker can come later as an optional convenience for low-risk providers, open-sourced so an agency or FDE can run one for its own clients.

### 4.5 How Composio, Pipedream and Nango handle managed vs BYO clients

All [live, sa].
- **Everyone runs vendor-owned ("managed") OAuth apps for speed and tells customers to bring their own for production.**
- **Branding:** "Users will see 'Composio wants to access your account'… In production, users should see your app name… This is the most common reason to switch" (Composio). Pipedream: "you grant Pipedream the requested permissions".
- **Quotas:** "Managed apps share quota across all Composio users"; "All Arcade users share the same rate limits".
- **Revocation and portability:** "Nango developer apps may be revoked by the provider at any time"; "only your own developer app lets you export access and refresh tokens and move off Nango without users re-authorizing".
- **Token access:**
  - Pipedream returns raw tokens only for customer-owned clients.
  - Composio never exports tokens, and "Owning the OAuth app does not move the token store into your infrastructure".
- **Google:** vendors' verified apps carry Google verification for you. A BYO Google app makes the verification yours unless it's Internal.

---

## 5. Where tools come from

### 5.1 Proxying vendor-hosted MCP servers

- **Who runs one and how they authenticate:** see §4.2.
- **Quality and drift are mixed.**
  - GitHub's default toolsets are about 45 of about 97 tools [inference, sa count]. It offers per-URL toolsets, `/readonly`, and headers `X-MCP-Toolsets`, `X-MCP-Readonly` and `X-MCP-Lockdown` ("hiding public issue details created by users without push access… a best-effort content filter, not a security boundary") [live ✓].
  - Vendors deprecate on their own schedule: Asana V1 shutdown 2026; Stripe rejects non-Agent keys from 2026-10-31; Atlassian moves v1 to v2 by 2027-03-01 [live, sa].
- **Hub value on top [inference]:** one consent and audit model, the hub's risk policy and approvals, read-only enforcement (by URL or header where offered), pin-and-diff, and connections shared with apps where the token audience allows.

### 5.2 Generating tools from OpenAPI

- **Generator vendors moved away from one tool per endpoint.** Stainless shipped "dynamic tools" (`list_api_endpoints`, `get_api_endpoint_schema`, `invoke_api_endpoint`) on 2025-05-09 and now ships code-mode servers [live ✓]. Cloudflare's Code Mode SDK has an `OpenApiConnector` [live ✓].
- **Spec coverage is uneven** [live ✓: GitHub API]:

| Provider | Machine-readable API description |
|---|---|
| GitHub | `github/rest-api-description`, active (pushed 2026-10-10) |
| Stripe | `stripe/openapi`, active |
| HubSpot | `HubSpot/HubSpot-public-api-spec-collection`, active |
| Microsoft 365 | `microsoftgraph/msgraph-metadata`, active, very large |
| Slack | `slackapi/slack-api-specs` **archived** (last push 2021-09-07) |
| Google Workspace | Discovery documents, not OpenAPI |
| Linear | GraphQL only |

- **Problems [inference]:**
  - Tools take the shape of endpoints, not agent tasks.
  - Schemas are huge and results verbose.
  - The HTTP verb is the only risk signal, and it misleads (search endpoints are POST reads).
  - OAuth scopes don't map cleanly to operations.
- **Fit:** long-tail coverage through code mode, not the default surface.

### 5.3 Hand-curated "agent-native" tools

- **Best quality and safety:** task-shaped tools, author-set risk, trimmed outputs, actionable errors.
- **Cost:** highest maintenance. Precedents: Executor's founder called its plugin system "a fiction" [prior: ref-executor §2.1]; Cloudflare OS hand-writes 16 gatekeeper Workers [prior].
- **Use them where no usable vendor MCP exists for a self-hoster:** Gmail, Calendar and Drive (Workspace MCP is Developer Preview), Microsoft 365 (Work IQ needs Copilot licenses), and possibly Slack (its MCP server works with an internal app, but curated tools give tighter control).

| Source | Quality | Coverage | Maintenance for Every App | Safety posture | Auth |
|---|---|---|---|---|---|
| Vendor MCP | Medium–high | Vendor-chosen | Low, but drift | Untrusted descriptions; pin and diff | Vendor OAuth (CIMD/DCR or customer client) |
| OpenAPI | Low–medium | Broad | Low | Risk by verb only | Connection token |
| Curated | High | Narrow | High | Best | Connection token |

### 5.4 Safety: poisoning, rug pulls, pin-and-diff

- **Evidence**
  - Tool poisoning (hidden instructions in descriptions) and "rug pulls" ("Unauthorized changes to MCP tool descriptions after initial user approval") are named attack classes. mcp-scan's defense is "tool pinning" by hashing descriptions [live ✓: invariantlabs.ai, 2025-04-11].
  - **Real incident:** npm `postmark-mcp` 1.0.16 (2025-09-17) BCC'd every sent email to the publisher [live ✓: thehackernews.com, 2025-09-29].
  - **Injection through data:** a malicious public GitHub issue made an agent copy private-repo data into a public PR. Invariant called it "not a flaw in the GitHub MCP server code itself", and mitigated it by scoping a session to one repo [live ✓: invariantlabs.ai, 2025-05-26].
  - **Lethal trifecta:** "Access to your private data", "Exposure to untrusted content", "The ability to externally communicate" [live ✓: simonwillison.net, 2025-06-16]. **A hub with Gmail + GitHub + Slack for one agent has all three.**
- **What the hub does [inference]**
  1. **Snapshot catalogs.** Store each upstream catalog's `tools/list` (name, description, schema, annotations, hash) in D1.
  2. **Quarantine changes.** New tools are `pending_review` and hidden. Changed descriptions or schemas are re-reviewed when the diff is material.
  3. **Distrust upstream annotations.** Default upstream tools to `write`; only an admin can mark one `read`. This copies CF OS's "byo vs vetted" trust tiers [prior].
  4. **Sanitize text.** Cap descriptions (e.g. 1–2 KB). Never pass an upstream server's `instructions` into the hub's own. Prefix every name with the integration.
  5. **Reduce trifecta exposure.**
     - Connections default to read-only for agents.
     - Outbound-communication tools (send email, post to Slack channels, public GitHub writes) go to approval, at least for external recipients.
     - Optional per-session scoping (e.g. "one repo per session").
     - Use vendor-side knobs (`X-MCP-Lockdown`, `/readonly`).
     - Label tool results that carry third-party content as untrusted.

---

## 6. Credential injection for apps

The gateway already has the right primitive.
- **Binding:** apps reach the private `AppGateway` entrypoint through a service binding whose `props` `{organizationId, appId, workerName}` the CLI writes at deploy [code: `packages/cli/src/lib/generateWranglerConfig.ts` L150–159; `apps/every-app-gateway/src/server.ts` L114–126].
- **Platform guarantee:** "The Workers platform is designed to ensure that `ctx.props` can only be set by someone who has permission to edit and deploy the worker to which it is being delivered… you can trust that the content of `ctx.props` is authentic" [live ✓: workers/runtime-apis/context, updated 2026-10-12].

| Option | Works for Every App's private app Workers? | App sees the token? | Transparent to SDKs? | Status | Verdict |
|---|---|---|---|---|---|
| **A. Service-binding egress proxy**: app calls the gateway; gateway injects the token for the provider's API hosts | Yes | No | Needs a `fetch` adapter (Octokit, googleapis/gaxios and most TS SDKs accept one) | GA | **Default** |
| **B. Short-lived token handout** (`getAccessToken(ref)` RPC) | Yes | Yes, up to the access-token TTL | Fully | GA | Opt-in escape hatch: manifest flag + admin approval + audit event `token_disclosed` |
| C. Workers for Platforms outbound Worker | Only Workers in a dispatch namespace. "Outbound Workers do not intercept fetch requests made from Durable Objects or mTLS certificate bindings"; disables `connect()` [live ✓, 2026-04-21] | No | Yes | GA | Hosted tier only; lint for DO fetches |
| D. Dynamic Workers `globalOutbound` | Only code loaded with Worker Loader. Every `fetch()`/`connect()` "goes through this gateway"; per-tenant `props` [live ✓, 2026-09-29] | No | Yes | Open beta, Workers Paid | Code mode and generated mini-apps |
| E. Sandbox/Container outbound handlers (`outboundByHost`, TLS interception, `allowedHosts`) | Containers only [live ✓ changelog 2026-04-13] | No | Yes, even raw HTTPS | Sandbox SDK 1.0 (2026-09-30) | Coding-agent sandboxes |
| F. Executor v2 credential handles (sealed placeholders swapped at egress) [prior] | Needs an egress hook (C/D/E); on plain Workers it reduces to A | Handle only | Mostly | — | Only with C or D |

A scan of every 2025–2026 Cloudflare changelog entry that mentions outbound or egress found interception only for Workers for Platforms, Dynamic Workers and Sandboxes/Containers [live ✓: changelog RSS]. There is no general outbound hook for ordinary Workers.

**Option A in detail [inference]**
- **SDK usage:** `const ghFetch = everyApp.connections.fetch("github", { as: "user" })`, then `new Octokit({ request: { fetch: ghFetch } })`. Implement it as an RPC method on `AppGateway` (`connectionFetch(ref, request)`) so bodies stream.
- **Gateway checks, in order:**
  1. The caller app, from `props` plus the registry (existing code).
  2. The manifest declares the provider.
  3. An admin approved the app's grant.
  4. For `as:"user"`: the 120 s identity JWT names the user, the user has a connection, and the user has allowed this app.
  5. The URL is `https:`, port 443, and the host is in the provider pack's host list (exact match; no IP literals, no userinfo).
  6. The method fits the grant: read grants allow `GET`/`HEAD` plus provider-listed read-only POSTs.
  7. **If the identity JWT came from an agent (`chan:"mcp"`) whose grant lacks `mcp:write`, refuse writes.** The agent's read-only consent then holds even inside app code paths. Link the audit row to the originating tool call through the JWT's `tc.id`.
- **Request and response handling:** drop the caller's `Authorization` and `Cookie` and inject the token; use `redirect: "manual"` so credentials never follow a redirect to another host; strip `set-cookie` from the response; on a 401, refresh once and retry.
- **Limits to design for:** 6 simultaneous open connections per invocation, and "Service-bound Workers share this limit"; 10,000 subrequests per invocation by default on Paid [live ✓: workers/platform/limits, 2026-10-12].
- **Background jobs** (no live user request) may only use org-owned connections, or a per-user "this app may act for me while I'm away" grant.

---

## 7. Triggers

### 7.1 Provider webhook mechanics (all [live, sa])

| Provider | Registration | Verification | Delivery | Renewal |
|---|---|---|---|---|
| Slack | One Request URL per Slack app, covering all installs (or Socket Mode) | `url_verification` challenge; `X-Slack-Signature` = HMAC-SHA256 of `v0:{ts}:{body}`; reject if the timestamp is more than 5 min off | 2xx within 3 s; 3 retries; subscriptions disabled if >95% fail within 60 min | None |
| GitHub | GitHub App: one webhook for all installations | `X-Hub-Signature-256`; no timestamp, so dedupe on `X-GitHub-Delivery` | 2xx within 10 s; **no automatic retry** (manual or API redelivery for 3 days) | None |
| Linear | Per workspace, or auto-created per authorizing org for OAuth apps | `Linear-Signature`; timestamp within a minute | 3 retries (1 min, 1 h, 6 h) | None |
| Gmail | `users.watch` **per mailbox** → a Pub/Sub topic in a GCP project | Pub/Sub push OIDC JWT (`aud`, `email`) | Payload is only `{emailAddress, historyId}`; Gmail "might" delay or drop; Pub/Sub retries | **At least every 7 days** |
| Calendar / Drive | `watch` channel per resource | `X-Goog-Channel-Token` | Retries on 5xx; "not 100% reliable" | Drive: files ≤1 day, changes ≤1 week |
| Microsoft Graph | `POST /subscriptions` per resource | `validationToken` handshake (10 s); `clientState` | 2xx within 3 s; retried for 4 h; throttled endpoints can be dropped ("can't be recovered"); lifecycle events (`missed`, `reauthorizationRequired`) | Mail ≤10,080 min (1,440 with resource data) |
| Notion | One subscription per integration (UI only) | `verification_token`, then `X-Notion-Signature` | "We aim for at-most-once"; up to 8 retries over about 24 h | None |
| HubSpot | App-level; every installing account subscribed | `X-HubSpot-Signature-v3` with a 5-min window | 10 retries over 24 h | None |
| Stripe | Event destinations per account | `Stripe-Signature` with timestamp | Retries up to 3 days | None |
| Jira (OAuth apps) | `POST /rest/api/3/webhook` | JWT signed with the client secret | Up to 5 retries; dedupe on `X-Atlassian-Webhook-Identifier` | **Expire after 30 days** |
| Asana | Per resource; `X-Hook-Secret` handshake | `X-Hook-Signature` | "at-most-once"; deleted after 24 h of failures | Heartbeats every 8 h |

**Patterns [inference]**
- One app-level URL (Slack, GitHub App, Linear OAuth app, Notion, HubSpot, Stripe) fits a gateway well.
- Per-resource subscriptions (Gmail, Calendar/Drive, Graph, Jira, Asana) need a renewal scheduler and per-tenant state.
- GitHub, Notion and Asana can lose events, so pair their webhooks with reconciliation polling.
- A self-hosted gateway owns its own provider apps (§4), so app-level webhook URLs point straight at that gateway. No broker relay is needed.

### 7.2 Cloudflare plumbing [inference on live platform facts]

```
provider ──POST /hooks/:provider/:subscriptionId──► gateway
   1. verify signature or JWT (Web Crypto HMAC / JWKS), check timestamp skew
   2. INSERT OR IGNORE trigger_events(provider, delivery_id)   ← dedupe
   3. if inserted: queue.send({provider, delivery_id, subscription_id})   ← at-least-once
   4. 2xx fast (Slack 3 s, Graph 3 s, Linear 5 s)
Queue consumer
   5. load event (small payloads inline; large payloads in R2), resolve trigger_targets
   6. for each app: POST /__everyapp/events over its service binding (system JWT + event id)
   7. record trigger_deliveries; on failure message.retry({delaySeconds}) with backoff; DLQ after N
Workflow "connections-maintenance" (schedules: hourly / daily)
   8. renew expiring watches (Gmail, Graph, Jira), refresh idle connections, reconciliation polls
```

- **Queues:** "at least once delivery… may be delivered more than once"; 128 KB messages; up to 100 retries; retention up to 14 days (24 h on Free); 5,000 msg/s per queue; `delaySeconds` up to 24 h; on Free since 2026-02-04 [live ✓]. Apps must be idempotent on the event id.
- **Workflows:** cron `schedules` on the binding since 2026-06-02 [live ✓]. Paid limits: 10,000 steps (max 25,000), 30 s CPU per step (max 5 min), `step.sleep` up to 365 days, 1 MiB step results [live ✓, 2026-09-21]. Step billing from 2026-08-10: 500k steps/month included, then $0.80 per 100k [live ✓].
- **Fine-grained polling:** a DO alarm per subscription, holding cursors such as Gmail `historyId`, Graph delta links or `updated_since`.

### 7.3 Delivering triggers to agents

- MCP has no unsolicited server-to-agent push. `subscriptions/listen` carries only list-changed and `resources/updated` for subscribed URIs, and the server "MUST NOT send notification types the client has not explicitly requested" [live ✓]. Client support for long-lived subscriptions is unclear.
- **Options [inference]:**
  1. An `events_list(since)` tool and an `events://<provider>` resource that clients can subscribe to.
  2. An internal app as the subscriber, running its own logic or agent.
  3. Later, a gateway-hosted agent or Workflow that reacts and calls tools under a stored grant.

---

## 8. Cloudflare-native pieces (status on 2026-10-12)

| Piece | Status | Use for Connections? |
|---|---|---|
| `@cloudflare/workers-oauth-provider` | v1.0.0 2026-09-24 → v1.2.3 2026-10-07 [live ✓]. Split AS/RS; MCP 2026-07-28; CIMD (incl. `private_key_jwt`); `insufficientScope()`; `describeConsent()`; consent and upstream helpers with `__Host-` cookie binding; experimental ID-JAG; resource URLs with extra query params (1.2.3) | **Use** as the `/mcp` AS (already planned). Gives per-URL tool modes and step-up. Not a third-party token store |
| MCP server portals | GA 2026-09-24. Per-user OAuth to upstreams; admin DCR credential; manual OAuth client credentials (2026-07-31); service tokens; Gateway DLP; Code Mode policies; `minimize_tools`; `{server_id}_{tool}` prefixes; up to 80 servers. Needs a Cloudflare zone, a Zero Trust IdP and Access policies; Logpush is Enterprise-only [live ✓] | **Interoperate, don't depend.** Keep `/mcp` a clean portal upstream (M3-8). Borrow URL-selected modes and minimized listings |
| Access Managed OAuth | Changelog 2026-03-20; docs 2026-07-01. Access as the OAuth AS for apps and MCP servers; RFC 8707 clients; DCR; opaque tokens; origin gets `Cf-Access-Jwt-Assertion`. "Don't enable it if you run your own OAuth server behind Access" [live ✓] | **Skip** for v1; possible enterprise front door later |
| AI Gateway | BYOK provider keys stored in Secrets Store (2025-08-25); spend limits; unified billing [live ✓] | For LLM keys (the existing `providers:["openai"]` path), not SaaS tokens |
| Secrets Store | Open beta; 100 secrets and 1 store per account [live ✓] | Optional home for the KEK and install-level client secrets; never per-user tokens |
| Durable Objects (SQLite) | GA; SQLite DOs on Free; pending I/O keeps DOs alive (2026-10-01) [live ✓] | **Use** for the refresh lock, provider rate limiters and poll cursors |
| Queues | GA; on Free since 2026-02-04; EU/US/FedRAMP jurisdictions (2026-09-18) [live ✓] | **Use** for the webhook ingest buffer and fan-out |
| Workflows | GA; cron `schedules`; `.subscribe()` instance events (2026-09-15); step billing from 2026-08-10 [live ✓] | **Use** for renewals, polling and durable deliveries |
| Agents SDK (`agents` 0.28.0, 2026-10-09) | Weekly releases; MCP client with DCR, elicitation, 2026-07-28 [live ✓] | Skip for the hub core (§3.4); candidate for a future gateway-hosted agent |
| Code Mode (`@cloudflare/codemode` 0.5.3, "Experimental") + Dynamic Workers | `search`/`describe`/`execute`, `McpConnector`, `OpenApiConnector`. `requiresApproval` pauses and `approve()` replays; `reject()` does no rollback [live ✓]. Dynamic Workers: Workers Paid only, $0.002 per unique Worker per day beyond 1,000/month [live ✓]; open beta as of the latest source found [live, sa] | Later, opt-in `?mode=code`, with credentials kept outside the sandbox |

---

## 9. Recommended architecture for gateway Connections

Everything here is [inference] built on the evidence above, shaped to slot into the planned ToolBus (mcp-design §0–§2, §8, §11).

### 9.1 Principles

1. **A connection is not a login.** Third-party accounts live in their own tables. Better Auth stays identity-only.
2. **Connect once, many consumers:** MCP clients (ToolBus), apps (egress proxy, app tools), triggers. Every consumer needs an explicit grant.
3. **Tokens stay in the gateway.** Raw tokens leave only through an audited, opt-in escape hatch.
4. **Least privilege by default.**
   - New connections are read-only for agents.
   - Writes need an explicit switch.
   - Destructive tools stay hidden (D7).
   - Outbound-communication tools go through approval once M3-6 lands.
5. **Provider and spec churn live in gateway code ("provider packs")**, as MCP churn already does (D4).
6. **Stateless request path.** D1 is the source of truth. Durable Objects only coordinate.

### 9.2 Components

```
                  ┌─────────────────────────── gateway Worker ────────────────────────────────┐
 MCP clients ───► │ /mcp  ToolBus (modes: flat | search | code-later)                          │
                  │    ├─ app tools (existing plan, service bindings, identity JWT)            │
                  │    └─ provider tools ─► adapters: curated | upstream MCP (CIMD/DCR/BYO)     │
 browser ───────► │ /settings/integrations, /admin/integrations                                │
                  │ /connect/:provider?i=<intent>  → /oauth/callback/:provider                 │
                  │ /approve/:id (M3-6)                                                        │
                  │ /.well-known/oauth-client/:provider.json  (CIMD for upstream MCP)          │
 providers ─────► │ /hooks/:provider/:subscriptionId ──► Queue "connection-events"              │
 app Workers ───► │ AppGateway entrypoint (props-authenticated):                               │
                  │    connectionFetch() · listConnections() · getAccessToken() [gated]        │
                  │ ConnectionsService ─ D1 (tables in §9.4) ─ ConnectionLock DO (per conn)    │
                  │ ProviderRegistry (code) · Workflow "connections-maintenance"               │
                  └────────────────────────────────────────────────────────────────────────────┘
```

### 9.3 Provider packs

```ts
defineProvider({
  id: "github",                                          // reserved: no app may use a provider id
  auth: [{ kind: "github_app" }, { kind: "oauth2", pkce: true }, { kind: "api_key" }],
  setup: { kind: "github_app_manifest" },                // slack_manifest | google_console_steps | cimd | dcr | paste
  hosts: ["api.github.com", "uploads.github.com"],       // egress allowlist for the app proxy
  scopes: { read: [/* … */], write: [/* … */] },         // drive read/write access levels
  identity: async (token) => ({ externalId, label }),    // who is this account
  revoke: async (conn) => { /* provider revocation endpoint */ },
  webhooks: { verify: verifyGithubSignature, deliveryId: (req) => req.headers.get("x-github-delivery") },
  tools: { source: "upstream_mcp", url: "https://api.githubcopilot.com/mcp/",
           headers: { "X-MCP-Lockdown": "true" }, readOnlyHeader: "X-MCP-Readonly" },
});
```

**Starting set [inference]**

| Provider | Default connection path | Tool source |
|---|---|---|
| GitHub | GitHub App via manifest flow | Vendor MCP with Lockdown/Readonly headers |
| Slack | Internal app via manifest | Curated (or vendor MCP with the internal app) |
| Google (Gmail, Calendar, Drive) | BYO Internal client, guided | Curated |
| Linear | CIMD to vendor MCP | Vendor MCP; API key for org connections |
| Notion | CIMD to vendor MCP | Vendor MCP; internal token for org connections |
| Microsoft 365 | Single-tenant Entra app | Curated (later) |
| Stripe, Sentry, Atlassian | Vendor MCP | Vendor MCP |

### 9.4 Data model (D1, next free migration number)

```sql
-- OAuth apps / clients configured on this install
CREATE TABLE provider_clients (
  id TEXT PRIMARY KEY,                       -- "pcl_" + ULID
  provider TEXT NOT NULL,
  mode TEXT NOT NULL,                        -- byo | github_app | cimd | dcr | broker(later)
  issuer TEXT,                               -- credentials are keyed by issuer (MCP 2026-07-28)
  client_id TEXT,
  secret_enc BLOB,                           -- client secret / App private key / signing secret (encrypted JSON)
  redirect_uri TEXT,
  scope_ceiling TEXT,                        -- JSON: the most anyone may request
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (provider, mode)
);

CREATE TABLE org_keys (                      -- envelope encryption, §3.2
  organization_id TEXT PRIMARY KEY, kek_id TEXT NOT NULL, wrapped_dek BLOB NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE connections (                   -- one connected third-party account
  id TEXT PRIMARY KEY,                       -- "conn_" + ULID
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  owner_kind TEXT NOT NULL,                  -- user | org
  owner_user_id TEXT,                        -- NULL for org-owned (created_by records who)
  auth_kind TEXT NOT NULL,                   -- oauth2 | api_key | github_app_installation | upstream_mcp
  provider_client_id TEXT REFERENCES provider_clients(id),
  audience TEXT,                             -- e.g. https://mcp.linear.app/mcp: proxy-usable only if it covers API hosts
  external_id TEXT NOT NULL,                 -- Google sub, Slack team:user, GitHub installation id…
  label TEXT NOT NULL,                       -- "alice@acme.com", "Acme Slack (bot)"
  scopes TEXT NOT NULL,                      -- JSON, as actually granted
  access_token_enc BLOB, access_expires_at INTEGER,
  refresh_token_enc BLOB, refresh_expires_at INTEGER,
  token_version INTEGER NOT NULL DEFAULT 0,  -- CAS for refresh (§3.3)
  status TEXT NOT NULL,                      -- active | needs_reauth | revoked | error
  status_reason TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_used_at INTEGER, last_refreshed_at INTEGER, revoked_at INTEGER,
  UNIQUE (organization_id, provider, owner_kind, owner_user_id, external_id)
);

CREATE TABLE connection_grants (             -- who/what may use a connection
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  grantee_kind TEXT NOT NULL,                -- member | role | app
  grantee_id TEXT NOT NULL,                  -- user id | "admin"/"member" | app_row_id
  access TEXT NOT NULL,                      -- read | write
  background INTEGER NOT NULL DEFAULT 0,     -- app may use it without a live user request
  granted_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);
-- A user's own connection is usable by that user's MCP clients without a grant row.
-- Apps always need a grant row: admin-approved for org connections, user-approved for user connections.

CREATE TABLE connect_intents (               -- single-use connect links (§9.5 A)
  id TEXT PRIMARY KEY,                       -- opaque, 128-bit random
  organization_id TEXT NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL,
  scopes TEXT NOT NULL, mcp_grant_id TEXT, return_hint TEXT,
  expires_at INTEGER NOT NULL, consumed_at INTEGER
);

-- MCP consent covers integrations next to apps (rename planned mcp_connections → mcp_grants)
CREATE TABLE mcp_grant_providers (
  mcp_grant_id TEXT NOT NULL, provider TEXT NOT NULL, PRIMARY KEY (mcp_grant_id, provider)
);

CREATE TABLE provider_tools (                -- pinned catalogs for upstream sources (curated packs ship in code)
  provider TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,     -- upstream_mcp | openapi
  description TEXT NOT NULL, input_schema TEXT NOT NULL, risk TEXT NOT NULL,
  upstream_hash TEXT NOT NULL, approved_hash TEXT, status TEXT NOT NULL, -- active | pending_review | blocked
  first_seen_at INTEGER NOT NULL, changed_at INTEGER,
  PRIMARY KEY (provider, name)
);

CREATE TABLE trigger_subscriptions (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- webhook | poll
  external_ref TEXT, secret_enc BLOB, events TEXT NOT NULL, cursor TEXT,
  expires_at INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE trigger_targets (subscription_id TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  filter TEXT, PRIMARY KEY (subscription_id, target_kind, target_id));
CREATE TABLE trigger_events (provider TEXT NOT NULL, delivery_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
  type TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (provider, delivery_id));
CREATE TABLE trigger_deliveries (provider TEXT NOT NULL, delivery_id TEXT NOT NULL, target_id TEXT NOT NULL,
  attempts INTEGER NOT NULL, status TEXT NOT NULL, last_error TEXT, delivered_at INTEGER,
  PRIMARY KEY (provider, delivery_id, target_id));

-- Audit additions: mcp_tool_calls is still a plan (mcp-design §11), so fold these columns into its CREATE
ALTER TABLE mcp_tool_calls ADD COLUMN connection_id TEXT;
ALTER TABLE mcp_tool_calls ADD COLUMN provider TEXT;
ALTER TABLE mcp_tool_calls ADD COLUMN approval_id TEXT;
CREATE TABLE connection_events (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, organization_id TEXT NOT NULL, connection_id TEXT,
  actor_kind TEXT NOT NULL,                  -- user | admin | app | agent | system
  actor_id TEXT, tool_call_id TEXT,          -- link to mcp_tool_calls via identity JWT tc.id
  event TEXT NOT NULL,                       -- created | scopes_changed | grant_added | grant_revoked | refresh_failed
                                             -- | needs_reauth | revoked | token_disclosed | proxy_write | catalog_changed
  detail TEXT                                -- never tokens, never raw arguments
);
CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,   -- ~15 min
  organization_id TEXT NOT NULL, user_id TEXT NOT NULL, credential_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, connection_id TEXT, args_digest TEXT NOT NULL, args_enc BLOB NOT NULL,
  status TEXT NOT NULL,                      -- pending | approved | denied | expired | consumed
  decided_by TEXT, decided_at INTEGER
);
```

High-volume app-proxy reads go to counters (Analytics Engine, or an hourly aggregate row), not one D1 row per GET. Writes always get a `connection_events` row.

### 9.5 Flows

**A. Connect: from settings, or from inside an agent session**
1. **Trigger.**
   - From settings: the user clicks "Connect Gmail" on `/settings/integrations`.
   - From an agent: a tool needs a connection the user lacks. The gateway creates a `connect_intents` row (user, org, provider, minimal scopes, 10-min TTL) and answers in one of three ways:
     - **2026-07-28 clients that declare `elicitation.url`:** MRTR `input_required` with `{mode:"url", url:"https://<gw>/connect/gmail?i=<id>"}` and an AEAD-sealed `requestState` naming the user, the intent and a digest of the original call.
     - **MCP Apps hosts:** a small card that calls `ui/open-link` on the same URL.
     - **Everyone else:** an `isError` tool result: "Gmail isn't connected. Ask the user to open <url>, then try again."
2. **Same-user check.** `GET /connect/gmail?i=…` requires a gateway session and refuses unless `session.user == intent.user` (spec phishing rule). It shows "Connect a Google account to Every App (<org>) with: read your email".
3. **Redirect to the provider.** On POST, mint `state` and a PKCE verifier and set a `__Host-` cookie, **only now** (after the user confirmed). Then 302 to the provider using the install's client (BYO or CIMD), with `access_type=offline` and incremental scopes.
4. **Callback.** `/oauth/callback/gmail` checks `state` against the cookie (single use), checks `iss` where the provider sends it, exchanges the code, and fetches identity (Google `sub` and email).
5. **Store.** Upsert the connection (dedupe on `external_id`), encrypt the tokens, record the granted scopes (they may be fewer than requested), write the `created` event, and mark the intent consumed.
6. **Back to the agent.** Show "Done, return to Claude". The client retries (MRTR), or the user says "continue" and the agent calls again.

**B. Token use and refresh**
1. Load the connection row (already read for authorization). If the access token has more than 120 s left, decrypt it and use it; cache by `(connection_id, token_version)` in isolate memory for a few minutes.
2. Otherwise call `ConnectionLock.refresh(id, seenVersion)` (§3.3). On `invalid_grant`, set `needs_reauth`, notify the owner, and surface a connect link (flow A) on the next call.
3. On an upstream 401 with a token that should still be valid, force one refresh, then fail with `needs_reauth`.

**C. Agent tool call (ToolBus)**
1. Authenticate as planned (OAuth or PAT → principal). Visible tools = app tools for the grant's apps, plus provider tools for the grant's providers where the user has an eligible connection. Non-active upstream tools are filtered out.
2. **Resolve the connection.** Use the user's own connection for the provider; otherwise an org connection granted to the user or their role. If more than one is eligible, the tool schema gets an `account` enum of labels (per-principal `tools/list` is allowed by the spec).
3. **Policy:**
   - risk (`read` / `write` / `destructive`, upstream default `write`) × grant access × org overrides × connection grant access.
   - Then `allow`, `hide`, or `require_approval` (M3-6).
4. **Approval** (when required). Write a `pending_approvals` row and return an approval prompt the same three ways as flow A, pointing at `/approve/<id>`. The page requires the gateway session of the same user (or an admin approver), shows the server-built call and its arguments, and records the decision. The retried call (`requestState`, or `approval_id` in the arguments for legacy clients) must match `args_digest` and consumes the approval once.
5. **Execute** with the token from flow B through the adapter: curated code, or the upstream MCP client with `X-MCP-Readonly` set on read-only grants. Map the result, cap its size, and label untrusted third-party content.
6. **Audit.** `waitUntil` writes the `mcp_tool_calls` row with `connection_id`, `provider`, `approval_id`, `decision` and `outcome`; arguments are stored only as a digest (D8).

**D. App call (egress proxy):** see §6. Each gateway check maps to a table: `connection_grants`, `connections.audience`, provider hosts, and the identity JWT's `chan`/scopes/`tc`.

**E. Webhook → app:** see §7.2. Subscriptions are created when an app with a matching manifest `triggers:` entry is granted the connection; deleted when the grant or connection is revoked.

**F. Revoke and offboarding**
- **User removes a connection:** call the provider's revocation endpoint (pack `revoke`), null the token columns, set `revoked`, delete its trigger subscriptions, write the event, send `tools/list_changed` to listeners.
- **Member leaves the org** (M1-7): revoke their user-owned connections in that org. Org-owned connections they created stay but are flagged for admin review.
- **Admin "revoke all" runbook:** loop the revocation endpoints, rotate the KEK, re-wrap DEKs.

### 9.6 Where approvals and audit hook in

| Hook point | Approval | Audit |
|---|---|---|
| ToolBus `tools/call` | Policy → `require_approval` → pending approval (§9.5 C4). Client hints: `requiresUserInteraction` (Claude Code), `destructiveHint`/`readOnlyHint` (ChatGPT, claude.ai) | `mcp_tool_calls` row per call |
| App egress proxy | No interactive approval (apps own their UX); grant access enforced; agent scopes carried through `chan:"mcp"` JWTs | `connection_events` for writes; counters for reads |
| Connect / grant / revoke | Admin approval for org connections and app grants | `connection_events` |
| Upstream catalog change | Admin review of `pending_review` tools | `connection_events: catalog_changed` |
| Triggers | Admin approves an app's trigger subscription with its grant | `trigger_deliveries` |

### 9.7 Build order and what to defer [inference]

| Phase | Scope | Relative size |
|---|---|---|
| 1 (with ToolBus v1) | Tables, envelope encryption, `ConnectionLock`; `/settings/integrations` and `/admin/integrations`; connect flow with link fallback; GitHub (App manifest), Slack (internal app manifest), Google (Internal client, curated Gmail/Calendar read tools); `flat`/`search` modes; audit columns | L |
| 2 | App egress proxy plus manifest `connections:`; app grants; vendor MCP via CIMD (Linear, Notion) with pin-and-diff; MRTR URL elicitation; daily maintenance Workflow | M–L |
| 3 | Approvals (M3-6) with link, MRTR and MCP Apps card; app-level webhooks (GitHub, Slack, Linear, Stripe) → Queue → apps | M |
| Later | Code mode on Dynamic Workers; Gmail/Graph/Jira subscriptions with renewals (poll first); Microsoft 365 pack; OpenAPI long tail; hosted broker (opt-in, never Google restricted); ID-JAG in and out; `CredentialSource` adapters (WorkOS, Auth0); Skills over MCP guides | — |

**Explicitly not doing:**
- Google domain-wide delegation, a service-account key that can read every mailbox.
- Storing third-party tokens in Better Auth `account` rows.
- Passing the MCP client's token upstream.
- Returning raw tokens to apps by default.

---

## 10. The biggest risks and how to de-risk them

| # | Risk | Why it's real | De-risk |
|---|---|---|---|
| 1 | **Prompt-injection exfiltration across connected tools** (lethal trifecta) | One agent sees private mail and repos, reads attacker-controlled content (emails, public issues), and can send (Gmail, Slack, PR comments). The GitHub "toxic agent flow" worked through fully trusted tools [live ✓] | Read-only default per connection. Approvals for outbound-communication tools, at least for external recipients. Per-session scoping options. Vendor knobs (`X-MCP-Lockdown`). Label untrusted content. Audit plus anomaly alerts (sudden volume, new recipients). Red-team test cases in CI |
| 2 | **Credential custody concentration** | The gateway holds every org's refresh tokens; one RCE or key leak is a mass compromise | Envelope encryption with the KEK outside D1. No raw tokens to apps by default; `redirect:"manual"`. Minimal scopes with step-up. Tokens never logged. `global_fetch_strictly_public`. Revoke-all runbook. A security review before GA |
| 3 | **Google and Microsoft setup walls break "integration hub by default"** | Consumer Gmail with restricted scopes needs verification and an annual assessment. Workspace MCP is Developer Preview. Work IQ needs Copilot licenses. Testing mode kills tokens after 7 days [live ✓ / sa] | Lead with Internal (Workspace) clients and a guided wizard. Prefer `gmail.send` (sensitive) and `drive.file` (non-sensitive) where enough. Warn loudly about Testing mode. Ship CIMD-ready vendors (Linear, Notion, Stripe, Sentry…) and API-key connections so the hub works on day one without Google. Don't broker Google |
| 4 | **Upstream drift, poisoning and maintenance load** | Vendors change tools and auth on their own schedule (Asana V1 shutdown, Stripe key change 2026-10-31, Atlassian v2, Salesforce metadata breakage); real rug pulls exist (`postmark-mcp`) | Pin-and-diff catalogs with quarantine. A small curated core. Contract tests per provider pack. A feature flag per provider. A `connection_events` alert on catalog change |
| 5 | **Client capability fragmentation** | No elicitation on claude.ai/Desktop. Tools deferred to bare names. Instructions dropped. VS Code can hang on `-32042`. Hard tool caps | Link fallback everywhere. Per-grant tool modes. Self-describing names. An MCP Apps card where supported. A test matrix (claude.ai, Claude Code, ChatGPT, Cursor, VS Code) in the M3 acceptance tests |
| (6) | Refresh-token races and silent evictions | GitHub single-use refresh with no grace; per-client token caps | `ConnectionLock`; one grant per user per provider; health cron; reconnect UX |

---

## 11. Open questions and things not verified

- **Hosted Claude.** How claude.ai, Desktop and mobile behave at runtime with elicitation, and which MCP protocol version they negotiate. Nothing is documented; untested.
- **ChatGPT.** URL elicitation, tool-count limits, and the confirmation rules in developer mode (help pages returned 403).
- **Vendor CIMD acceptance.** Whether vendors that advertise CIMD/DCR (Linear, Notion, Sentry, Atlassian…) accept an arbitrary self-hosted gateway domain in practice. Needs a live test with a throwaway install.
- **Google.** CASA cost and tier for a restricted-scope External app (no primary source found); the exact Calendar watch lifetime; whether the Gmail Pub/Sub topic must live in the same project as the OAuth client.
- **Salesforce.** External Client App policies (developer.salesforce.com returned 403).
- **Slack.** Whether `apps.manifest.create` returns the client secret and signing secret in all cases (sub-agent says yes; I didn't re-verify).
- **Dynamic Workers.** Exact GA status.
- **WorkOS Pipes.** Pricing.
- **Token audiences.** Whether vendor-MCP OAuth tokens (e.g. Linear's) also work on the vendor's REST/GraphQL API. Design assumes they may not (`audience` column).
- **`ctx.props` trust under granular Worker permissions** (2026-09-15). Whether a teammate who can deploy only app X could forge another app's props on the gateway binding. Docs say props can only be set by someone who can deploy the worker "to which it is being delivered"; worth a spike.

---

## Sources

**Every App (read in repo)**
- `docs/research/2026-10-platform-review/impl/mcp-design.md`; `raw/ref-executor.md` §8; `raw/ref-cloudflare-os.md`; `raw/cf-agents-mcp-ai.md`
- `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`, `ai-proxy.ts`, `src/server.ts`; `packages/perimeter/src/manifest/manifest.ts`; `packages/cli/src/lib/generateWranglerConfig.ts`

**MCP specification and extensions**
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions
- https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- https://modelcontextprotocol.io/extensions/client-matrix
- https://modelcontextprotocol.io/extensions/apps/overview
- https://modelcontextprotocol.io/extensions/skills/overview
- https://github.com/modelcontextprotocol/ext-apps (specification/2026-01-26/apps.mdx)
- https://blog.modelcontextprotocol.io/posts/2026-07-28/ [sa]
- https://github.com/anthropics/claude-ai-mcp/issues/153

**Clients and tool counts**
- https://code.claude.com/docs/en/mcp
- https://support.claude.com/en/articles/13730515-manage-claude-s-tool-access
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool [sa]
- https://www.anthropic.com/engineering/advanced-tool-use [sa]
- https://www.anthropic.com/engineering/code-execution-with-mcp [sa]
- https://developers.openai.com/api/docs/guides/tools-tool-search
- https://cursor.com/blog/dynamic-context-discovery [sa]
- https://code.visualstudio.com/docs/agents/run/tools [sa]
- https://github.com/cloudflare/mcp [sa]
- https://www.stainless.com/products/mcp
- https://arxiv.org/abs/2505.03275, https://arxiv.org/abs/2508.01780 [sa]

**Cloudflare**
- https://developers.cloudflare.com/changelog/rss/index.xml (2025–2026 entries cited by slug)
- https://developers.cloudflare.com/changelog/post/2026-10-01-workers-oauth-provider-1x/
- https://github.com/cloudflare/workers-oauth-provider (releases v1.0.0–v1.2.3; docs/upstream-sign-in.md, advanced-configuration.md)
- https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
- https://developers.cloudflare.com/changelog/post/2026-07-31-mcp-portal-manual-oauth/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- https://developers.cloudflare.com/secrets-store/ (and /manage-secrets/, /integrations/workers/)
- https://developers.cloudflare.com/agents/model-context-protocol/mcp-client-api/
- https://developers.cloudflare.com/agents/api-reference/codemode/
- https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
- https://developers.cloudflare.com/dynamic-workers/pricing/
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
- https://developers.cloudflare.com/workers/runtime-apis/context/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- https://developers.cloudflare.com/queues/platform/limits/
- https://developers.cloudflare.com/workflows/reference/limits/

**Providers**
- https://developers.google.com/workspace/gmail/api/auth/scopes
- https://developers.google.com/workspace/guides/configure-mcp-servers
- https://developers.google.com/identity/protocols/oauth2 [sa]
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification [sa]
- https://docs.slack.dev/ai/slack-mcp-server
- https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
- https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests
- https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
- https://github.com/github/github-mcp-server (README, docs/remote-server.md)
- https://linear.app/developers/oauth-2-0-authentication [sa]
- https://linear.app/docs/mcp [sa]
- https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens [sa]
- https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview [sa]
- https://support.atlassian.com/atlassian-rovo-mcp-server/ [sa]
- https://docs.stripe.com/mcp [sa]
- Webhook docs for Slack, GitHub, Linear, Gmail, Graph, Notion, HubSpot, Stripe, Jira, Asana [sa; URLs in §7.1 provenance]

**Vaults and brokers**
- https://auth0.com/docs/secure/tokens/token-vault [sa]
- https://workos.com/docs/pipes [sa]
- https://nango.dev/pricing [sa]
- https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app.md [sa]
- https://pipedream.com/docs/connect/managed-auth/oauth-clients [sa]
- https://arcade.dev/pricing [sa]
- Home Assistant: https://github.com/home-assistant/core/blob/dev/homeassistant/components/cloud/account_link.py, https://github.com/NabuCasa/hass-nabucasa/blob/main/hass_nabucasa/account_link.py, https://account-link.nabucasa.com/services, https://www.home-assistant.io/integrations/google_mail/
- https://github.com/googleworkspace/cli (README)

**Security incidents and analysis**
- https://invariantlabs.ai/blog/introducing-mcp-scan
- https://invariantlabs.ai/blog/mcp-github-vulnerability
- https://thehackernews.com/2025/09/first-malicious-mcp-server-found.html
- https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/

**Packages read (source)**
- `better-auth@1.7.7` (npm tarball: `dist/api/routes/account.mjs`, `dist/oauth2/link-account.mjs`, `dist/oauth2/utils.mjs`, `dist/crypto/index.mjs`)
- `agents@0.28.0` (`do-oauth-client-provider` d.ts)
- `@modelcontextprotocol/client@2.3.1` (`index.d.mts`)
- `@cloudflare/workers-oauth-provider` main at v1.2.3
