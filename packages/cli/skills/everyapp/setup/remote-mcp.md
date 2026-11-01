# A remote MCP server as an MCP app

Any remote MCP server that speaks Streamable HTTP (a docs search, a
company's API, a SaaS tool's MCP endpoint) can become an MCP app of the
Gateway's: `pnpm everyapp mcp add <url>` registers it, the Gateway serves its
tools on its own `/mcp` to every member it is granted to as `<id>_<tool>`,
holds the server's credential itself (a Gateway setting, never sent to an AI
client), sends it only to the server's origin, and attributes, audits and
counts every call like an app's. A read-only connection sees only the tools
whose risk is `read`. At the end the person has the app on, its credential
set and pinned to the server's origin, the people who need it granted, and
one tool call through the Gateway's `/mcp` that worked.

## Settings

| NAME                                                                                  | required or optional                          | what it holds                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<ID>_MCP_TOKEN` (the app id upper-cased, `-` as `_`; `--secret` picks another name ending in `_MCP_TOKEN`) | required, unless the server takes no credential (`--auth none`) | What the server's docs call its API key, token or password. `--auth bearer` sends it as `Authorization: Bearer <value>`; `--auth header --header X-Api-Key` as `X-Api-Key: <value>`; `--auth basic` takes `user:password` and sends HTTP Basic. |

The name is a Gateway setting like any provider key, set with
`pnpm everyapp secret set <NAME>` (any name ending in `_MCP_TOKEN` goes to the
Gateway; nothing else is accepted for it). When it is set, the CLI pins it to
the origin of the MCP app that declares it (`https://treg.to` for
`https://treg.to/mcp/`): the Gateway sends a credential only to the origin it
was set for. A server re-pointed or re-added at another address needs its
credential set again; only the operator (the Cloudflare login) can, so an
owner or admin who changes an app in the Gateway never moves a credential.
`mcp list` and `mcp show` say "needs setup" until it is set and pinned.

`--auth oauth` is accepted and recorded, but the Gateway doesn't sign in to
MCP servers with OAuth this week: such an app serves no tools ("OAuth: not
supported yet"). If an OAuth server also takes an API key, add it with
`--auth bearer` instead.

## Costs and plans

EveryApp charges nothing for an MCP app. The server's provider charges what
it charges for its calls (its own plan and limits apply; read them on its
site). Every forwarded call is counted in the organization's usage as
`mcp:<id>`, and an owner or admin can cap an app's calls per month in Admin →
Usage (off by default): past the cap a tool answers a tool error naming it
until the next UTC month.

## Only a person can

- Create an account with the server's provider and accept its terms, when it
  has any.
- Create the API key or token on the provider's dashboard and type it at the
  hidden prompt.
- Decide who gets the app beyond the owners and admins (Admin → Apps → Manage
  access), and whether a tool the server says is safe should count as a write
  (you suggest; they decide).
- Decide to replace a credential the Gateway already holds.

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` are
   true; `data.gatewayUrl` is `https://<gateway host>`. Not installed, or no
   owner: [gateway.md](gateway.md) first.
2. The server's MCP address and how it authenticates, from its docs: an
   `https://` URL (often ending in `/mcp`) that speaks Streamable HTTP. An old
   HTTP+SSE-only endpoint (a separate `/sse` URL from 2024) isn't served. The
   credential is usually an API key sent as a bearer token; some servers read
   a header of their own (`X-Api-Key`); public servers take none. The
   Gateway follows no redirects, so use the address the server answers at,
   not one that redirects to it.
3. `pnpm everyapp mcp list --json`: the server isn't added already (no entry
   in `data.apps` with its `url`). The id is the domain's name, the label
   before its suffix (`https://mcp.deepwiki.com/mcp` → `deepwiki`,
   `https://treg.to/mcp/` → `treg`), or `--name <id>` (lowercase letters,
   digits and hyphens, at most 32 characters); it is the tools' prefix, so
   keep it short.

## Steps

One step per message: give the step, wait for the words it ends with
("done", "I have it"), then the next.

1. **You:** add it. `pnpm everyapp mcp add <url> --auth bearer --json` (or
   `--auth header --header <name>`, `--auth basic`; nothing for a public
   server), with `--name <id>` when the host name makes a poor id and
   `--risk read` for a server that only reads and doesn't say so in its tool
   annotations (`--risk write` treats every tool as a write). The app is on
   at once for the person running it (when they are a member), the owners
   and the admins. The `done` event's `data.id`, `data.key` (null for
   `--auth none`; else the credential's `name` and whether it is `set` and
   `bound` to the URL's origin) and `data.probe` (what one look at the server
   from this machine found, without the credential) say what happened.
   `PROVIDER_KEY_UNSET` means the credential comes next.
   `REMOTE_MCP_PROBE_FAILED` and `REMOTE_MCP_WANTS_OAUTH` are warnings, never
   refusals: a 401 with `--auth none` means the server wants a credential
   (`pnpm everyapp mcp remove <id>`, then the same add with `--auth bearer`), a
   redirect means another address, and "Couldn't reach" may be this
   machine's network only (the Gateway fetches from Cloudflare).
