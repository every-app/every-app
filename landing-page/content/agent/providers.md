---
title: "API providers: the registry and the catalog"
description: "What an API provider is (beside an MCP app), the built-in catalog and the providers one Gateway registers, the spec's JSON fields and their rules, the request each auth kind makes, what a registered row may say, everyapp provider add, list, show and remove with their --json data, the codes, local development, and every catalog provider."
---

An **API provider** is an API the Gateway holds a key for and brokers calls to (DataForSEO, Context.dev, Stripe): an app lists it under `capabilities` in `everyapp.config.ts` and calls the provider's real URLs with `integrationFetch()`, and the Gateway puts the key on the call, so no app ever holds it. An **MCP app** (`pnpm everyapp mcp on dataforseo`, [/docs/agent/mcp](/docs/agent/mcp#mcp-apps)) is something else: an app of the Gateway's own with no page, whose tools members' AI clients call on `/mcp`. An MCP app is built on an API provider's entry (DataForSEO's tools call DataForSEO through the same proxy), and nothing on this page changes MCP apps. The design and its decisions are in the repository's docs/design/2026-10-provider-registry.md.

## The catalog and a Gateway's rows

Every provider the Gateway knows comes from one of two places, resolved as one lookup, the **registry** (`providerRegistry()` in `packages/sdk/src/internal/providerRegistry.ts`):

| Source               | What                                                                                                                                                                                                                            | Who changes it                                                              | How the Gateway reads it                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The built-in catalog | `CAPABILITIES` in `packages/sdk/src/internal/capabilities.ts`, in every Gateway and every SDK: the API-key providers, the AI providers, the OAuth clients and the Gateway's own services ([the table at the end](#the-catalog)) | A pull request; the tests in `packages/cli/src/docs` hold the docs to it    | Statically                                                                                                                                                                                                                                                                      |
| A Gateway's rows     | The `providers` table in the Gateway's D1 (`apps/every-app-gateway/drizzle/0013_providers.sql`): `id`, `spec` (the JSON below), `added_by`, `added_at`, `updated_at`, `bound_to`, `bound_at`                                    | The operator, with `pnpm everyapp provider add`, under the Cloudflare login | `apps/every-app-gateway/src/server/providers/index.ts`, cached 30 seconds per isolate: every row parsed and checked again on every read, and a row that fails is left out and logged `provider.row_invalid` (the id, the reason and the parser's message, never the row's spec) |

The catalog comes first and a row can never shadow it, so nothing a row says changes where a catalog provider's key goes. A row is the Gateway's, not an organization's: its key is one Gateway setting shared by every app and every organization on that Gateway, as a catalog provider's is. A Gateway whose D1 predates migration 0013, or whose rows can't be read, serves the catalog alone (logged `provider.rows_unavailable`, once per isolate).

The catalog has four kinds (`mode` in the code). Only the first is a spec a Gateway can register:

| Kind           | What the Gateway does                                                                                                                                                                                                | An app lists it under | The app calls                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| `api_key`      | Puts its key on calls to the provider's own hosts, with the methods the spec allows                                                                                                                                  | `capabilities`        | `integrationFetch({ env, provider, for })` on the provider's URLs |
| `ai`           | Puts its key on inference calls (the AI proxy's rules: inference routes only, `store: false`, the model allowlist). Never a capability: a key on an inference host reaches the account's files, batches and keys too | `providers`           | `createGatewayFetch({ env, for })` on `/api/ai/<id>/…`            |
| `oauth_client` | Holds the OAuth client and completes the provider's token endpoints only; the app keeps people's tokens                                                                                                              | `capabilities`        | `integrationFetch` on the token endpoint                          |
| `service`      | Does the work itself (`email`, `members`): no host, no spec                                                                                                                                                          | `capabilities`        | `sendEmail()`, `listMembers()`                                    |

An AI provider under `capabilities` is refused at deploy (`capabilities.openrouter: openrouter is an AI provider: list it under providers, not capabilities`), and `/api/integrations/openrouter/…` answers `400 invalid_integration_route`.

## How an app lists one

Nothing in the manifest is new. A registered provider is listed like a catalog one, with the need fields of [the manifest page](/docs/agent/manifest#required-optional-or-one-of-a-group):

```ts
capabilities: {
  stripe: { access: "read", why: "Shows the last ten charges on the dashboard." },
},
```

`access: "write"` takes effect only on a provider whose spec offers write: it unlocks the spec's `writeMethods`, and a call under an agent's identity (`chan: "mcp"`) still needs the `mcp:write` scope for them (`integration_read_only`). The app calls it with `integrationFetch({ env, provider: "stripe", for: request })`: an id outside the catalog is accepted, sent over the `EVERY_APP_GATEWAY` binding with only an https check, and the Gateway's checks decide.

`everyapp deploy` checks the manifest against the Gateway's registry once connected, so a registered provider's entry is checked like a catalog one (the access it offers, no scope sets), and an id neither the catalog nor the rows have is `CAPABILITY_UNKNOWN`, whose fix is `pnpm everyapp provider add <spec>`. An app's `secrets` may not name a row's setting either (the validator's wording for a Gateway name). `everyapp dev` can't ask the Gateway: it accepts an id outside the catalog and warns `CAPABILITY_NOT_IN_CATALOG` for each ([local development](#local-development)).

## The spec

One JSON object, the same shape every catalog entry has in TypeScript (`parseProviderSpec` in `packages/sdk/src/internal/providerSpec.ts` parses it; `providerSpecOf` writes a catalog entry back as one):

```json
{
  "id": "stripe",
  "name": "Stripe",
  "description": "Payments: customers, subscriptions, invoices.",
  "docs": "https://dashboard.stripe.com/apikeys",
  "api": "https://docs.stripe.com/api",
  "hosts": ["api.stripe.com"],
  "auth": { "kind": "bearer", "secret": "STRIPE_API_KEY" },
  "secrets": [
    {
      "name": "STRIPE_API_KEY",
      "hint": "A restricted key with read access to Customers and Charges is enough."
    }
  ],
  "access": ["read", "write"],
  "readMethods": ["GET", "HEAD"],
  "writeMethods": ["POST", "PUT", "PATCH", "DELETE"],
  "accountWidePaths": [
    ["v1", "account"],
    ["v1", "api_keys"]
  ],
  "data": "account",
  "hint": "A restricted key from the Stripe dashboard; the Gateway puts it on every call as a bearer token.",
  "smoke": {
    "method": "GET",
    "path": "/v1/balance",
    "expect": [200],
    "free": true
  },
  "cost": {
    "unit": "call",
    "usd": 0,
    "note": "Free; Stripe charges per transaction, not per call."
  },
  "rate": { "perSecond": 100, "note": "Live mode; test mode 25/s." },
  "example": "list my latest Stripe customers",
  "verified": { "on": "2026-10-25", "how": "docs" },
  "tags": ["payments"]
}
```

A spec names Gateway settings and never holds a value: no field takes one. Every field, with the parser's rule; any other field, anywhere in the object, is `unknown field`, and no text may hold a control character:

| Field              | Required                  | Rule                                                                                                                                                                                                                                                                | When absent                                |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `id`               | yes                       | Lowercase letters, digits and hyphens, a letter first, 2 to 40 characters (`^[a-z][a-z0-9-]{1,39}$`). A row may not take a catalog id or `everyapp`                                                                                                                 |                                            |
| `mode`             | no                        | `"api_key"` only: an AI provider or an OAuth client is a catalog entry, not a spec a Gateway takes                                                                                                                                                                  | `api_key`                                  |
| `name`             | yes                       | 1 to 64 characters: the provider's name in lists, errors and logs                                                                                                                                                                                                   |                                            |
| `description`      | no                        | At most 200 characters                                                                                                                                                                                                                                              |                                            |
| `docs`             | yes                       | An https URL, at most 500 characters: where the person gets the key                                                                                                                                                                                                 |                                            |
| `api`              | no                        | An https URL: the API reference                                                                                                                                                                                                                                     |                                            |
| `hosts`            | yes, unless `hostSetting` | At most 20 bare lowercase hosts with a dot and no scheme, port or path (`api.stripe.com`), none twice: the only hosts the key is ever sent to                                                                                                                       |                                            |
| `hostSetting`      | no                        | A setting name holding the host, for a provider whose host is the operator's ([below](#hostsetting-a-host-of-the-operators)); another setting than the key                                                                                                          |                                            |
| `data`             | no                        | `"per-call"` or `"account"` ([below](#data-whose-data-the-key-reaches))                                                                                                                                                                                             | neither                                    |
| `auth`             | yes                       | Where the key goes ([auth kinds](#auth-kinds-the-request-each-makes))                                                                                                                                                                                               |                                            |
| `secrets`          | no                        | `[{ name, hint? }]`: each `name` one of the settings `auth` or `hostSetting` names, once; `hint` at most 300 characters about that setting                                                                                                                          |                                            |
| `access`           | no                        | `["read"]`, `["write"]` or both: what an app's entry may ask for                                                                                                                                                                                                    | `["read"]`                                 |
| `readMethods`      | no                        | A non-empty list of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`: what any grant may use (a provider whose reads are POSTs lists `POST`)                                                                                                                         | `["GET", "HEAD"]`                          |
| `writeMethods`     | no                        | The same methods: what `access: "write"` adds, on a spec whose `access` offers write                                                                                                                                                                                | `["POST", "PUT", "PATCH", "DELETE"]`       |
| `accountWidePaths` | no                        | At most 50 runs of lowercase path segments (`[["v1", "account"]]`), refused wherever the segments appear together in a path, however spelled: endpoints that list or describe the whole account the key belongs to                                                  | `[]`                                       |
| `hint`             | no                        | At most 500 characters: what the key is and where it comes from, shown beside `why` wherever setup is ([`hint`](/docs/agent/json#done))                                                                                                                             |                                            |
| `smoke`            | no                        | `{ method, host?, path, expect, free, note? }`: one request that shows the key works. `method` `GET`, `HEAD` or `POST`; `host` one of `hosts` (the first when absent); `path` starting with one `/`; `expect` the statuses that mean it works; `free` true or false | the catalog table marks it "none recorded" |
| `cost`             | no                        | `{ unit, usd?, note?, responseField? }`: `unit` `call`, `result` or `token`; `usd` zero or more; `responseField` a top-level JSON field of the answer that reports the call's cost in US dollars, read into the usage counters                                      | no cost is read                            |
| `rate`             | no                        | `{ perSecond?, perMinute?, perDay?, note? }`: the provider's limits, as hints                                                                                                                                                                                       |                                            |
| `example`          | no                        | At most 200 characters: what to say to an agent to try it                                                                                                                                                                                                           |                                            |
| `verified`         | no                        | `false`, or `{ "on": "YYYY-MM-DD", "how": "docs" \| "live" }`: whether someone checked the spec against the provider                                                                                                                                                |                                            |
| `tags`             | no                        | At most 10 lowercase words                                                                                                                                                                                                                                          |                                            |

Setting names (`auth.secret`, `auth.user.secret`, `hostSetting`, `secrets[].name`) match `^[A-Z][A-Z0-9_]{2,63}$`. The parser reports every problem at once, each with its path, joined in the order of the table above as `PROVIDER_SPEC_INVALID`'s message: `hosts.0: must be a bare lowercase host with a dot and no port, path or scheme (api.stripe.com); auth.secret: must name a Gateway setting: upper case letters, digits and underscores, a letter first, 3 to 64 characters (STRIPE_API_KEY)`.

### Auth kinds: the request each makes

`secret` is always the name of a Gateway setting; the value is read from the Gateway's settings at the call, trimmed. While a setting `auth` names is unset or blank, calls answer `503 integration_not_configured`.

| `auth`                                                                                                   | What the Gateway puts on the request                                                                                                                                                                                                                                                                                                                                                                                      | Example                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `{ "kind": "bearer", "secret": "STRIPE_API_KEY" }`                                                       | `Authorization: Bearer <STRIPE_API_KEY>`; `"scheme": "Token"` (a token of letters, digits and hyphens) replaces the word                                                                                                                                                                                                                                                                                                  | Stripe, Context.dev, OpenAI                                               |
| `{ "kind": "header", "secret": "X_API_KEY", "header": "x-api-key", "prefix": "" }`                       | `<header>: <prefix><value>`. `header` is letters, digits and hyphens, never one the Gateway sets or strips itself (`host`, `cookie`, `content-length`, `content-type`, `transfer-encoding`, `connection`, `upgrade`, `te`, `trailer`, `keep-alive`, `proxy-authorization`, `proxy-authenticate`, `forwarded`, `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`, `x-everyapp-*`); `prefix` at most 32 characters | Anthropic's `x-api-key`, Klaviyo's `Authorization: Klaviyo-API-Key <key>` |
| `{ "kind": "query", "secret": "X_API_KEY", "param": "appid" }`                                           | `?appid=<value>` on the URL, replacing every copy of the parameter the app sent. The key is in the URL, so a 3xx answer is never relayed (`502 integration_upstream_redirected`), `location`, `content-location` and `refresh` are deleted from every answer, and a failed call logs the error's name only                                                                                                                | OpenWeather, Mapbox                                                       |
| `{ "kind": "basic", "secret": "X_API_KEY", "as": "password", "user": "api" }`                            | `Authorization: Basic base64(api:<value>)`: the key is the password beside a literal user (no colon, at most 128 characters)                                                                                                                                                                                                                                                                                              | Mailgun                                                                   |
| `{ "kind": "basic", "secret": "X_AUTH_TOKEN", "as": "password", "user": { "secret": "X_ACCOUNT_SID" } }` | `Authorization: Basic base64(<X_ACCOUNT_SID>:<X_AUTH_TOKEN>)`: the user is a second setting, another than `secret`                                                                                                                                                                                                                                                                                                        | Twilio                                                                    |
| `{ "kind": "basic", "secret": "X_API_KEY", "as": "username" }`                                           | `Authorization: Basic base64(<value>:)`: the key is the username, the password empty                                                                                                                                                                                                                                                                                                                                      | Segment, Mixpanel, Crisp                                                  |
| `{ "kind": "basic", "secret": "X_API_KEY", "as": "pair" }`                                               | `Authorization: Basic <…>`: the value is `login:password`, base64-encoded, or sent as it is when it holds no colon (already encoded)                                                                                                                                                                                                                                                                                      | DataForSEO                                                                |

`as` is required for `basic` and says where the key goes, never guessed from the value; `user` belongs to `as: "password"` only. Any other kind is refused (`auth.kind: must be bearer, header, query or basic (an OAuth client or an AI provider is a catalog entry, not a spec this gateway takes)`): an OAuth client or an AI provider is a catalog entry; a client-credentials exchange and signed requests (AWS SigV4, HMAC) aren't in this slice. A fixed header the provider wants on every call (`anthropic-version`, `Notion-Version`) is the app's to send: the Gateway forwards an app's ordinary headers. Every request also loses the app's `Authorization`, `x-api-key`, cookies, `x-everyapp-*` and forwarding headers before the key goes on, and is made with `redirect: "manual"`.

### `hostSetting`: a host of the operator's

For a provider whose host is per account (Shopify's `<shop>.myshopify.com`), the spec names `hostSetting`, a Gateway setting under the provider's prefix like its key (`SHOPIFY_HOST`), instead of or beside `hosts`. Its value is a bare host or an https origin with nothing else (no path, port, query or userinfo), and the key may go to that host as well as `hosts`; without a value the provider has no host there and the call is `400 invalid_integration_route`. The value's shape is checked when read (`hostSettingValue` in `packages/sdk/src/internal/capabilities.ts`); the operator who sets it decides the host.

### `data`: whose data the key reaches

`"per-call"`: each call is its own (search, scrape, inference, weather). `"account"`: every list is the whole account the key belongs to (Stripe, Airtable, Linear). One key is every organization's on a Gateway, so a hosted Gateway refuses an `account` provider (`503 integration_not_available_hosted`) until it holds per-organization keys; a self-hosted Gateway, one organization, serves it.

## What a row may say

Registering a provider gives the Gateway a new host to send a key to. These rules keep that from sending any other key anywhere, run by `provider add` before it writes and by the Gateway every time it reads a row (`checkProviderRow` and `providerRegistry` in `packages/sdk/src/internal/providerRegistry.ts`); each is a row of the threat model's register (B4):

| Invariant                               | The rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Refused as                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `providers.row-secret-is-its-own`       | Every setting a row names starts with its id upper-cased, `-` as `_` (`STRIPE_` for `stripe`, `TIKTOK_BUSINESS_` for `tiktok-business`), and is nobody else's: not one of the Gateway's own keys (`JWT_PRIVATE_KEY`, `BETTER_AUTH_SECRET`, …), a local-development setting, a name everyapp sets itself (`EVERYAPP_*`, `EVERY_APP_*`, `APP__*`), a settable Gateway setting (every catalog key and client, `MCP_*`, `CLOUDFLARE_ACCESS_*`, `EMAIL_*`), another row's (the earlier row keeps it), or a name a registered app lists under `secrets` (the message names the app) | `PROVIDER_SECRET_TAKEN`            |
| `providers.row-hosts-public-https`      | Each host is a public DNS name: not an IP address, `localhost`, or under `.localhost`, `.local`, `.internal` or `.arpa`; and not the Gateway's own host or under its `APP_BASE_DOMAIN` or `THIRD_PARTY_DOMAIN`. Calls go over https only                                                                                                                                                                                                                                                                                                                                      | `PROVIDER_HOST_REFUSED`            |
| `providers.builtin-precedence`          | A row never takes a catalog id or `everyapp`; the catalog is read first; a row a later catalog entry collides with is skipped and logged, never served                                                                                                                                                                                                                                                                                                                                                                                                                        | `PROVIDER_BUILTIN`                 |
| `providers.spec-names-no-values`        | The parser refuses unknown fields and control characters; `header` and `scheme` are tokens; a stored spec is parsed again on every read                                                                                                                                                                                                                                                                                                                                                                                                                                       | `PROVIDER_SPEC_INVALID`            |
| `providers.value-bound-to-hosts`        | A row's key is read only for the hosts and auth it was set for ([below](#the-key-is-bound-to-the-hosts-it-was-set-for))                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `integration_not_configured`       |
| `providers.add-is-privileged`           | Rows are written under the Cloudflare login (ADR-0003), or by an owner or admin through `everyapp_provider_add` and `everyapp_provider_remove` on a self-hosted Gateway (hidden on a hosted one); the Gateway has no HTTP route that writes the table, and the tools never replace a row nor remove a bound or listed one ([the provider tools](/docs/agent/mcp#provider-tools))                                                                                                                                                                                              |                                    |
| `providers.query-key-never-echoed`      | A `query` key never comes back to the app ([auth kinds](#auth-kinds-the-request-each-makes))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `integration_upstream_redirected`  |
| `providers.account-data-self-host-only` | An `account` provider is refused on a hosted Gateway ([`data`](#data-whose-data-the-key-reaches))                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `integration_not_available_hosted` |

The other direction holds too: an app whose `secrets` names a row's setting is refused at deploy, as for any Gateway setting.

## The key is bound to the hosts it was set for

A registered provider's setting is a Gateway setting like any other, set with `pnpm everyapp secret set STRIPE_API_KEY` from any directory. It isn't in `SETTABLE_GATEWAY_SETTINGS` (that list is the catalog's), so `secret set` connects first and asks the rows which provider holds the name. Before it asks for the value it prints whose it is and where it will go:

```text
STRIPE_API_KEY is Stripe's, registered by ops@example.com on 2026-10-25; the key is sent to api.stripe.com.
```

After the value is set it records on the row what the key was set for: `providerBindingKey` of the row (its `hosts`, `hostSetting` and `auth` as one canonical string) in `bound_to`, with `bound_at`. The Gateway reads the key for a row only while that still matches the row it has. So:

- A row added and never given a key is not set up: calls answer `503 integration_not_configured`, its status `configured: false`, and every app that lists it shows "Needs setup" (its setting reads as unset in `status`, `secret list` and the Gateway's app lists), even when the name happens to be set on the Gateway Worker.
- A row replaced (`provider add --replace`), removed and added again, or edited by hand in D1 is unbound until `secret set` runs again: calls answer `503 integration_not_configured` with `<Name>'s key was set for other hosts than the provider has now. Its operator sets it again with: everyapp secret set <NAMES>`. A person changing a row's hosts sets the key again; nobody who can only rewrite rows can move a key the operator set.
- `provider remove` leaves the setting on the Gateway Worker (`pnpm everyapp secret unset STRIPE_API_KEY` removes it), and nothing reads it until a new row is bound by a new `secret set`.

## The commands

```bash
pnpm everyapp provider add stripe.json        # or an https URL; prints the hosts and the secret set to run
pnpm everyapp secret set STRIPE_API_KEY       # names the provider and its hosts, then binds the row
pnpm everyapp provider list                   # the catalog and the rows: settings set and bound, the apps listing each
pnpm everyapp provider show stripe            # the whole spec as JSON, for an agent to call it
pnpm everyapp provider remove stripe          # refuses while an active app lists it
```

From an AI client, the same registry is three built-ins on the Gateway connector: `everyapp_provider_list` for every member, `everyapp_provider_add` (the spec object, never a URL, never a replace) and `everyapp_provider_remove` (refuses a bound or listed row) for owners and admins on a self-hosted Gateway; see [the provider tools](/docs/agent/mcp#provider-tools). A key is never set through a tool.

All four run from any directory under the Cloudflare login (as every Gateway command: `--gateway`, `--account-id`, `--json`, `--verbose`). A Gateway from before migration 0013 has no `providers` table: `add` and `remove` refuse and name `pnpm everyapp update`; `list` and `show` read it as having no rows.

| Command                                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `done.data` under `--json`                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm everyapp provider add <spec> [--replace]` | `<spec>` is a path to a JSON file, or an https URL fetched on this machine (64 KiB at most). Parses it, runs the rules above against the catalog, the other rows and the registered apps' manifests, and writes the row. An existing id is `PROVIDER_EXISTS` unless `--replace`, which leaves the row unbound until `secret set` runs again; a catalog id is `PROVIDER_BUILTIN`. Prints what was registered, the hosts the key will go to, and the one command to run next. Run in an app's directory (where `everyapp.config.ts` is), it also writes `.everyapp/providers/<id>.json` for `everyapp dev` | `{ id, name, hosts, settings, source: "row", next: [{ command: "pnpm everyapp secret set <names>", note }] }`                                                 |
| `pnpm everyapp provider list`                   | One table over the catalog's API-key, AI and OAuth entries and the rows: id, name, kind, hosts (or the host setting), each setting set or not (names only, read as `secret list` reads them) and for a row bound or not, where it comes from (the catalog, or registered by whom), the apps that list it. Through launch week it ends with one line, `MCP apps: pnpm everyapp mcp list`                                                                                                                                                                                                                  | `{ providers: [{ id, name, kind, hosts, hostSetting?, settings: [{ name, set }], bound, source, addedBy?, addedAt?, apps }], mcp: "pnpm everyapp mcp list" }` |
| `pnpm everyapp provider show <id> [--save]`     | The whole spec as JSON (`providerSpecOf` for an API-key provider; for an AI or OAuth entry, its name, docs, settings and hosts or token endpoints), with the hint, the smoke request, the apps that list it, and for a row who registered it, when, and whether its key is bound. `--save` writes `.everyapp/providers/<id>.json` in the current app's directory (refused outside one)                                                                                                                                                                                                                   | `{ provider, source, bound, addedBy, addedAt, apps }`, `provider` the spec                                                                                    |
| `pnpm everyapp provider remove <id> [--force]`  | Removes a row. A catalog id is `PROVIDER_BUILTIN`, an id with no row `PROVIDER_NOT_FOUND`, and a row an active app's manifest lists is `PROVIDER_IN_USE` (naming the apps) unless `--force`. The setting stays on the Gateway; the output says `secret unset` removes it                                                                                                                                                                                                                                                                                                                                 |                                                                                                                                                               |

`source` is `catalog` or `row`; `addedBy` is the Cloudflare login's email (or `api-token:<account id>`), `addedAt` epoch milliseconds. Nothing any of them prints or returns is a value: settings appear by name and set or not.

`everyapp provider` was the name of `everyapp mcp` until 2026-10-24. Through launch week, `pnpm everyapp provider on <id>` and `pnpm everyapp provider off <id>` stay as hidden routes that run `mcp on|off` and first print `everyapp provider on is now everyapp mcp on; this alias goes after launch week.`; `provider list` is this page's. The MCP apps' own codes, `PROVIDER_APP_UNKNOWN` and `PROVIDER_KEY_UNSET`, are unchanged.

## Codes

What each means; the fix for a CLI code is in its `data.fix` and on [the error codes page](/docs/agent/errors).

| Code                               | From                               | When                                                                                                                                                  |
| ---------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVIDER_SPEC_INVALID`            | `provider add`                     | The spec doesn't parse: the message is the parser's, every problem with its path. A URL that isn't https, answers more than 64 KiB, or isn't JSON too |
| `PROVIDER_EXISTS`                  | `provider add`                     | A row has the id; `--replace` replaces it (and unbinds its key)                                                                                       |
| `PROVIDER_BUILTIN`                 | `provider add`, `provider remove`  | The id is the catalog's, or `everyapp`                                                                                                                |
| `PROVIDER_NOT_FOUND`               | `provider remove`, `provider show` | Neither the catalog nor the rows have the id                                                                                                          |
| `PROVIDER_IN_USE`                  | `provider remove`                  | An active app's manifest lists the row; the message names the apps; `--force` removes it anyway                                                       |
| `PROVIDER_SECRET_TAKEN`            | `provider add`                     | A setting outside the row's prefix, or the Gateway's, the catalog's, another row's, or one a registered app lists under `secrets`                     |
| `PROVIDER_HOST_REFUSED`            | `provider add`                     | A host that isn't public, or is the Gateway's own or under its app or third-party domain                                                              |
| `CAPABILITY_UNKNOWN`               | `deploy`                           | The manifest lists an id neither the catalog nor the Gateway's rows have; fix `pnpm everyapp provider add <spec>`                                     |
| `CAPABILITY_NOT_IN_CATALOG`        | `dev` (a warning)                  | The manifest lists an id outside the catalog: it is reached locally only through `.everyapp/providers/<id>.json`                                      |
| `invalid_integration_route`        | the Gateway, 400                   | The host isn't one of the spec's (or its host setting's), the path could leave it, or the id is an AI provider's                                      |
| `capability_not_requested`         | the Gateway, 403                   | The app's deployed manifest doesn't list the provider                                                                                                 |
| `integration_path_not_allowed`     | the Gateway, 403                   | One of the spec's `accountWidePaths`                                                                                                                  |
| `integration_method_not_allowed`   | the Gateway, 405                   | A method outside `readMethods`, or a write method without `access: "write"` (the message says which)                                                  |
| `integration_not_configured`       | the Gateway, 503                   | A setting `auth` names is unset, or the row's key was set for other hosts (unbound); the message names the `secret set` to run                        |
| `integration_not_available_hosted` | the Gateway, 503                   | An `account` provider on a hosted Gateway                                                                                                             |
| `integration_read_only`            | the Gateway, 403                   | A write method under an agent's identity without `mcp:write`                                                                                          |
| `integration_upstream_redirected`  | the Gateway, 502                   | A `query` provider answered with a redirect, which is never relayed                                                                                   |
| `integration_upstream_failed`      | the Gateway, 502                   | The provider couldn't be reached                                                                                                                      |

The Gateway's refusals carry their code in `x-everyapp-error`, so `gatewayRefusal()` tells them from the provider's own errors. In the Gateway's logs, `provider.row_invalid` names a row it left out (`provider`, `reason` the refusal code, `message`), once per isolate.

## Local development

`everyapp dev` has no Gateway. For a catalog provider the SDK calls the provider directly with the developer's own key from `.dev.vars`, under the Gateway's setting name, by the same spec. For a registered provider it needs the spec too: `everyAppWorker()` reads `.everyapp/providers/*.json` in the app's directory into `EVERYAPP_DEV_PROVIDERS` (a JSON array of the specs), and `integrationFetch()` resolves the id from it and puts the key from `.dev.vars` (under the spec's setting names) where the spec's `auth` says. The file is what `pnpm everyapp provider show <id> --save` writes, or `provider add` run in the app's directory; a spec holds no value, so the file is safe to commit. Without a file the call throws a `ConfigurationError` that names the command, and `everyapp dev` warns `CAPABILITY_NOT_IN_CATALOG` for the id when it starts.

## The catalog

Generated from `CAPABILITIES` by `pnpm -C packages/cli docs:update`; a test fails CI when it is stale. Step by step for each: the everyapp skill's `setup/providers.md`, under the provider's id (`setup/providers.md#<id>`), and the provider's own setup file where it has one.

<!-- prettier-ignore-start -->
<!-- providers-catalog:begin (generated from packages/sdk/src/internal/capabilities.ts by packages/cli/src/docs/providersCatalog.ts; pnpm -C packages/cli docs:update) -->

The built-in catalog has 23 providers: 2 API-key, 3 AI, 18 OAuth clients.

| Id | Name | Kind | Settings | Hosts | How the key is sent | Where the key comes from | Smoke request | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `dataforseo` | DataForSEO | `api_key` | `DATAFORSEO_API_KEY` | `api.dataforseo.com`, `sandbox.dataforseo.com` | `Authorization: Basic <DATAFORSEO_API_KEY>`, the value `login:password` base64-encoded (or sent as it is when it holds no colon: already encoded) | https://app.dataforseo.com/api-access; API reference https://docs.dataforseo.com/v3/ | `GET https://api.dataforseo.com/v3/appendix/user_data`, expecting 200; free. Account-wide, so the Gateway refuses it for apps; run it from the person's terminal. | 2026-10-25, live |
| `context` | Context.dev | `api_key` | `CONTEXT_API_KEY` | `api.context.dev` | `Authorization: Bearer <CONTEXT_API_KEY>` | https://context.dev/ | none recorded | 2026-10-25, live |
| `openai` | OpenAI | `ai` | `OPENAI_API_KEY` | `api.openai.com` | `Authorization: Bearer <OPENAI_API_KEY>` | https://platform.openai.com/api-keys; API reference https://platform.openai.com/docs/api-reference | none recorded | 2026-10-25, live |
| `openrouter` | OpenRouter | `ai` | `OPENROUTER_API_KEY` | `openrouter.ai` | `Authorization: Bearer <OPENROUTER_API_KEY>` | https://openrouter.ai/settings/keys; API reference https://openrouter.ai/docs | none recorded | 2026-10-25, live |
| `workers-ai` | Workers AI | `ai` | `WORKERS_AI_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (set by `everyapp setup`) | `api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai` | `Authorization: Bearer <WORKERS_AI_API_TOKEN>` | https://dash.cloudflare.com/profile/api-tokens; API reference https://developers.cloudflare.com/workers-ai/ | none recorded | 2026-10-25, live |

OAuth clients (`oauth_client`: the Gateway completes their token endpoints only, and the spec parser takes none as a row): `linkedin`, `facebook`, `instagram`, `threads`, `youtube`, `tiktok`, `tiktok-business`, `reddit`, `pinterest`, `discord`, `slack`, `mastodon`, `kick`, `twitch`, `tumblr`, `dribbble`, `google-workspace`, `microsoft-365`. Their settings, consoles, redirect URIs, token endpoints and scope sets are generated in [the capabilities document](/docs/agent/repo/capabilities#oauth-clients). Gateway services (`service`: no host, no spec): `email`, `members`.

<!-- providers-catalog:end -->
<!-- prettier-ignore-end -->

## Sources

- The catalog, the auth kinds and `CapabilityLookup`: `packages/sdk/src/internal/capabilities.ts`.
- The spec parser: `packages/sdk/src/internal/providerSpec.ts`. The row rules and the registry: `packages/sdk/src/internal/providerRegistry.ts`.
- The Gateway's registry and its host rule: `apps/every-app-gateway/src/server/providers/index.ts`; the table: `apps/every-app-gateway/src/db/providers.schema.ts`; the reads: `apps/every-app-gateway/src/server/repositories/ProviderRepository.ts`.
- The proxy and the order of its checks: `apps/every-app-gateway/src/server/integration-proxy.ts`, written out in [the capabilities document](/docs/agent/repo/capabilities#what-the-gateway-checks-on-an-api-key-call).
- The commands: `packages/cli/src/commands/provider/`.
- The design and its decisions: docs/design/2026-10-provider-registry.md in the repository. The invariants: [the threat model](/docs/agent/repo/threat-model), B4.
