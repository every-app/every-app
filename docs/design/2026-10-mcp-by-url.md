# MCP apps by URL: any remote MCP server becomes an MCP app on a gateway

Date: 2026-10-25. Status: being built (the PRs are listed in section 12 as they open). Follows [2026-10-mcp-provider-apps.md](2026-10-mcp-provider-apps.md) (the tier, #485 and #489) and [2026-10-mcp-apps-ui.md](2026-10-mcp-apps-ui.md) (the name, the launcher section, the dialog, #599), and builds the "PR 3: remote-MCP proxy kind" and the "`everyapp mcp add <url>`" sketch those two planned, made registrable at run time.

## 1. The ask

Ben, 2026-10-24: "assume we want all of this and build the best, most robust thing we're going to want long term, so that when we launch on Monday people can just run with it and they're not waiting on us for PRs." The ask: `everyapp mcp add <url>` (and the same from Admin → Apps and from an agent over `/mcp`) registers any remote MCP server as an MCP app of the gateway's: its tools reach members' AI clients through the gateway's one `/mcp` under `<id>_<tool>` names, with the gateway holding the server's credential, every call attributed, audited, counted and capped like an app's, read and write told apart, and the operator able to turn tools or the whole app off.

## 2. What a remote MCP app is

A remote MCP app is an `apps` row of tier `provider` (`PROVIDER_APP_TIER`), exactly like a built-in provider app (DataForSEO): no hostname, no Worker, `status` `active` from the start, the generated manifest, access for the person adding it and the organization's owners and admins. What differs is the manifest's `remote` block, which is the registration record, and who serves it: the gateway's in-process remote app (`apps/every-app-gateway/src/server/remote-mcp/`) instead of a tool set compiled into the gateway. The two kinds are told apart by `remoteMcpOf(manifest)` (`@every-app/sdk/internal`): a provider row whose manifest has a `remote` block is remote; one whose slug is in `PROVIDER_APPS` is built-in. A remote app's id can never be a built-in's id or a deployed app's id (`APP_TIER_MISMATCH`, tombstones included, as for built-ins).

### The manifest

```jsonc
{
  "id": "treg",
  "name": "Treg",
  "description": "Treg's MCP server (https://treg.to/mcp/), served through this Gateway.",
  "remote": {
    "url": "https://treg.to/mcp/",
    "auth": { "kind": "bearer", "secret": "TREG_MCP_TOKEN" },
    "risk": "annotations",
    "tools": { "delete_everything": { "risk": "destructive" }, "noisy_tool": { "enabled": false } },
    "rev": 3
  }
}
```

- `url`: the one address the gateway ever sends the credential to, and the only origin it fetches from. `https:` only, no credentials in the URL, no fragment; `http:` and `localhost`/loopback are allowed only when the gateway's own `GATEWAY_URL` is `http://` (local dev, the same rule as `DATAFORSEO_SANDBOX`). Refused (`REMOTE_MCP_URL_REFUSED`): the gateway's own origin and its app hosts (`APP_BASE_DOMAIN`, `THIRD_PARTY_DOMAIN`), IP literals, the provider hosts whose keys the gateway holds (`api.openai.com`, `openrouter.ai`, `api.dataforseo.com`, `api.context.dev`, `gateway.ai.cloudflare.com`, `api.cloudflare.com`) and the OAuth token endpoints of the clients it holds. Pure: `remoteMcpUrlProblem(url, { gatewayUrl, appBaseDomain?, thirdPartyDomain? })`.
- `auth`: one object, `kind` discriminated, agreed with the provider registry thread so a provider entry reads the same:
  - `{ kind: "none" }`: a public server; nothing to set.
  - `{ kind: "bearer", secret }`: `Authorization: Bearer <value>`.
  - `{ kind: "header", secret, header, prefix? }`: `<header>: <prefix><value>`; `header` is a token-character header name that is not `Authorization`, `Cookie`, `Host`, a `Mcp-*` routing header or one the gateway sets.
  - `{ kind: "basic", secret }`: the value is `user:password`, sent as `Authorization: Basic <base64>`.
  - `{ kind: "oauth" }`: not served this week. The row can be added (so the UI and `mcp show` say what it needs), the app shows "Not supported yet: this server wants OAuth" and serves no tools; see section 10.
  - `secret` is always the NAME of a Gateway setting, never a value. Every remote app credential name is in the family `<ID>_MCP_TOKEN` (`/^[A-Z][A-Z0-9_]*_MCP_TOKEN$/`, `isRemoteMcpSecretName`); the default is the app id upper-cased with `-` as `_` (`remoteMcpSecretName(id)`); `--secret NAME` may choose another name in the family and nothing else. The family is a static rule, so `everyapp secret set` routes such a name to the Gateway without reading the registry, the manifest validator refuses an app's own secret in it, and an admin who adds a remote server from the UI can never point an existing provider key (`OPENAI_API_KEY`) at their own URL.
- `risk`: how a tool's risk is decided when the upstream's annotations don't say. `annotations` (the default): `readOnlyHint: true` is `read`; `destructiveHint: true` (explicitly) is `destructive`; anything else is `write`. The spec's missing-means-true defaults would make every unhinted tool destructive and hide it; the gateway reads a missing hint as "unknown" and unknown as `write`, so an unhinted tool is callable by a read & write member and never by a read-only one. `write`: every tool is `write` whatever it says. `read`: every tool is `read` (for a server the operator knows only reads: a docs or search server that never annotates).
- `tools`: per-tool overrides keyed by the upstream's own tool name: `risk` (`read` | `write` | `destructive`; wins over `risk` above) and `enabled: false` (left out of the gateway's catalog; a call answers Unknown tool). Names the upstream no longer lists are kept and ignored.
- `rev`: a counter the CLI and the UI bump on every change of the block, so the snapshot's version (`remote:<rev>`) differs and the gateway re-lists on first use.

