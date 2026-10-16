# The MCP connector and its OAuth server

The gateway serves one MCP connector, `https://<gateway>/mcp`, for every app
a user can reach. claude.ai (web, Desktop, mobile), ChatGPT, Claude Code and
Cursor connect to it with OAuth; scripts and clients that take a header can
use a personal access token (`epat_…`) instead. Tools are named
`<app>_<tool>`, plus two built-ins, `everyapp_whoami` and
`everyapp_list_apps`.

The OAuth authorization server lives in the gateway too
(`@cloudflare/workers-oauth-provider` 1.2, `apps/every-app-gateway/src/server/mcp-auth`).
It protects exactly one resource, `<GATEWAY_URL>/mcp`: Claude requires the
protected resource metadata to name the exact URL the user typed, so there
is one connector per gateway, not one per app. An app host's own `/mcp`
(`https://<app-host>/mcp`) takes personal access tokens and the app's own
pages' session only; it offers no OAuth.

## On by default, with a kill switch

OAuth is on unless the `MCP_OAUTH_ENABLED` secret is `false` (or `0`, `off`,
`no`). Any value other than those and `true` (`1`, `on`, `yes`) turns it off
too, and logs `mcp.oauth.flag_unrecognized`. To turn it off (the CLI sends
the secret with a redeploy of the gateway its checkout builds):

```sh
everyapp secret set MCP_OAUTH_ENABLED --for gateway
# enter: false
```

While it is off, `/oauth/*` and the OAuth discovery documents return 404,
`/mcp` accepts personal access tokens only, and its 401 names no
authorization server (`WWW-Authenticate: Bearer realm="every-app"`), so a
client fails fast instead of half-registering. Connections stay recorded;
they work again when the switch is turned back on, unless they were revoked
or lapsed meanwhile. To turn it back on:

```sh
everyapp secret set MCP_OAUTH_ENABLED --for gateway
# enter: true
```

## Client registration

A client identifies itself one of two ways:

- **A Client ID Metadata Document (CIMD)**: its client id is an https URL
  serving its metadata. claude.ai, Claude Desktop and mobile, Claude Code
  (2.1.81 and later), ChatGPT, VS Code, Codex and Copilot CLI use it, so
  nothing is stored for them until a user connects. The consent page shows
  "Published by <domain>" as verified when access goes to that domain, a
  subdomain of it or an app on the user's computer.
- **Dynamic client registration (DCR, `/oauth/register`)**: Cursor, Gemini
  CLI, MCP Inspector and older clients can only connect this way. Anyone
  may register, so it is bounded: a registration is at most 16 KiB and
  keeps only the client's name (cleaned, at most 200 characters), up to ten
  redirect URIs of at most 2 KiB, its grant and response types and its
  authentication method. Each client address (an IPv6 address by its /64)
  may register 5 clients a minute (per isolate) and 20 a day, and the whole
  gateway 200 a day (UTC days, counted in D1's `rate_limit_counters`, so
  refused requests write nothing). Past that, `/oauth/register` answers
  `429 rate_limited` and logs `mcp.oauth.registration_limited` once per
  isolate. A registration lasts 60 days without use and renews while its
  client keeps refreshing tokens.

DCR is on by default, because Cursor has no other way in. To allow CIMD
clients only:

```sh
everyapp secret set MCP_DCR_ENABLED --for gateway
# enter: false
```

The authorization server metadata then names no `registration_endpoint`,
`/oauth/register` returns 404, and clients registered before keep working
until their registration lapses. Set it to `true` to turn DCR back on.

## What the gateway needs

All of it ships with the gateway (its `cloudflare.config.ts` and migrations)
and `everyapp setup` sets it up; there is nothing to set by hand.

- The `OAUTH_KV` namespace (`every-app-gateway-OAUTH_KV`, provisioned by
  `everyapp setup`): grants, tokens, registered clients, consent
  transactions, and the hourly sweep's cursor (`purge-cursor`).
- The `global_fetch_strictly_public` compatibility flag. With it the server
  fetches clients' metadata documents (CIMD) as a request from the internet
  would go, through Cloudflare's front door (never straight to an origin
  behind a zone), and advertises `client_id_metadata_document_supported`,
  which is what makes claude.ai and ChatGPT use CIMD. Without it, CIMD is
  off and they fall back to dynamic registration. The front door of the
  gateway's own domain is the gateway itself, so client ids and redirect
  URIs there are refused before anything is fetched.
