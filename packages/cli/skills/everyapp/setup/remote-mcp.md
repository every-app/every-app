# A remote MCP server as an MCP app

Any remote MCP server that speaks Streamable HTTP (a docs search, a
company's API, a SaaS tool's MCP endpoint) can become an MCP app of the
Gateway's: `pnpm everyapp mcp add <url>` registers it, the Gateway serves its
tools on its own `/mcp` to every member it is granted to as `<id>_<tool>`,
holds the server's credential itself (never sent to an AI client), sends it
only to the server's host, and attributes and audits every call. MCP servers
added by URL aren't metered: no cap applies to them. A read-only connection
sees only the tools whose risk is `read`. At the end the person has the app
on, its credential set (or their account connected, for OAuth), the people
who need it granted, and one tool call through the Gateway's `/mcp` that
worked.

## Settings

The credential is a provider. `mcp add` writes the app's own provider row,
`<id>-mcp`, beside the app, or uses one the Gateway has (`--provider <id>`).

| NAME | required or optional | what it holds |
| ---- | -------------------- | ------------- |
| `<ID>_MCP_TOKEN` (the app id upper-cased, `-` as `_`) | required for `--auth bearer`, `header`, `query` or `basic` | What the server's docs call its API key or token. `bearer` sends `Authorization: Bearer <value>` (`--prefix Token` for another scheme); `header --header X-Api-Key` sends `X-Api-Key: <value>`; `query --param api_key` adds it to the URL; `basic` takes `user:password`. |
| `<ID>_MCP_CLIENT_ID`, `<ID>_MCP_CLIENT_SECRET` | set by `mcp add` for OAuth | The OAuth client the Gateway signs in with. `mcp add` registers one with the server, or takes `--client-id` (and `--client-secret-from-env <VAR>`) for a server that registers none. |

Each is set through `secret set`'s path, which binds it to the row's host:
the Gateway sends it nowhere else. A row that changes (the server re-added at
another host, say) needs its key set again; `mcp list` says
`set for other hosts` until it is.

With OAuth, each member connects their own account at the Gateway's connect
page. No token is ever shown or typed.

## Costs and plans

EveryApp charges nothing for an MCP app. The server's provider charges what
it charges for its calls (its own plan and limits apply; read them on its
site). Every call is counted in the organization's usage and listed in
Activity; `pnpm everyapp workspace usage` marks the app "not metered", and a
cap on it is refused (`APP_NOT_METERED`). Its own plan and limits are what
bound it.

## Only a person can

- Create an account with the server's provider and accept its terms, when it
  has any.
- Create the API key on the provider's dashboard and type it at the hidden
  prompt, or sign in to their own account on the connect page (OAuth).
- Register an OAuth client in the provider's console, for a server that
  registers none itself.
- Decide who gets the app beyond the owners and admins (Admin → Apps → Manage
  access), and whether a tool the server says is safe should count as a write
  (you suggest; they decide).

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` are
   true; `data.gatewayUrl` is `https://<gateway host>`. Not installed, or no
   owner: [gateway.md](gateway.md) first.
2. The server's MCP address and how it authenticates, from its docs: an
   `https://` URL (often ending in `/mcp`) that speaks Streamable HTTP. The
   Gateway follows no redirects, so use the address the server answers at.
3. `pnpm everyapp mcp list --json`: the server isn't added already. The id is
   the domain's name (`https://mcp.deepwiki.com/mcp` → `deepwiki`), or
   `--name <id>` (lowercase letters, digits and hyphens, at most 32); it is
   the tools' prefix, so keep it short.

## Steps

One step per message: give the step, wait for the words it ends with
("done", "I have it"), then the next.