### The credential and where it is pinned

The credential is a Gateway Worker secret, set with `everyapp secret set <NAME>` as every provider key is (never from the UI, never over MCP; a value never reaches an AI client, an audit row, a log line, an error message or a result). The settings model reads the manifest's `remote.auth.secret` as one required Gateway setting (`kind: "remote-mcp"`, holder `gateway`, setup `setup/remote-mcp.md`), so until it is set the app needs setup like any app: its tools are left out of `/mcp`, `everyapp_list_apps` names the command, the launcher and Admin → Apps show "Needs setup" with the setup dialog; `auth.kind: "none"` needs nothing and serves at once.

A credential name is bound to the origin it was set for. `everyapp secret set TREG_MCP_TOKEN` reads the registry row that declares the name and records `(name, origin, bound_by, bound_at)` in the gateway's D1 (`remote_mcp_credentials`, migration 0011); a gateway that finds a set credential with no binding binds it to the row's origin on first use and logs `mcp.remote.credential_bound` (a dashboard-set secret keeps working). The gateway sends a credential only to the origin it is bound to: a row whose `remote.url` origin differs reads as needing setup, with the reason "its credential was set for https://treg.to; run `everyapp secret set TREG_MCP_TOKEN` again" (only the operator can). So an owner or admin who re-points a row, or removes one and adds another with the same id, can never make the gateway send a credential somewhere the operator didn't set it for. (`everyapp mcp remove` leaves the secret and its binding; `everyapp secret unset NAME` removes both.)

## 3. Serving it: the proxy

`appFetcherFor` (toolbus/catalog-sync.ts) resolves a provider row whose manifest has a `remote` block to `remoteMcpAppFetcher(route)`: an in-process `AppFetcher` that answers the internal tools contract (`/__everyapp/tools/list`, `/__everyapp/tools/call`) itself, with the SDK's own verification (`verifySystemJwt` for the list, `verifyIdentityJwt` for a call: `chan: "mcp"`, the `tc` claim naming this call, `aud` `provider:<row id>` as for a built-in, the gateway's public key). Nothing about identities, policy, audit or usage changes: the ToolBus, the catalog sync, `executeToolCall`, the audit row with `via`, the compact surface and the search see a provider app like any other.

### The client (`packages/toolbus/src/remote/`)

A dependency-free Streamable HTTP client, pure (no `cloudflare:workers`), so the gateway, unit tests and the `claude -p` harness share it:

- `POST` only, `Accept: application/json, text/event-stream`, a JSON body per request, `redirect: "manual"` (a 3xx is a failure: "the server redirected; the gateway follows no redirects"), the credential on every request to the registered URL and nowhere else, `MCP-Protocol-Version` on every request.
- Eras. First the 2026-07-28 era as the ToolBus itself serves it: per-request `Mcp-Method`/`Mcp-Name` headers and `_meta` (`io.modelcontextprotocol/protocolVersion`, `clientInfo: { name: "every-app-gateway", version }`, `clientCapabilities: {}`), no session. When the server refuses it (an HTTP 4xx, a JSON-RPC `-32601`/`-32600`/`-32000` on `tools/list`), the 2025 era: `initialize` asking `2025-11-25` (accepting `2025-06-18` and `2025-03-26` back), `notifications/initialized`, the `Mcp-Session-Id` kept per isolate and re-initialized once on a 404. The era and session are cached per row for the isolate's life; a changed `rev` resets them.
- Answers may be JSON or SSE: the SSE frames are read until the message with the request's id arrives, notifications in between are dropped (progress, logging), and the body is read capped either way.
- Capabilities declared: none. No `sampling`, `elicitation`, `roots` or tasks; a server that asks (an `elicitation/create` or `sampling/createMessage` request in the SSE stream, a task result) gets a JSON-RPC error back and the call fails as a tool error "the server asked for something this gateway doesn't do".
- Limits: `tools/list` 15 s and 5 MiB in all (following `nextCursor` to the end, at most 20 pages); a call 25 s of the ToolBus's 30 s and 768 KiB of answer (the cap `call.ts` uses), cancelled upstream through the ToolBus's abort signal.
- Errors never carry the credential, the request headers or the upstream's body verbatim: the tool error is one sentence naming what happened (`<name> answered 503.`, `<name> did not answer in time.`, `<name> could not be reached.`, `<name> rejected the credential (401); its operator sets <NAME> with everyapp secret set.`), and the log line `mcp.remote.upstream_failed` carries the status and a 200-character head of the body with any `Authorization` or the credential's value removed.

### The catalog

