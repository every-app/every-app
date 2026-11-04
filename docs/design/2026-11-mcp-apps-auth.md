# MCP apps: every upstream auth, and one concept

Date: 2026-11-02. Status: phases 1–3 built in PR #938; phase 4 (files) deferred, phase 5 open. The reference is [/docs/agent/mcp](../../landing-page/content/agent/mcp.md#mcp-apps). Ben's two questions: full auth for `everyapp mcp add <url>`, and why there are two kinds of MCP app. Prompted by ElevenLabs music for a video. Builds on [2026-10-mcp-provider-apps.md](2026-10-mcp-provider-apps.md), [2026-10-mcp-by-url.md](2026-10-mcp-by-url.md), [2026-10-mcp-apps-ui.md](2026-10-mcp-apps-ui.md) §6 and the OAuth providers flow ([/docs/agent/providers](../../landing-page/content/agent/providers.md#oauth-providers-upload-a-client-the-gateway-runs-the-flow)).

## Recommendation

**One concept: an MCP app is a tool source plus an optional provider.**

- **Tool source**: `gateway` (a tool pack compiled into the Gateway, today's DataForSEO) or `remote` (an MCP server URL).
- **Credential**: none, or a reference to a provider row: `{ provider: "<id>" }`.
- Every credential the Gateway sends lives in the provider registry. The `_MCP_TOKEN` family and `remote_mcp_credentials` go away; the provider row's `bound_to` binding is the origin pin.
- Upstream OAuth is an `oauth2-user` provider row that `mcp add` *discovers* from the server, instead of one an admin types. The `/connect/<id>` flow, sealed tokens, refresh lease and Connected accounts are reused as they are.
- Built-in packs stay, but only where they earn it: cost reading, sandbox tests, bounded inputs, or no usable upstream MCP. A pack is just a provider's tool source that we wrote.
- Large binary results: deferred (below).

Why: the two kinds already share the row, policy, audit, caps and launcher. They differ only in where tools come from and where the credential lives. Credentials are the part worth unifying: the provider registry already has every static kind (bearer, header, query, basic), host binding, per-member and org OAuth connections, and the reserved-host rules.

## Auth a remote MCP server can use

| Auth | Today | What the Gateway needs | Where it lives after this |
| --- | --- | --- | --- |
| none | yes | nothing | no provider |
| static bearer | yes | the value, pinned to the origin | provider row, `auth.kind: bearer` |
| custom header | yes | header name, optional prefix | provider row, `header` |
| HTTP Basic | yes | `user:password` | provider row, `basic` |
| API key in query | **no** | param name; refuse redirects; strip URL headers; redact the key from bodies | provider row, `query` (all already built for REST) |
| OAuth 2.1, the MCP spec | **no** (row recorded, serves nothing) | discovery, client, PKCE, `resource`, refresh, per-member tokens | discovered `oauth2-user` row + `provider_connections` |
| OAuth client credentials (machine) | no | token exchange, no person | later; rare on MCP servers |
| mTLS, signed requests | no | Workers mTLS binding / signer | out of scope |

### OAuth 2.1 per the MCP authorization spec

Steps the Gateway runs at `mcp add <url> --auth oauth` (or when the probe sees a 401 naming `resource_metadata`):

1. **Discovery.** Read the protected-resource metadata (RFC 9728) from the 401's `resource_metadata` or `/.well-known/oauth-protected-resource`. Take its `authorization_servers[0]`, then that server's metadata (RFC 8414, else OpenID discovery). Each fetch: https, public host, no redirects, 64 KiB, 10 s.
2. **Client.** First that works: (a) a client the admin pastes (some servers need a pre-registered app); (b) a Client ID Metadata Document, where the server advertises it: the Gateway publishes `https://<gateway>/.well-known/oauth-client/<id>.json` and that URL *is* the client id, so nothing is registered; (c) dynamic client registration (RFC 7591). A DCR client is sealed into `oauth_clients` like a pasted one.
3. **Write the row.** A provider row `<id>` of kind `oauth2-user`: `hosts` the MCP origin only, the discovered authorize, token and revoke URLs, `pkce: true`, a new `resource` field (the MCP URL, sent as RFC 8707 `resource` on authorize, token and refresh), one scope set `mcp` holding the server's `scopes_supported` (or none), and `discovered: { issuer, at }`.
4. **Connect.** `/connect/<id>` unchanged: state row, PKCE S256, callback at `/connect/<id>/callback`, tokens sealed in `provider_connections`. Add `iss` checking (RFC 9207) where the server advertises it.
5. **Call.** Bearer token from the caller's connection, refreshed under the existing lease. A 401 refreshes once, then answers with a connect link. A 403 `insufficient_scope` answers with a reconnect link asking the wider scope (step-up).

**Per member.** Each member connects their own account, one connection per person per app (`/connect/<id>-mcp?app=<id>`, as #942 made every OAuth connection): the server sees the real person, and threat-model item 32 narrows to static keys. The plan also had an organization (shared) account for a server billed to one account (ElevenLabs credits, a team API); it was built, then removed in the rebase onto #942, which deleted organization connections. A member without a connection gets a tool error with the connect link; the dialog shows Connect. The tool list is fetched with the app's member connection used most recently; members share that catalog.

**Reuse of the OAuth providers work.** Reused as is: `oauth_states`, sealing, refresh lease, `provider_connections`, Connected accounts, disconnect and revoke, `provider.*` events. New: discovery, CIMD/DCR, `resource`, step-up. Not needed: background grants (#888's design): an MCP call always has a person on it. Route-based scope sets do not fit MCP (one URL, JSON-RPC); an MCP-origin row uses one set with no routes, and the ToolBus's per-tool risk stays the guard.

## One model or two

| | A. Keep two kinds (today) | B. Built-in = remote app whose server is the Gateway | **C. Tool source + provider (recommended)** |
| --- | --- | --- | --- |
| Credentials | two families: provider keys, `_MCP_TOKEN` | same as A | one: provider rows |
| Upstream OAuth | new store beside providers | same as A | reuses `/connect` and connections |
| ElevenLabs hosted MCP | **refused**: `api.elevenlabs.io` is a reserved provider host | refused | allowed: the app names the `elevenlabs` provider, so its key may go there |
| Query-param keys | new code | new code | already built |
| Cost, caps in $, sandbox | built-ins only | built-ins only, over a loopback hop | packs only; remote counts calls |
| Code to change | none | a fake HTTP seam, nothing gained | row shape, CLI flags, a migration |
| Mental model | "two kinds of MCP app" | one kind, odd internals | "an MCP app uses a provider" |

B is cosmetic: the Gateway already serves both kinds in-process behind one seam (`appFetcherFor`). C changes what matters, the credential.

What built-ins give that remote apps don't, and so when to write a pack: `cost` read per call for $ caps; inputs bounded so answers fit; sandbox tests; stable tool names and risks we chose; a provider with no MCP server, or one that only runs locally over stdio. What remote gives: no code, the vendor's tools as they evolve, per-person OAuth.

## Metered usage and caps

**Ben's ruling (2026-11-02): no metering for remote MCP apps.** Every MCP server tracks cost or credits its own way. The Gateway can't know what a credit costs, so anything it showed would be a guess.

| Kind | Metering |
| --- | --- |
| Every App apps and built-in packs | Full: call counts, the workspace default cap, Paused, cap alerts, dollar caps where the answer reports a cost (OpenRouter's `usage.cost`, DataForSEO's `cost`). Since #948 a cap is dollars only. |
| Remote MCP apps added by URL | None. No cap, and the workspace default cap doesn't bind them. Usage and the Admin row say "Not metered; billed by <server>". |

- Calls still land in `mcp_tool_calls` (Activity), so the audit trail stays.
- The per-tool price and cost-path ideas are dropped.
- Usage keeps per-member call counts for remote apps, so admins see who uses which server most.
- **Roadmap, not now: metering per supported MCP, opt in.** For big providers (DataForSEO today, ElevenLabs later) we write custom support that reads that vendor's real cost or credits. No catch-all meter for every MCP.
- To build: `checkMonthlyCap` skips remote rows, the Usage page and `workspace usage` mark them, and docs say so. Today remote calls do count against caps, so this is a change.

## Large binary results

**Deferred (Ben, 2026-11-02).** Ben asked whether the client can take large files directly. The Gateway relays a remote tool's `content` blocks, `resource_link`s included, as the server sent them, up to 768 KiB; a server that links to its own file store already works. Raw base64 audio inline would overflow the model's context anyway, so a Gateway files bucket (`everyapp-files`, a signed `/files/*` route with an Access bypass, a `resource_link` helper for packs) waits for a pack or server that needs it.

## Security

- **Credential to one origin.** The provider binding replaces the `_MCP_TOKEN` pin: a key is read only for the hosts and auth it was set for. An MCP URL on a reserved host is allowed only when the app names that host's provider.
- **OAuth tokens to the resource only.** The access token goes only to the MCP URL's origin, audience-bound with `resource`. Discovered authorize and token hosts may differ but never receive the token. Re-pointing the URL or issuer unbinds the client and every connection.
- **Discovery is untrusted.** Hostile metadata can only send the person's browser to a bad authorize page, which they see. Refuse non-https and private hosts, follow no redirects, check `iss`.
- **Who may do what.** Unchanged: owners and admins add, change and remove MCP apps and pick the org account; the operator sets static values (`secret set`); any member connects their own account. Never a value through the UI or a tool, except the existing sealed paste of an OAuth client.
- **Threat model.** Item 32 narrows to static keys; the rows are `remote-mcp.key-bound-to-provider-hosts`, `remote-mcp.oauth-token-to-resource-only`, `remote-mcp.discovery-bounded`, `remote-mcp.oauth-iss-and-pkce`, `remote-mcp.per-member-connection`, `remote-mcp.provider-row-org-guard` and `remote-mcp.not-metered` (accepted risk).

## ElevenLabs, now and later

- Its hosted server (`https://api.elevenlabs.io/v1/mcp`) takes only OAuth: an `xi-api-key` gets 401 "OAuth bearer token required for the hosted MCP" (checked 2026-11-03). Its authorization server (`api.us.elevenlabs.io`) has no DCR, only CIMD (`client_id_metadata_document_supported`), which #938 doesn't build. Its local server with `compose_music` is archived and stdio, so the Gateway can't relay it. Whether the hosted one has music is unconfirmed.
- Today `mcp add https://api.elevenlabs.io/v1/mcp` is refused: the catalog holds a key for that host. Adding it needs CIMD and that host claim lifted for an OAuth server.
- **Interim, if Ben registers it as a provider app**: a built-in pack `elevenlabs` over the existing `ELEVENLABS_API_KEY` entry. Tools: `compose_music` (`POST /v1/music`), `text_to_speech`, `sound_effects`, `list_voices`. Each audio answer goes to R2 and returns a link (needs the files phase first). As a built-in pack it is metered, but per-call cost isn't in the answer, so no cap would bind it (caps are dollars only since #948).
- **Later**: once CIMD is built, add it with OAuth; if the hosted server gains music, drop the pack.

## Decisions (Ben, 2026-11-02)

1. Per-member OAuth by default, the organization's account opt-in: yes, built; the organization account was removed in the rebase onto #942.
2. Fold `_MCP_TOKEN` into provider rows, breaking existing remote apps: yes, done (migration 0031; an old row reads "remove and add again").
3. A Gateway files bucket: not for now (above).
4. ElevenLabs: try `--provider elevenlabs`, else `--auth oauth`; no pack yet. Tried 2026-11-03: the key header is refused and OAuth needs CIMD (above).
5. Members adding MCP apps for themselves: no, owners and admins only.

## Phased plan

| Phase | What | State |
| --- | --- | --- |
| 1 | Remote MCP apps not metered; Usage says "Not metered"; `APP_NOT_METERED`. Docs drift fixed. | Built, #938 |
| 2 | Credential = provider reference; `--auth query`; `--provider <id>` with the reserved-host exception; static auth writes `<id>-mcp`; `_MCP_TOKEN` and `remote_mcp_credentials` dropped. | Built, #938 |
| 3 | Upstream OAuth: discovery, DCR, pasted client, `resource`, `iss`, per-member connections, connect links in tool errors. | Built, #938; CIMD and step-up not built |
| 4 | Files: R2 bucket, signed `/files/*`, `resource_link` helper. | Deferred |
| 5 | ElevenLabs pack on phase 4; remote oversize spooling. | Open |

As built, differing from the plan above: no scope set (since #942 the app's manifest lists the scopes discovery found, `{ scopes, why }`; the row tolerates the server's `scopes_supported`, and the scopes an MCP server grants are kept as granted, never refused by the mint check); no organization account; no `discovered: { issuer, at }` (the row has `issuer`); a 401 answers the reconnect link without a refresh first (the lease refreshes before expiry); a 403 asks no wider scope. Follow-ups and the live check are TODO.md's "MCP apps auth and one concept (2026-11-02)".

Each phase is one PR or a short stack. Gateway auth and perimeter PRs (3, 4) wait for Ben's review.