2. **Person:** the credential. They create the key on the provider's
   dashboard, then, in a second terminal in the `every-app` folder:
   `pnpm everyapp secret set <NAME>` (the name from step 1, for example
   `pnpm everyapp secret set TREG_MCP_TOKEN`) and paste it at the hidden
   prompt (for `--auth basic`, `user:password`). It ends with
   `Set <NAME> on the Gateway`. When the person runs `mcp add` themselves at
   a terminal, it asks `Set <NAME> now?` right after adding and, on yes, shows
   the same hidden prompt (`secret set`'s own); No leaves it for `secret set`.
   The README's other two ways work as for any `secret set` (a pipe into
   `pnpm everyapp secret set <NAME> --json`, or the hidden read then
   `--from-env <VAR>`); `mcp add <url> --auth bearer --from-env <VAR> --json`
   takes the variable at the add itself, read before anything is written.
   Wait for "done".
3. **Person:** who gets it. The owners, the admins and whoever added it have
   it already. Anyone else: Admin → Apps → the app's row → **Manage access**.
   A member sees its tools after granting, in a client connected to the
   Gateway (the next step).
4. **Person:** connect an AI client to the Gateway if theirs isn't yet:
   `claude mcp add --transport http everyapp https://<gateway host>/mcp`,
   then `/mcp` → **everyapp** → **Authenticate** in Claude Code (other clients:
   the same URL; mcp.md beside this folder, "Connecting a person").

## Verify

1. `pnpm everyapp mcp show <id> --json`: `data.status` is `"on"` (not
   `"needs setup"`), `data.key.set` and `data.key.bound` are true and
   `data.key.boundOrigin` is the URL's origin (all three skipped for
   `--auth none`: `data.key` is null). `data.snapshot` is null until the
   Gateway lists the tools, on the first request to its `/mcp` after the add
   (or within the hour). From the checkout root,
   `pnpm everyapp secret list --json` agrees: the name is in
   `data.gateway.names`, its `data.gateway.mcpCredentials` entry has
   `set: true`, and the app has left `data.apps` (it is listed there only
   while it needs setup, with `setup.command` the `secret set` that sets it
   up).
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
   every connection; one without a hint is a write (hidden from read-only
   connections); one marked destructive is hidden from every client until
   approvals exist. Change one with
   `pnpm everyapp mcp tool <id> <tool> --risk read|write|destructive --json`
   (`--risk annotations` drops the override), or leave a tool out entirely
   with `--off`; the Gateway lists the tools again on first use.
4. Logs, when a call fails: README's path (**Workers & Pages** →
   `every-app-gateway` → **Observability** → **Live**). The remote proxy logs
   each failed upstream call as `mcp.remote.upstream_failed` with the status
   (never the credential), and a first-use pin as
   `mcp.remote.credential_bound` (names from the design,
   docs/design/2026-10-mcp-by-url.md; not checked against a live Gateway
   here, unverified).

## If it fails

