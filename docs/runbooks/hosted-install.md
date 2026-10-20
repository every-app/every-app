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
- every AI and capability call attributed to an organization and logged,
  with no per-organization usage limits yet (metering, the wallet, comes
  later);
- third-party deploys stay off (a launch gate, section 5).

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
stops with `MODE_CHANGE_UNSUPPORTED`. Once the first upload has succeeded,
later runs need no `--mode`, and a Gateway Worker deleted by hand comes
back, on the next `setup` or deploy, with the mode the install record keeps.
Until then, pass `--mode hosted` on every run: a run that resumes an install
stopped before its first upload, without `--mode`, installs `self_hosted`
and keeps it.

Leave `setup` waiting at the owner step (below) or stop it and run it again
when you are ready: a new run shows a new owner link.

## 2. Secrets

Each is a Gateway setting (`pnpm everyapp secret set <NAME>`,
live as soon as it is set; the Gateway's code comes from `pnpm everyapp
setup`). Apps never hold provider keys: the Gateway proxies them.

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
- `WORKERS_AI_API_TOKEN`: the AI proxy's Workers AI token, an API token
  from the "Workers AI" template (Workers AI Read and Edit) on this
  account; inference runs and bills in `CLOUDFLARE_ACCOUNT_ID`, which
  `setup` already set.
- `DATAFORSEO_API_KEY`: the integration proxy's DataForSEO credential.
- `CONTEXT_API_KEY`: the integration proxy's Context.dev key.

All five are settable (the integration proxy landed in #303).

Optional:

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
version). A registered app's senders and inbound addresses are set
afterwards with `pnpm everyapp email set --manifest ../open-seo/everyapp.config.ts …`
(a hosted Gateway takes no app senders); `register` makes no routes.
`--json` prints the same events as `deploy`; the `app.register` event's
`data.worker` lists what the Worker's own pipeline must give it:

- `EVERYAPP_IDENTITY_ISSUER` (`identityIssuer`) and
  `EVERYAPP_IDENTITY_PUBLIC_KEYS` (`identityPublicKeys`, JSON), so the SDK
  verifies the Gateway's identity JWTs;
- `EVERY_APP_GATEWAY`, a service binding to `every-app-gateway`, entrypoint
  `AppGateway`, with the props in `gatewayBinding.props`
  (`organizationId` is the platform organization's): the AI proxy refuses
  any other;
- `GATEWAY_URL`, and no `EVERY_APP_ORG_ID`;
- the plain-text vars in `vars`: `EVERYAPP_SHARED=1`, so the SDK refuses a
  gateway call that says nobody's.

Provider calls from a shared app say whom they are for. Serving a request,
they forward its identity (`for: request`): the Gateway attributes the
call to that member's organization. Background work
(cron, Workflow) names the organization (`for: { background: true,
organizationId }`, sent as `x-everyapp-org`), which the Gateway accepts
for an active organization with a live member and refuses with 403
otherwise; a call with neither is refused with 403.

## 5. Third-party deploys (the launch gate)

Customer code (forks of OpenSEO included) deploys through the Gateway's
deploy API into a Workers for Platforms dispatch namespace, never into the
account's own Workers (`docs/security-model.md`, "Hosted Deploy API").
**It stays off** until each of these is verified against a live namespace:
limits and the `Outbound` default-deny on every dispatch, the deployer's
binding allowlist and its read-back, identities minted for the Worker's
name, per-host sessions on the separate third-party domain, and the egress
default-deny. Off, the API's routes don't exist and no deploy key can be
made.

For the read-back, deploy an app with a D1 database and a Durable Object
class and check that the job succeeds: the comparison wants every field
the deployer sent back unchanged and lets Cloudflare add its own (a
service binding's `environment`, a Durable Object binding's
`namespace_id` and `script_name`), but a field the live API renames or
drops (a D1 binding's `id`, the gateway binding's `props`) fails every
deploy with `BINDINGS_MISMATCH` until `bindingMismatches` in
`src/server/deploy/metadata.ts` learns it.

A deploy runs in the request that starts it and the 30 seconds of
`waitUntil` after it: about 50 seconds in all. One that runs out (many
assets, slow migrations) stops where it was; if that is after the upload,
the Worker serves the new version while the registry row still records
the last one (a new app stays `pending`). Its job reads
`DEPLOY_ABANDONED` after 5 minutes, and the app can deploy again then. A
Durable Object or Queue runner is the fix.

What it needs, as Gateway settings (`pnpm everyapp secret set <NAME> --for
gateway`):

- `CF_DEPLOY_TOKEN`: an API token for this account with Workers for
  Platforms (Workers Scripts) edit and D1 edit.
- `DISPATCH_NAMESPACE`: the namespace's name; the Gateway's `DISPATCHER`
  binding (added to the hosted install with the namespace, with
  `outbound = { service = "every-app-gateway", entrypoint = "Outbound",
  parameters = ["everyapp"] }`) must name the same one.
- `THIRD_PARTY_DOMAIN`: the registrable domain apps are named on
  (`<app>-<orgKey>.everyapp.dev`), never `app.everyapp.com`: one that is,
  or is under or above, `APP_BASE_DOMAIN` makes every registration and
  deploy answer `DEPLOYER_NOT_CONFIGURED`. Unset, apps deploy but get no
  hostname. Any other value on the Gateway's own site (one whose last two
  labels are `everyapp.com`) is treated as unset: the session cookie's
  SameSite protection depends on the two being different sites.

The deployer's account is the Gateway's own `CLOUDFLARE_ACCOUNT_ID`, which
the install writes (`secret set` refuses it): the namespace must be in the
Gateway's account.

Third-party apps open on their own hosts, each with its own session handed
over by the Gateway (`docs/security-model.md`, "Third-Party Hosts and
Per-Host Sessions"). The CLI publishes only the Gateway's own Custom
Domains, so the third-party domain is wired by hand, once:

1. Add `everyapp.dev` as a zone in the Gateway's account.
2. A proxied wildcard DNS record: `AAAA *` → `100::` (the Worker answers;
   the address is never reached). Universal SSL covers `*.everyapp.dev`.
3. A Workers route on that zone: `*.everyapp.dev/*` → `every-app-gateway`.
   No route for the apex: it answers nothing.

After each `everyapp setup` or Gateway redeploy, check the route is still
listed on the Worker (Workers & Pages → every-app-gateway → Domains &
Routes): the CLI declares no route, and whether its deploy keeps one made
by hand is unverified against a live account.

The gate itself, `THIRD_PARTY_DEPLOYS=on`, is never set by the CLI: set it
by hand on the `every-app-gateway` Worker once the checks above pass, and
delete it to close the API again (deployed apps keep running; nobody can
deploy).

Then an organization's owner or admin makes a deploy key (Admin → Tokens →
Create access token → Kind: Deploy key; 30 days by default, optionally
bound to one app) and deploys from the app's directory, in CI too:

```sh
EVERYAPP_DEPLOY_TOKEN=<deploy key> EVERYAPP_GATEWAY_URL=https://app.everyapp.com \
  pnpm everyapp deploy --json
```

### Installing apps from GitHub

With the gate open, an organization's owner or admin can also install an
app without the CLI: Admin → Apps → **Install from GitHub**, paste
`https://github.com/<owner>/<repo>`, Install. The Gateway downloads the
repository's latest release asset `everyapp-release.tar.gz` (what
`everyapp` packs for a release: `release.json`, the tenant-neutral Build
Output and the migrations), checks its SHA-256 against `release.json`,
registers the app in the admin's organization and deploys it through the
same pipeline as the deploy API; the dialog follows the deploy job and
ends with the app's hostname. It is the same as a deploy key's deploy in
every rule above (policy, read-back, one deploy at a time, the 50-second
budget); `deployed_by_actor` is the admin's email and the job's `source`
column records the repository, tag, version and commit. A release's
manifest carries only the declarations (`capabilities.email`,
`email: { inbound: true }`); a third-party app can't declare inbound mail
(`BUNDLE_REFUSED`), and the hosted Gateway sends its mail from its own
sender.

- `NO_RELEASE`: the repository's latest GitHub release has no
  `everyapp-release.tar.gz` (or it has no releases, or it is private: the
  Gateway sends no credentials). Clone it and deploy with a deploy key as
  above.
- `RELEASE_CORRUPT`, `RELEASE_INVALID`, `RELEASE_UNSUPPORTED`: the asset
  isn't an app release this Gateway reads (a file doesn't match the
  SHA-256, a link or a path outside the archive, a Gateway release, a Build
  Output other than `v0`). `RELEASE_TOO_LARGE`: over 100 MB compressed or
  unpacked.
- The Gateway fetches from `github.com` and GitHub's release storage
  (`release-assets.githubusercontent.com` / `objects.githubusercontent.com`)
  from its own Worker: nothing to configure.

On a self-hosted Gateway, or with the gate shut, the button isn't shown and
the route answers `APP_INSTALL_NOT_AVAILABLE`.

## Checks

- `pnpm everyapp status --json`: `data.mode` is `"hosted"`.
- `https://app.everyapp.com/api/auth/sign-in-methods` answers
  `"signUp": "open"` (`"invitation"` with `HOSTED_OPEN_SIGNUP=false`),
  `"emailVerification": true` and no providers.
- A registry row with a `tier` or `scope` the Gateway doesn't know answers
  503 on its host: fix the row, never the code.
- A shared app opens at `https://<appId>.app.everyapp.com` for a member of
  any organization; `pnpm everyapp status` lists it.
- With third-party deploys wired: a third-party app at
  `https://<app>-<orgKey>.everyapp.dev` sends a signed-out browser through
  `https://app.everyapp.com/app-session` and back, signed in, with a
  `__Host-everyapp_s` cookie on the app host only; signing out of the
  Gateway signs the app host out on its next request. An unknown name under
  `everyapp.dev` answers 404 `unknown_app_host`.
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