- An hourly cron trigger (`17 * * * *`). It deletes `mcp_tool_calls` rows
  older than `MCP_AUDIT_RETENTION_DAYS` (default 90), up to 20,000 a run,
  marks connections unused for 31 days as expired, deletes rate limit
  counters whose day is over, and sweeps expired and
  orphaned OAuth records from `OAUTH_KV`, 50 grants and 50 tokens a run,
  resuming from its cursor (after three failed runs in a row it starts a
  new sweep). Each run logs one `mcp.maintenance` line; `audit_behind: true`
  (a warning) means more calls arrive than a run deletes.
- The gateway's migrations (run by `everyapp setup`), which create
  `mcp_connections`, `mcp_connection_apps`, `mcp_tool_calls` and
  `rate_limit_counters`.
- A `GATEWAY_URL` on `https`. It is the OAuth issuer and `<GATEWAY_URL>/mcp`
  the resource, so changing it invalidates every connection; clients ask
  their users to connect again on their next request.

Optional settings (`everyapp secret set <name> --for gateway`; locally, in
`.dev.vars`):

| Name                       | Default | What it does                                                                                                                                                                                    |
| -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_OAUTH_ENABLED`        | on      | `false` turns OAuth off (above).                                                                                                                                                                |
| `MCP_DCR_ENABLED`          | on      | `false` turns dynamic client registration off: only clients with a metadata document connect (above).                                                                                           |
| `MCP_ALLOWED_ORIGINS`      | none    | Browser origins, besides the gateway's, that may call `/mcp` (comma or space separated), e.g. `http://localhost:6274` for MCP Inspector's direct mode. AI apps call from servers and need none. |
| `MCP_AUDIT_RETENTION_DAYS` | 90      | Days of `mcp_tool_calls` the cron keeps.                                                                                                                                                        |
| `MCP_ACCESS_TOKEN_TTL`     | 3600    | Local testing only, in `.dev.vars` (`secret set --for gateway` refuses it): shorter access tokens, at least 60 seconds, honored only when `GATEWAY_URL` is `http://localhost` or `http://127.0.0.1`. |

## Upgrading from the 0.8.1 server

OAuth connections made with the old server (before this release) never
worked: the gateway refused every token it issued, and the server was off by
default. They don't carry over. Their grants hold neither this server's
resource nor a connection, so any use or refresh is refused (a refresh with
`invalid_grant`, which also deletes the grant), and their clients ask their
users to connect again. Nothing needs migrating.

Their records can stay in `OAUTH_KV`; they are inert. To remove them anyway,
delete the `grant:` and `token:` keys written before the upgrade (registered
clients, `client:*`, can stay):

```sh
npx cf kv namespaces list   # find every-app-gateway-OAUTH_KV's id
for prefix in grant token; do
  npx cf kv keys list --namespace-id <id> --prefix "$prefix:" \
    | jq '[.[].name]' > "oauth-$prefix-keys.json"
  npx cf kv bulk delete <id> --body "@oauth-$prefix-keys.json"
done
```

A list returns up to 1000 keys; repeat until both come back empty.

Do it before anyone connects with the new server, since it deletes their
grants too.

## Verify a deployed gateway

```sh
G=https://<gateway>
curl -si -X POST $G/mcp | grep -i www-authenticate
#  Bearer realm="OAuth", resource_metadata="$G/.well-known/oauth-protected-resource/mcp", scope="mcp:read"
curl -s $G/.well-known/oauth-protected-resource/mcp | jq '{resource, authorization_servers}'
#  resource is exactly "$G/mcp"; authorization_servers is ["$G"]
curl -s $G/.well-known/oauth-authorization-server \
  | jq '{issuer, client_id_metadata_document_supported, token_endpoint_auth_methods_supported, code_challenge_methods_supported}'
#  issuer "$G", CIMD true, "none" among the methods, ["S256"]
```

Then connect a client: `claude mcp add --transport http everyapp $G/mcp`, and
in Claude Code run `/mcp` → everyapp → Authenticate. The consent page opens;
allow it, and `everyapp_whoami` answers with your account.

## Connections

Each consent creates a connection (`mcp_connections`): the user, the
organization, the client and its verified domain (CIMD) or none (dynamic
registration), where access is sent, all apps or chosen ones, and read &
write or read only. Every `/mcp` request re-reads it with the member's role,
ban state and app access. It ends when:

- the user revokes it at `/settings/connections` (account menu → Connected
  AI apps);