`tools/list` (the contract) is the upstream's `tools/list` normalized: each upstream name becomes the ToolBus's shape (`normalizeRemoteToolName`: lowercase, `-`, `.` and spaces as `_`, camelCase split, non-alphanumerics dropped, 48 characters at most); a collision between two normalized names drops both with a warning (`skipped: two tools normalize to "get_user"`); an override's `enabled: false` leaves the tool out; `risk` is decided as section 2 says; `title`, `description`, `inputSchema` and `outputSchema` pass through (the ToolBus's own limits and its `x-mcp-header` stripping still apply), `annotations.idempotentHint`/`openWorldHint` pass through; the upstream's `instructions` from `initialize`/`server/discover` become the app's. The contract's `hash` is `catalogHash()` over the normalized list, so a changed upstream list changes the hash: the next call's answer carries it, the ToolBus notices drift and re-syncs; the hourly cron (`runMcpMaintenance`) re-lists every active remote app whose snapshot is older than an hour; `everyapp mcp refresh <id>`, Admin → Apps "Refresh tools" and `everyapp_mcp_refresh` re-list on demand. Every listing also writes `remote_mcp_tools` (migration 0011): per upstream tool, its server name, its ToolBus name or why it has none, what its annotations said and whether it is listed, which is what `everyapp mcp show`, the MCP app dialog and `everyapp mcp tool` read to show a risk's source and to key an override by the server's name. A re-list whose tool names differ from the snapshot's logs `mcp.remote.tools_changed` with `added`/`removed` (the events thread's `app.tools_changed` rides this with `kind: "remote"`). The upstream list and the local→upstream name map are cached per isolate (the upstream's 2026-07-28 `ttlMs` if it sends one, else 10 minutes); a call for a local name the cache doesn't know re-lists once before answering `unknown_tool`.

### A call

`tools/call` (the contract): verify the identity; map the local name to the upstream's through the cache; refuse a tool whose effective risk needs a scope the identity lacks (`forbidden`, as the SDK does); check the organization's monthly cap on the row (`checkMonthlyCap`, the same rule as built-ins); forward `tools/call { name: <upstream>, arguments }` with the credential; relay the result's `content` blocks (text, image, audio, resource: as they are, the 768 KiB cap on the whole), `structuredContent` and `isError`, and nothing else (no `_meta` from the upstream except `com.everyapp/*` keys, no tasks); count the call in `usage_daily`/`usage_monthly` (`kind` `capability`, `target` `mcp:<id>`, the row as the app, the member as the user; `failures` when the upstream errored or `isError`). The member's own token never goes upstream (the spec forbids passthrough, and the gateway never had it).

## 4. Registering it

Three doors, one rule set (`packages/perimeter/src/registry/remoteMcpApps.ts`, pure functions beside `providerApps.ts`): `planRemoteMcpAppAdd` (the row, the grants, the refusals), `remoteMcpAppUpdate` (the `remote` block changed, `rev` bumped), `mcpAppStatusUpdate` (`active` ↔ `disabled`), and `providerAppOffUpdate` renamed in meaning to `mcpAppRemoveUpdate` (the tombstone, for both kinds).

- `on` and `off` change meaning for both kinds: `on` serves (a built-in's first `on` still creates its row; a disabled row becomes `active`), `off` stops serving (`status` `disabled`: the ToolBus and the launcher already leave a non-active row out; access, tokens and the snapshot are kept, so `on` is instant). `remove` is the tombstone `off` used to be (access, tokens, snapshot and AI connections go; the secret stays). Documented as a change to #599's `off`.
- The CLI (`packages/cli/src/commands/provider/`, group `everyapp mcp`; `provider` stays an alias through launch week): `add <url> [--name <id>] [--auth none|bearer|header|basic|oauth] [--header <name>] [--secret <NAME>] [--risk annotations|read|write]`, `remove <id>`, `on <id>`, `off <id>`, `list` (columns APP, KIND built-in | remote, STATUS on | off | needs setup, TOOLS, KEY), `show <id>` (the URL, the auth kind, the credential's name and whether it is set and bound, status, when the tools were last listed and the error if the last listing failed, then every tool: listed name, upstream name, risk with its source (`hint`, `app`, `override`), on or off), `refresh <id>` (drops the snapshot so the gateway re-lists on the next request or within the hour), `tool <id> <tool> [--risk read|write|destructive|annotations] [--on|--off]`. `add` derives `--name` from the URL's host (`treg.to` → `treg`), refuses a taken id, probes the URL once without a credential to say what it found (reachable, which era, how many tools, or "wants OAuth" from a `WWW-Authenticate` with `resource_metadata`, or unreachable: a warning, never a refusal, since the operator may be adding a server the laptop can't reach), and in a terminal offers to set the credential now (`secret set`, hidden input, the same path `configure` uses). Every write goes to the Gateway's D1 under the Cloudflare login (ADR-0003) and ends with `// events: mcp_app.added|removed|enabled|disabled` at the write (the events thread wires it).
- The UI: Admin → Apps → Add app gets a row "Add an MCP server" (the same chooser as the four apps and Build your own) opening a form with the same fields as the CLI (URL, name, auth kind, header name, credential name prefilled and editable within the family, risk default); the server function `addRemoteMcpApp` (owner or admin) runs the same rules; the result view says what to do next (`pnpm everyapp secret set TREG_MCP_TOKEN` for a credentialed server; for `none`, the gateway lists the tools in the same request and the view shows the count). An MCP app's row on Admin → Apps opens an "MCP app" dialog (replacing the edit modal's content for the kind): the URL and auth, the credential's state, status with Turn on/off, Refresh tools, the tools table (name, title, risk with a per-tool select, on/off switch), Remove. The launcher card keeps the "Use it from your agent" dialog, with a generic example sentence for a remote app (`list the tools <name> offers`). Server functions: `addRemoteMcpApp`, `updateRemoteMcpApp` (overrides, risk default), `setMcpAppStatus`, `removeMcpApp`, `refreshMcpAppTools`, `getMcpApp` (the tools with their sources), owner or admin; `removeMcpApp` owner only, like delete.
- The agent: `everyapp_mcp_add`, `everyapp_mcp_remove`, `everyapp_mcp_on`, `everyapp_mcp_off`, `everyapp_mcp_list`, `everyapp_mcp_show`, `everyapp_mcp_refresh`, `everyapp_mcp_tool`, workspace tools on the seam #614 built (`WORKSPACE_TOOLS` definitions in `packages/toolbus/src/workspace.ts`, handlers through `ToolBusDeps.workspace.run`), `minRole` `admin` (`remove`: `owner`), hidden from lower roles like the other workspace tools, never taking or returning a credential (`secret` is the NAME only; the answer names the command). PR 5 stacks on #614.

## 5. Safety

- Outbound: one URL per row, pinned at registration and checked again at every fetch (`remoteMcpUrlProblem` on the stored URL, so a row edited by hand in D1 is still refused); no redirects; `https:` outside local dev; the credential bound to the origin (section 2); the credential never in a log, an error, an audit row or a result; no cookies, no other headers of the gateway's (the gateway's own request headers are never forwarded).
- Inbound: the upstream's tool schemas and descriptions are untrusted text the ToolBus already bounds (sizes, `x-mcp-header` stripped, unusable schemas skipped); a description can't make the gateway do anything, and the risk the upstream claims only ever loosens to `read` when `readOnlyHint` is explicitly true; the operator overrides per tool or per app.
- Who can register: owners and admins (the UI, the agent tools), the operator (the CLI). Members never. A read-only connection never sees the write tools, as with every workspace tool.
- Per-app off; per-tool off; the organization's monthly cap counts every forwarded call; the ToolBus's 30 s and 1 MiB stand.
- The threat model register gets rows under B4 (`remote-mcp.credential-only-to-bound-origin`, `remote-mcp.url-pinned-no-redirect`, `remote-mcp.credential-never-leaks`, `remote-mcp.secret-name-family`) and B5 (`remote-mcp.risk-conservative-default`, `remote-mcp.identity-verified-per-call`, `remote-mcp.admin-registration-role-gated`), each with its test.

## 6. Tool count

A remote app's tools list in full under `<id>_<tool>` like any app's; the compact surface (#567) takes over past 256 entries or 1 MiB, and `everyapp_search_tools` covers them from `app_tools`. The per-tool `enabled: false` override is the operator's allowlist.

## 7. Events

Agreed with the events thread: `mcp_app.added` (kind `remote` | `builtin`), `mcp_app.removed`, `mcp_app.enabled`, `mcp_app.disabled`, and `app.tools_changed` with `kind: "remote"` from catalog-sync. The write sites carry `// events: <type>` comments until the events core lands.

## 8. Docs

User: `/docs/connect-ai` ("Add any MCP server" paragraph) and `/docs/commands`. Agent: `/docs/agent/mcp` "MCP apps" (the remote kind, the manifest block, the proxy's rules, the CLI, the tools), `/docs/agent/secrets` (the `_MCP_TOKEN` family, the binding), `/docs/agent/manifest` (`remote` is a stored-manifest field of a provider row, never authored), `/docs/agent/errors` (the new codes), `cli.md` regenerated, the parity matrix (#614's drift test) with the eight tools. The skill: `mcp.md` and `setup/remote-mcp.md` (add, set the credential, grant, verify with `everyapp mcp show`).

## 9. Defaults taken (Ben's calls, in TODO.md "MCP apps by URL (2026-10-25)")

1. `on`/`off` mean serve/stop for both kinds; `remove` is the tombstone.
2. The credential family `<ID>_MCP_TOKEN`; no reuse of a provider key.
3. Unknown risk is `write`; the per-app `read` override exists.
4. Owners and admins register remote servers; members never; `remove` is owner-only.
5. OAuth upstreams: "not yet" (section 10).
6. The probe at `add` warns and never refuses.
7. Usage `target` is `mcp:<id>`.

## 10. Upstream OAuth: not this week

The MCP authorization spec with the gateway as the client needs protected-resource and authorization-server discovery, dynamic client registration, an authorize round trip through the operator's browser with a callback on the gateway, PKCE, and the tokens stored at rest (encrypted; the gateway encrypts nothing today) and refreshed. None of that exists, and the token store is a new security boundary. What ships: `--auth oauth` is accepted so the row says what the server wants, the app reads "Not supported yet" everywhere, and `mcp add`'s probe tells the operator when a server answers 401 with `WWW-Authenticate: Bearer resource_metadata=…` ("this server wants OAuth; if it also takes an API key, add it with --auth bearer"). The design for the client is a follow-up in TODO.md.

## 11. Tests

- `packages/sdk`: the name rules, the URL rules, the manifest block, the settings model's `remote-mcp` kind.
- `packages/perimeter`: the registry rules (add, update, status, remove, refusals).
- `packages/toolbus`: the client against an in-process fake (both eras, SSE and JSON answers, redirects refused, pagination, size caps, timeouts, the credential on the registered URL only), the normalization and risk mapping.
- `apps/every-app-gateway`: `remote-mcp.sqlite.test.ts` through the real `/mcp` with a fake upstream: the row, the sync on first use, a call with the credential, the audit row, the usage row, the cap, per-tool off, the binding refusal, the credential never in any answer or log, `off`/`on`/`remove`.
- `packages/cli`: each verb against the D1 fake, the probe, `secret set` routing and binding, `secret list`.
- The `claude -p` harness (`packages/toolbus/claude-code/remote-mcp.claude.ts`): Claude Code → the ToolBus → the client → a fake remote server, and one live run against a public no-auth MCP server when reachable.

## 12. What landed

Filled in as the PRs merge.