1. **You:** add it. `pnpm everyapp mcp add <url> --json` looks at the server
   first, from this machine, and writes nothing until it knows the
   credential:
   - it answers without one: added with none;
   - its 401 names OAuth metadata: added with OAuth (discovered, a client
     registered), and `data.connect.url` is the connect page;
   - it asks for a credential otherwise: refused `REMOTE_MCP_NEEDS_CREDENTIAL`.
     Read its docs, then add it again with `--auth bearer` (or
     `--auth header --header <name>`, `--auth query --param <name>`,
     `--auth basic`, `--auth oauth`), or `--provider <id>` for a provider the
     Gateway has (`pnpm everyapp provider list`; the URL's host must be one of
     its hosts).

   Add `--risk read` for a server that only reads and doesn't say so in its
   tool annotations. The `done` event's `data.credential` says what it is and
   whether it is `set` and `bound`; `PROVIDER_KEY_UNSET` means the key comes
   next.
2. **Person, a static key:** they create the key on the provider's dashboard,
   then, in a second terminal in the `every-app` folder,
   `pnpm everyapp secret set <ID>_MCP_TOKEN` and paste it at the hidden prompt
   (for `basic`, `user:password`). When the person runs `mcp add` themselves
   at a terminal, it asks `Set <NAME> now?` and shows the same prompt;
   `--from-env <VAR>` takes it from a variable at the add. Once it is set,
   `mcp add` checks it with one call: `Working: <n> tools`, or the warning
   `REMOTE_MCP_CREDENTIAL_REJECTED`. Wait for "done".
3. **Person, OAuth:** they open the connect page (`mcp add` opens it at a
   terminal; `--no-open` only prints it), sign in and approve. Every other
   member connects their own account the same way, or from the app's dialog
   on the Gateway's home page. A server that registers no clients was refused
   `REMOTE_MCP_OAUTH_NO_CLIENT` with the redirect URI to register: they
   register a client in its console with that URI, then you run the add again
   with `--client-id <id> --client-secret-from-env <VAR>`.
4. **Person:** who gets it. The owners and the admins open it by their role.
   Anyone else: Admin → Apps → the app's row → **Manage access**.
5. **Person:** connect an AI client to the Gateway if theirs isn't yet:
   `claude mcp add --transport http everyapp https://<gateway host>/mcp`,
   then `/mcp` → **everyapp** → **Authenticate** in Claude Code (other clients:
   the same URL; mcp.md beside this folder, "Connecting a person").

## Verify

1. `pnpm everyapp mcp show <id> --json`: `data.status` is `"on"`.
   `data.credential` is `{ kind: "none" }`, a key with `set` and `bound`
   true, or OAuth with `connected` at least 1 (`people` lists who, never a
   token). `data.snapshot` is null until the Gateway lists the tools, on the
   first request to its `/mcp` (or within the hour).
2. One tool call through the Gateway: in the person's connected client, ask
   for something the server does ("use <id> to …", or "list the tools <id>
   offers"); the client shows a call to an `<id>_<tool>` tool and its
   answer. On a Gateway with many tools the client may list them compactly:
   then it finds them with `everyapp_search_tools` (`{ "app": "<id>" }`) and
   runs one through `everyapp_call_read`. Then
   `pnpm everyapp mcp show <id> --json` again: `data.snapshot.tools` is the
   count listed and `data.tools[]` has each with its `name`, `serverName`,
   `risk` and `source` (`hint`: the server's annotation; `default`: no
   annotation, counted as a write; `app`: the `--risk` default;
   `override`: yours).
3. Risks, with the person: a tool the server marks read-only is callable by
   every connection; any other is a write (hidden from read-only
   connections), and one marked destructive keeps the mark so clients ask
   before calling it. Change one with
   `pnpm everyapp mcp tool <id> <tool> --risk read|write --json`
   (`--risk annotations` drops the override), or leave a tool out entirely
   with `--off`; the Gateway lists the tools again on first use.
4. Logs, when a call fails: README's path (**Workers & Pages** →
   `every-app-gateway` → **Observability** → **Live**). The remote proxy logs
   each failed upstream call as `mcp.remote.upstream_failed` with the status
   (never the credential).

## If it fails

