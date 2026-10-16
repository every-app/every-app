# Hosted Install

The hosted Gateway (`app.everyapp.com`) is our own install of the same
Gateway a customer self-hosts, with the hosted policy
(`GATEWAY_DEPLOYMENT_MODE=hosted`, see
`apps/every-app-gateway/src/server/platform-policy.ts` and
`docs/security-model.md`, "Deployment Mode"):

- anyone signs up, into an organization of their own, and verifies their
  email first;
- first-party apps (OpenSEO, todo, chef, workout) are shared: one Worker per
  app, owned by the platform organization, opened by members of any active
  organization, each reached over its service binding as on self-host;
- no Cloudflare Access sign-in (its settings are ignored);
- organization admins manage memberships, never accounts (no deactivating,
  resetting or deleting someone's account from an organization);
- per-organization daily caps on the AI proxy (200 requests, a 429 with
  `Retry-After` past it) and the integration proxy (500, with its PR);
- third-party deploys stay off (a launch gate).

Until Google verification and the wallet exist, the preview is invite-only:
set `HOSTED_OPEN_SIGNUP=false` (below) and people join by invitation.

## 1. Install

From a checkout of the repository, logged in to our Cloudflare account
(`npx cf auth login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`):

```sh
pnpm everyapp setup --domain app.everyapp.com --mode hosted
```

This is the self-host install with one difference: the Gateway's first
upload sets `GATEWAY_DEPLOYMENT_MODE=hosted`, and the install record keeps
the mode (`pnpm everyapp status` prints `Mode:     hosted`). The mode never
changes after the first upload; `setup --mode self_hosted` on this Gateway
stops with `MODE_CHANGE_UNSUPPORTED`. Later runs need no `--mode`, and a
Gateway Worker deleted by hand comes back, on the next `setup` or deploy,
with the mode the install record keeps.

Leave `setup` waiting at the owner step (below) or stop it and run it again
when you are ready: a new run shows a new owner link.

## 2. Secrets

Each is a Gateway setting (`pnpm everyapp secret set <NAME> --for gateway`,
which redeploys the Gateway with it). Apps never hold provider keys: the
Gateway proxies them.

Email, needed for verification, invitations and password resets
(`docs/runbooks/email-sending-setup.md`). Without it the hosted Gateway
refuses every sign-up (`EMAIL_NOT_CONFIGURED`, logged as
`auth.sign_up_refused`): new accounts couldn't verify their email.

- `EMAIL_FROM`, e.g. `noreply@everyapp.com` (the domain onboarded for
  Cloudflare Email Sending first), and `EMAIL_FROM_NAME`, e.g. `Every App`.
- `EMAIL_REST_API_TOKEN`, unless the Worker sends through its `EMAIL`
  binding.

Mail is budgeted per UTC day and kind: 5 emails per address, and 2,000
verification, 1,000 reset and 2,000 invitation emails for the whole
Gateway. A refused mail logs `email.send.failed` with
`EMAIL_BUDGET_EXHAUSTED`.

Provider keys:

- `OPENAI_API_KEY`: the AI proxy's OpenAI key.
- `OPENROUTER_API_KEY`: the AI proxy's OpenRouter key (OpenSEO's models).
- `DATAFORSEO_API_KEY`: the integration proxy's DataForSEO credential.
- `CONTEXT_API_KEY`: the integration proxy's Context.dev key.

`OPENAI_API_KEY` is settable today; the other three become settable with the
integration-proxy PR, which adds the proxy that reads them.

Optional:

- `AI_PROXY_ORG_DAILY_LIMIT`, `INTEGRATION_ORG_DAILY_LIMIT`: whole numbers
  replacing the default caps (200 and 500 requests per organization per UTC
  day). Anything that isn't a whole number stops that proxy for everyone
  (0), so check the value.
- `HOSTED_OPEN_SIGNUP`: `false` keeps sign-up invite-only (the preview);
  unset or `true` lets anyone sign up into an organization of their own.
  Any other value is invite-only.

Never set the `CLOUDFLARE_ACCESS_*` settings or `EMAIL_PASSWORD_SIGN_IN` on
the hosted Gateway: they are ignored there, and the Gateway logs that once
per isolate.

## 3. Claim the owner

`setup` opens the one-time owner link (at a terminal; under `--json` it is in
the `claim_owner` event). Create the owner account with it, under your own
name. The claim makes the install organization, which on the hosted Gateway
is the platform organization: it owns the first-party apps, and the claim
names it **Every App** (slug `every-app`) whatever the owner is called (a
self-hosted Gateway names it after the owner). Then confirm:

```sh
pnpm everyapp status
```

shows `Mode:     hosted` and `Owner:    <email> (Every App)`.

