# Turning the MCP OAuth server on

The gateway's OAuth authorization server (for MCP clients) is off unless the
`MCP_OAUTH_ENABLED` secret is `"true"`. While it is off, `/oauth/*` and the
OAuth discovery documents return 404, app hosts stop advertising it, and
personal access tokens (`epat_`) are the only bearer credential. See
`apps/every-app-gateway/src/server/oauth-flag.ts`.

Leave it off until the perimeter can validate app-bound OAuth tokens: every
token it issues today is rejected by the perimeter.

## Before turning it on: clear old grants and tokens

Grants and tokens issued before the server was switched off stay in the
`OAUTH_KV` namespace (`every-app-gateway-OAUTH_KV`). Turning the flag back on
would bring them back to life, consented under older rules. Delete them
first. Registered clients (`client:*`) can stay.

1. Find the namespace id:

   ```sh
   npx wrangler kv namespace list
   ```

2. List what is there. Keys are `grant:<userId>:<grantId>` and
   `token:<userId>:<grantId>:<tokenId>`:

   ```sh
   npx wrangler kv key list --namespace-id <id> --prefix "grant:" --remote
   npx wrangler kv key list --namespace-id <id> --prefix "token:" --remote
   ```

3. Delete them in bulk. `kv bulk delete` takes a JSON array of key names:

   ```sh
   for prefix in grant token; do
     npx wrangler kv key list --namespace-id <id> --prefix "$prefix:" --remote \
       | jq '[.[].name]' > "oauth-$prefix-keys.json"
     npx wrangler kv bulk delete --namespace-id <id> --remote --force \
       "oauth-$prefix-keys.json"
   done
   ```

   List both prefixes again: they should come back empty.

## Turn it on

Set the flag as a secret, not a `vars` entry, so `everyapp gateway deploy`
keeps it:

```sh
npx wrangler secret put MCP_OAUTH_ENABLED --name every-app-gateway
# enter: true
```

Anything but `true` (case-insensitive) keeps it off.

## Verify

- `GET https://<gateway>/.well-known/oauth-authorization-server` returns the
  metadata document instead of 404.
- An unauthenticated request to an app's `/mcp` gets a 401 whose
  `WWW-Authenticate` header carries `resource_metadata`.
- Personal access tokens still work on `/mcp`.

## Turn it off again

```sh
npx wrangler secret delete MCP_OAUTH_ENABLED --name every-app-gateway
```

The endpoints return 404 again on the next request. Clear `grant:` and
`token:` keys again before any later re-enable.