| error or symptom | meaning | what to do |
| ---------------- | ------- | ---------- |
| `REMOTE_MCP_NEEDS_CREDENTIAL` | The server asks for a credential and none was given | Its docs say how: `--auth` bearer, header, query, basic or oauth, or `--provider <id>`; `--force` adds it without one |
| `REMOTE_MCP_OAUTH_DISCOVERY` | The server's OAuth metadata can't be found or isn't usable (no PKCE, not https) | If it takes an API key instead, a static `--auth` |
| `REMOTE_MCP_OAUTH_NO_CLIENT` | The server registers no clients (or refused the registration) | Register one with the redirect URI the message prints, then `--client-id` and `--client-secret-from-env` |
| `REMOTE_MCP_CREDENTIAL_REJECTED` (warning) | The server refused the key when `mcp add` checked it | Check the key and where it goes (`--auth`, `--header`, `--param`), then `secret set <ID>_MCP_TOKEN` again |
| `REMOTE_MCP_PROVIDER_HOST` | `--provider`'s hosts don't include the URL's host | The server's own credential (`--auth`), or the provider whose host it is |
| `PROVIDER_KEY_UNSET` (warning), `set for other hosts` in `mcp list` | The key isn't set, or was set for an earlier row | `pnpm everyapp secret set <NAME>` |
| `OAuth: 0 connected` in `mcp list` | Nobody has connected an account yet | The connect page (`mcp show <id>` prints it) |
| `registered before provider credentials` in `mcp list` | The app was added before this release | `pnpm everyapp mcp remove <id>`, then add it again |
| `REMOTE_MCP_URL_REFUSED` | Not `https://`, an IP address, the Gateway's own host or app domain, or a provider's host without `--provider` | The server's own MCP address, by host name, over https |
| `REMOTE_MCP_EXISTS` | That id is an MCP app already | `mcp show <id>`; `mcp remove <id>` then add again, or another `--name` |
| `REMOTE_MCP_INVALID` | A bad id, risk, header or provider, or flags that say two things | As the message says |
| `REMOTE_MCP_PROBE_FAILED` (warning) | A redirect, or no answer from this machine | Another address; or this machine's network only (the Gateway fetches from Cloudflare) |
| `SECRET_EMPTY` | The `--from-env` variable is empty (nothing was added) | Export it in that shell, then rerun |
| `APP_NOT_METERED` | A cap was asked of an MCP server added by URL | None applies: its calls are counted and audited only |
| `data.snapshot.status` `error` | The server refused the listing, or is down | Fix the credential or connect an account, then `pnpm everyapp mcp refresh <id>` |

## Rerun, rotate, remove

- **Rerun.** `mcp add` refuses an id that exists (`REMOTE_MCP_EXISTS`), so a
  rerun starts from Verify. `secret set` replaces.
- **Rotate.** A new key on the provider's dashboard, then
  `secret set <ID>_MCP_TOKEN` again. A value that went through the chat is
  compromised: rotate it.
- **Off, and back on.** `mcp off <id>` stops serving it and keeps access;
  `mcp on <id>` serves it again at once.
- **Remove.** `pnpm everyapp mcp remove <id> --json`: everyone's access and
  its tokens go. Its provider row, its key and people's OAuth connections
  stay (adding it again at the same address reuses them);
  `pnpm everyapp provider remove <id>-mcp` and
  `pnpm everyapp secret unset <NAME>` clean them up. Then revoke the key on
  the provider's side.

## Sources

- docs/design/2026-11-mcp-apps-auth.md (provider credentials, OAuth to MCP servers, not metered)
- docs/design/2026-10-mcp-by-url.md (the remote block, the proxy)
- In code: `packages/sdk/src/internal/remoteMcp.ts` (the URL, id, auth and risk rules), `packages/sdk/src/internal/mcpOAuth.ts` (discovery, client registration, the synthesized specs), `packages/perimeter/src/registry/remoteMcpApps.ts` (`planRemoteMcpAppAdd`, `planRemoteMcpProviderRow`), `packages/cli/src/commands/mcp/index.ts` (`mcp add` and the rest), `packages/cli/src/lib/gateway/remoteMcpApps.ts` (the rows and each credential's state)
- https://modelcontextprotocol.io/specification (Streamable HTTP, tool annotations, authorization with `resource_metadata`)