The owner's email counts as verified (the setup link is ours), so they sign
in straight away. Open sign-up starts only after the claim.

## 4. Deploy the first-party apps

Each first-party app is a shared app: a registry row of the platform
organization with `scope='shared'`, at `<appId>.app.everyapp.com`, reached
over its service binding (`APP__<worker>`) as on self-host, one Worker for
every organization. Any live member of any active organization opens it,
and its identity JWT carries that member's `org_id` and `org_role`: the app
scopes its data by them (todo, chef and workout are per user; OpenSEO scopes
by organization). Only owners and admins of the platform organization deploy
or register one: a Cloudflare login must be one of them by its verified
email (sign up on the Gateway with the same email); an API token
(`CLOUDFLARE_API_TOKEN`, CI) is the account's own authority. Both commands
refuse a Gateway whose install record isn't `hosted`
(`SHARED_APPS_UNAVAILABLE`).

An app the CLI builds, from its directory:

```sh
pnpm everyapp deploy --shared
```

It deploys as any app does, with two differences: the row is shared (nobody
is granted it, and it has no "Available to everyone" switch), and the Worker
gets no `EVERY_APP_ORG_ID`, since it serves every organization. An app keeps
the scope it was registered with: later deploys, and `secret set|unset`
(which redeploy it), keep it shared with or without `--shared`, and still
need a platform owner or admin. An organization app's id can't become a
shared one (`APP_SCOPE_MISMATCH`; delete it and pick another id). Deleting a
shared app (`everyapp delete`) cuts every organization off from it, so it
too takes a platform owner or admin (`SHARED_APP_FORBIDDEN` otherwise).

A Worker deployed by other means (OpenSEO's Alchemy stage, say), in the
Gateway's account:

```sh
pnpm everyapp register openseo --worker every-everyapp-openseo --shared --manifest ../open-seo/everyapp.config.ts
```

`register` checks the Worker exists, validates the manifest as `deploy`
does, registers the app under the Worker name the Gateway gives it
(`every-<platform org key>-<appId>`, `every-everyapp-<appId>` for the
"Every App" organization; any other `--worker` stops with
`WORKER_NAME_MISMATCH`, which names it), records the Worker's live version,
redeploys the Gateway to bind it and publish its hostname, and waits for it
to go live. It never uploads or changes the Worker, and `delete --purge`
keeps it. Run it again after the Worker's own pipeline ships a version, so
the registry records it (the Gateway re-reads the app's tools on a new
version). `--json` prints the same events as `deploy`; the `app.register`
event's `data.worker` lists what the Worker's own pipeline must give it:

- `EVERYAPP_IDENTITY_ISSUER` (`identityIssuer`) and
  `EVERYAPP_IDENTITY_PUBLIC_KEYS` (`identityPublicKeys`, JSON), so the SDK
  verifies the Gateway's identity JWTs;
- `EVERY_APP_GATEWAY`, a service binding to `every-app-gateway`, entrypoint
  `AppGateway`, with the props in `gatewayBinding.props`
  (`organizationId` is the platform organization's): the AI proxy refuses
  any other;
- `GATEWAY_URL`, and no `EVERY_APP_ORG_ID`.

Provider calls from a shared app forward the identity of the request they
serve (`createGatewayFetch` does): the Gateway counts the call, and the
daily cap, against that member's organization. A call with no identity
(cron, Workflow) is refused with 403 until background attribution lands.

## Checks

- `pnpm everyapp status --json`: `data.mode` is `"hosted"`.
- `https://app.everyapp.com/api/auth/sign-in-methods` answers
  `"signUp": "open"` (`"invitation"` with `HOSTED_OPEN_SIGNUP=false`),
  `"emailVerification": true` and no providers.
- A registry row with a `tier` or `scope` the Gateway doesn't know answers
  503 on its host: fix the row, never the code.
- A shared app opens at `https://<appId>.app.everyapp.com` for a member of
  any organization; `pnpm everyapp status` lists it.
- To suspend an organization, set its status in the Gateway's D1; within
  30 seconds its members get 403 everywhere, and `'active'` restores it:

  ```sh
  npx cf@1.0.0-beta.14 d1 list --name every-app-gateway   # its id
  npx cf@1.0.0-beta.14 d1 query <id> \
    --sql "UPDATE organizations SET status = 'suspended' WHERE slug = 'acme'"
  ```
- An owner link that answers `SETUP_UNAVAILABLE` means the Worker's
  `GATEWAY_DEPLOYMENT_MODE` secret is missing or isn't `self_hosted` or
  `hosted` (someone changed it by hand; `everyapp secret set` refuses the
  name). Set it on the `every-app-gateway` Worker, in the Cloudflare
  dashboard, to the mode `pnpm everyapp status` prints.