| error or symptom                                                       | meaning                                                                                                     | what to do                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `SECRET_VALUE_REQUIRED` from `secret set --json`                       | Nothing was piped and there is no terminal to prompt in                                                     | One of the README's three ways: the person's own terminal, a pipe, or `--from-env`                                                  |
| `SECRET_EMPTY`                                                         | The `--from-env` variable is empty or not exported in that shell (from `mcp add --from-env`, nothing was added) | The hidden read (README's third way) in that same terminal first, then rerun                                                     |
| `REMOTE_MCP_URL_REFUSED`                                               | Not `https://`, an IP address, the Gateway's own host or app domain, or a provider the Gateway holds a key for | The server's own MCP address, by host name, over https                                                                              |
| `REMOTE_MCP_EXISTS`                                                    | That id is an MCP app already                                                                               | `pnpm everyapp mcp show <id>`; another address is `mcp remove <id>` then `mcp add` again, or another `--name`                       |
| `REMOTE_MCP_SECRET_TAKEN`                                              | Another MCP app at another origin uses that credential name                                                 | `--secret <OTHER>_MCP_TOKEN`: one credential name per origin                                                                        |
| `REMOTE_MCP_INVALID`                                                   | A bad id, risk, header or credential name, or flags that say two things                                     | As the message says                                                                                                                 |
| `PROVIDER_APP_UNKNOWN`                                                 | The id isn't an MCP app here                                                                                | `pnpm everyapp mcp list` for the ids                                                                                                |
| `REMOTE_MCP_SECRET_BOUND_ELSEWHERE` from `mcp add`, or `needs setup` in `mcp list` or `mcp show` with the key set | The credential is pinned to another origin (`data.key.boundOrigin`): it was set for an earlier server | `pnpm everyapp secret set <NAME>` again (Steps 2)                                                                  |
| `REMOTE_MCP_TOOL_NOT_LISTED` from `mcp tool`                           | The tool's name isn't in the last listing: the override was kept under that name, as the server's           | `pnpm everyapp mcp show <id>` for both names, then `mcp tool` with the right one                                                    |
| `REMOTE_MCP_SECRET_UNDECLARED` from `secret set`                       | No MCP app declares that name (a typo, or set before `mcp add`)                                             | Check the name with `mcp show <id>`; `mcp add` first                                                                                |
| `REMOTE_MCP_WANTS_OAUTH`                                               | The server wants OAuth, which the Gateway doesn't do yet                                                    | If it also takes an API key: `--auth bearer` and set the key; otherwise it can't be served this week                                |
| `REMOTE_MCP_GATEWAY_OUTDATED`                                          | The Gateway predates MCP apps by URL                                                                        | `pnpm everyapp update`, then Verify                                                                                                 |
| `data.snapshot.status` `error`, `lastError` naming 401                  | The server rejected the credential                                                                          | A fresh key from the provider, `secret set` again, then `pnpm everyapp mcp refresh <id>`                                            |
| `lastError` naming a redirect or a timeout                             | The address redirects, or the server is slow or down                                                        | The address it redirects to (remove, add again); a slow server: retry later                                                        |
| The tools changed on the server, not on the Gateway                    | The Gateway's snapshot is up to an hour old                                                                 | `pnpm everyapp mcp refresh <id>`                                                                                                    |
| A tool is missing for one person only                                  | Their connection is read-only (write tools hidden), or they weren't granted the app                         | Admin → Apps → Manage access; a read & write connection                                                                            |

## Rerun, rotate, remove

- **Rerun.** `mcp add` refuses an id that exists (`REMOTE_MCP_EXISTS`), so a
  rerun starts from Verify. `secret set` replaces; `mcp tool` and
  `mcp refresh` can run again.
- **Rotate.** A new key on the provider's dashboard, then Steps 2 again: the
  Gateway uses the new value on its next request. A value that went through
  the chat is compromised: rotate it.
- **Off, and back on.** `pnpm everyapp mcp off <id> --json` stops serving it
  and keeps everyone's access, tokens and the snapshot;
  `pnpm everyapp mcp on <id> --json` serves it again at once.
- **Remove.** `pnpm everyapp mcp remove <id> --json`: a tombstone, with
  everyone's access, its tokens and its place in AI connections gone (adding
  it again starts fresh). The credential and its pin stay;
  `pnpm everyapp secret unset <NAME> --json` removes both (it asks; with
  `--json` add `--yes` only once the person said so). Then revoke the key on
  the provider's side.

## Sources

- docs/design/2026-10-mcp-by-url.md (the remote block, the credential family and its pin, the proxy, the defaults taken)
- In code: `packages/sdk/src/internal/remoteMcp.ts` (the URL, id, auth and risk rules: `remoteMcpUrlProblem`, `remoteMcpIdFromUrl`, `remoteToolRisk`), `packages/sdk/src/internal/gatewaySettings.ts` (`isRemoteMcpSecretName`: any name ending in `_MCP_TOKEN` is the Gateway's), `packages/sdk/src/internal/appSettings.ts` (the `remote-mcp` setting kind naming this file), `packages/perimeter/src/registry/remoteMcpApps.ts` (`planRemoteMcpAppAdd` and its refusals), `packages/cli/src/commands/provider/index.ts` (`mcp add`, `show`, `tool`, the probe's warnings), `packages/cli/src/lib/gateway/remoteMcpApps.ts` (the rows, the pin in `remote_mcp_credentials`), `packages/cli/src/commands/secret/index.ts` (the pin on `secret set`, dropped on `secret unset`), `apps/every-app-gateway/src/db/remote-mcp.schema.ts` (migration 0011)
- https://modelcontextprotocol.io/specification (Streamable HTTP transport, tool annotations `readOnlyHint` and `destructiveHint`, authorization with `resource_metadata`)