- the member is removed from the organization, or deactivated (all of their
  connections);
- the same client connects again for the same user (the new one supersedes
  it, grant and all). A client with a metadata document (claude.ai, Claude
  Code, ChatGPT) shares one client id across installations, so only a
  connection through the same redirect URI is replaced; an app on the
  user's computer (Claude Code) counts as one installation whatever port it
  listens on, so a second computer's Claude Code replaces the first's;
- the client revokes its own token, or the grant lapses (30 days without a
  refresh); the list marks it ended;
- it goes unused for 31 days (the cron marks it expired).

Removing a user's access to an app only drops that app from their
connections' tools; the connections stay.

Destructive tools are hidden from every connection, and write tools from
read-only ones.

## Test locally

OAuth needs an issuer on `https`, or `http` on exactly `localhost` or
`127.0.0.1` (not `*.localhost`), so run the gateway there:

1. In `apps/every-app-gateway/.dev.vars` (gitignored), set
   `GATEWAY_URL=http://localhost:19300`, plus `BETTER_AUTH_SECRET`,
   `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` (`node regenerate-secrets.js`
   prints them). Add `MCP_ACCESS_TOKEN_TTL=120` to watch refreshes.
2. Apply the migrations to the local D1 and start the gateway on that port:

   ```sh
   cd apps/every-app-gateway
   pnpm db:migrate:local
   pnpm exec vite dev --port 19300 --strictPort
   ```

3. Claim it: `GATEWAY_URL=http://localhost:19300 pnpm setup-link` prints a
   one-time link; open it and create the owner.
4. Walk the whole flow with the scripted client, which plays the browser:

   ```sh
   EVERYAPP_EMAIL=you@example.com EVERYAPP_PASSWORD=… \
     node scripts/mcp-oauth-local.mjs --gateway http://localhost:19300 --conformance
   ```

   It checks discovery, registers a client as Codex does, authorizes,
   consents, exchanges the code, lists and calls tools on both protocol
   eras, refreshes with `client_id` only, revokes, and with `--conformance`
   runs the MCP conformance suite's authorization-server scenarios
   (`@modelcontextprotocol/conformance` 0.2.0-alpha.12, fetched with npx).
   `--read-only` consents to read only. To try a client with a metadata
   document instead of registering one, pass its public document's URL and
   a redirect URI it lists; the local gateway fetches the document from the
   internet. Claude Code's lists loopback redirects on any port:

   ```sh
   node scripts/mcp-oauth-local.mjs --gateway http://localhost:19300 \
     --cimd https://claude.ai/oauth/claude-code-client-metadata \
     --redirect-uri http://localhost:19313/callback
   ```

5. Or connect a real client:

   ```sh
   claude mcp add --transport http everyapp-local http://localhost:19300/mcp
   ```

   Use Chrome or Firefox for the consent page: its binding cookie is a
   `__Host-` (Secure) cookie, which they accept on `http://localhost`.

6. Run the hourly housekeeping on demand, through the Vite plugin's local
   explorer, then look for the `mcp.maintenance` line in the dev server's
   output:

   ```sh
   curl -X POST "http://localhost:19300/cdn-cgi/local/explorer/api/local/scheduled?worker=every-app-gateway" \
     -H 'content-type: application/json' -d '{"cron":"17 * * * *"}'
   ```

A gateway running under `vite dev` has no service bindings to apps, so it
lists only the built-in tools. App tools are covered end to end by the
gateway's tests (`src/server/mcp-auth/gateway-mcp.e2e.sqlite.test.ts`, real
SDK apps behind their bindings), and an app's own `/mcp` runs locally under
`everyapp dev`.

## Troubleshooting

- **A client can't connect.** The protected resource metadata's `resource`
  must equal the URL the user typed, path included and no trailing slash:
  `https://<gateway>/mcp`. Check `GATEWAY_URL` has no path.
- **`invalid_target` on a refresh.** The client sent a `resource` other than
  `<GATEWAY_URL>/mcp` (a trailing slash, an app host). It must connect again.
- **The consent page says it couldn't verify the app.** Its metadata
  document (CIMD) couldn't be fetched; the `mcp.oauth.cimd_failed` log line
  says why.
- **Logs:** `mcp.oauth.error` (the library's error category and reason),
  `mcp.connection.created` and `mcp.connection.revoked`, `mcp.tool_call` (one
  per call, also in `mcp_tool_calls`), `mcp.maintenance`.
