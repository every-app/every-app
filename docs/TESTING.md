# Every App v2 — Testing & Verification

This document covers (A) running the automated suites, (B) local manual
testing via `everyapp dev`, and (C) production verification + rollback.

The v2 security perimeter is the part that must never regress, so its tests are
the priority. Where a step is not yet automated, it says so explicitly.

---

## A. Automated test suites

Each package has a `test` script (vitest). From the repo root:

```bash
pnpm install
pnpm test          # runs `pnpm -r --no-bail run test` across all packages
```

### What is green today

| Package | Suite | Covers |
|---|---|---|
| `packages/sdk` | `src/**/*.test.ts` | fail-closed identity verification: alg/kid pinning, `alg:none`, algorithm-confusion (HS256-with-public-key), wrong key, expiry, audience mismatch, missing claims, public-route handling, `everyApp()` handler wrapper; the catalog's settings generated from `CAPABILITIES` (`src/cloudflare/catalogSettings.test.ts` fails while `catalogSettings.generated.ts` is out of date; `pnpm -C packages/sdk catalog:update` regenerates it) |
| `packages/perimeter` | `src/**/*.test.ts` | public-route glob matching incl. path-traversal + percent-encoding (`/p/%2e%2e/__everyapp/...`), header stripping, security headers, CSRF default-deny, JWT mint, Host parsing, the full `handleGatewayRequest` proxy core, the dev gateway-lite, and an end-to-end perimeter↔real-SDK integration test |
| `apps/every-app-gateway` | legacy `src/**/*.test.ts` | pre-existing gateway tests (still green), including the platform policy per deployment mode (`src/server/platform-policy.test.ts`, and the hosted and invalid cases next to what each switch governs: Access sign-in, the setup claim, account actions, dynamic registration, app activation) |
| `apps/every-app-gateway/src/server/deploy/cf-rest` (part of the gateway suite) | `*.test.ts` | the Cloudflare REST client's request shapes against a fetch mock: multipart uploads (boundary, `metadata` JSON part, each module's MIME type), settings and secrets bodies, tag filters and the refusal to delete by tag without a required tag, D1 single and batch queries, Worker pagination, the assets upload session; error envelopes mapped to `CloudflareApiError` (code, message, status), retries on 429 and on 5xx only for idempotent methods |
| `packages/cli` | `src/**/*.test.ts` | the `cf` runner, the Gateway pipeline (`setup`) and the app pipeline (`deploy`) end to end against a fake Cloudflare account (`src/test/fakeCloudflare.ts`: SQLite D1 with the gateway's real migrations, Build Outputs validated with cf's schema; its REST API as a fetch in `src/test/fakeCloudflareApi.ts`, with Workers for Platforms dispatch namespaces, multipart script uploads, bindings, secrets, settings, tags and assets, driven through the gateway's cf-rest client, imported by path, in its own test) and the deployed gateway Worker as far as the CLI meets it (`src/test/gatewayWorker.ts`: hostnames that answer, activation on the first request, the owner claim), the app registry the CLI writes in D1 and the live wait (`lib/gateway/registry.test.ts`), finding the Gateway through the login's accounts (`lib/gateway/discover.test.ts`: one, several, a token scoped to one, none, a wrong `--account-id` or `--gateway`), the Gateway build cache by tree hash and the release order by commit time (`lib/gateway/checkoutRelease.test.ts`, in a scratch git repository with a fake build), the downgrade guard and one upload per bind (`lib/gateway/apply.test.ts`), `setup` (install, upgrade, repair, the owner wait) and `status` (with `upToDate` against a stand-in checkout), `deploy`'s offer to install the Gateway, `secret unset`, the app policy check, leases, remote migrations; what a person sees (`lib/output/events.test.ts`: milestones rendered from event data, problems with their next command) and that `deploy --json` writes nothing but NDJSON to stdout, with a real child's output in its log file (`commands/deploy/stdout.test.ts`), and the skills `create` copies into a new app (`lib/app/skill.test.ts`; the build-every-app skill's citations in `lib/app/buildSkill.test.ts`); `access`, `provider`, `secret`, `status`, `install` and `teardown` against the same fake account (`commands/<name>/*.test.ts`); and the agent docs against the code (`src/docs/agentDocs.test.ts`: a new command, flag, error code, manifest field or Gateway setting fails until it is documented; `pnpm -C packages/cli docs:update` regenerates the generated pages) |

Run a single layer:

```bash
# Perimeter + integration
( cd packages/perimeter && pnpm test )

# SDK identity verifier
( cd packages/sdk && pnpm test )

# CLI manifest/compiler
( cd packages/cli && pnpm test )
```

### Typecheck / build

```bash
( cd apps/every-app-gateway && pnpm run types:check )   # clean
( cd packages/sdk && pnpm run types:check && pnpm run build )   # clean
( cd packages/cli && pnpm run types:check )             # clean
```

### In CI

`.github/workflows/pr-checks.yml` (every pull request, and pushes to main):
`pnpm types:check`, the gateway's `auth:check`, the SDK's
`check:esm-relative-imports`, `pnpm audit --audit-level critical`,
`pnpm format:check`, `pnpm knip` and `pnpm test`. `cf-dry-run.yml`:
`pnpm -C apps/every-app-gateway build:release`, then
`EVERYAPP_CF_DRY_RUN=1 pnpm -C packages/cli exec vitest run src/lib/cfDryRun.test.ts`
runs `cf deploy --prebuilt --dry-run` on the gateway release and the starter,
so a cf or Vite plugin bump that changes the Build Output fails here, not in
a live deploy. `built-cli.yml` ("Built CLI"): builds the SDK and the CLI,
then `pnpm -C packages/cli test:built` runs
`packages/cli/src/bin/builtCli.test.ts`, the CLI as people run it:
`bin/everyapp.js` over `dist/` as a child process, against a fresh app in a
temp directory outside the checkout with no Cloudflare account (help for
every route, `create`, `db migrate`, `dev` to its first 200 and down on
SIGINT, the capability manifests the built CLI refused on 2026-10-24 (#543),
`release`, and `status --json` against the fake account through the
`EVERYAPP_CF_BINARY` seam in `packages/cli/src/lib/cf/bin.ts`). Every other
test resolves the workspace packages from source, so only this one sees what
the tsup bundle does differently. Locally, from the checkout's root,
`pnpm test:built-cli` builds both and runs it (about a minute; the new app's
`pnpm install` needs the network). The security review is not a workflow:
`pnpm security-review` (`scripts/security-review.mjs`, the `security-review`
skill in `.claude/skills/`) runs Anthropic's security review for Claude Code
locally over the branch's diff, against `docs/threat-model.md`, before a
pull request that touches a boundary; it is advisory (the diff enters the
prompt, so a stranger's branch gets a person's read first), and
`packages/cli/src/lib/securityReview.test.ts` pins its exit codes, what the
diff carries and the flags Claude Code gets, with a fake `claude` on PATH.

> **Honest status:** the legacy gateway control plane (iframe embed,
> `/api/session-token`, postMessage/expo machinery, `app_url`/`dev_url`
> columns) is **deleted**, and the production worker entry
> (`apps/every-app-gateway/src/server.ts`) now routes app subdomains through
> the v2 perimeter; `everyapp deploy` ships private workers and
> `everyapp setup --domain` publishes the gateway host and each app host as
> Workers Custom Domains. The v2 model is proven
> end-to-end by `packages/perimeter/src/integration/e2e.test.ts`.

### The end-to-end perimeter test (the headline)

`packages/perimeter/src/integration/e2e.test.ts` wires the **real** gateway proxy core to a
**real** sub-app built with the **real** `@every-app/sdk` `everyApp()` over an
in-process service binding, and asserts:

- (a) a logged-in request reaches the app with a **verified** identity;
- (b) a request straight to the app worker (no gateway) yields **401**;
- (c) a declared public route works unauthenticated; everything else 401s;
- (d) `/__everyapp/*` is unreachable unauthenticated, but reachable *with* a
  valid identity; the internal tools contract (`/__everyapp/tools/*`) is 404
  from outside under any encoding, signed in or not;
- (e) the inbound `Cookie` and a spoofed `x-everyapp-identity` are
  stripped/replaced before the app sees the request;
- cookie tossing: a session cookie a sibling subdomain planted beside the
  member's own (any order, with or without `__Secure-`, public routes too)
  is refused with 401 before authentication, and a single cookie still
  works;
- (f) a token the gateway minted for one Worker is refused by another
  Worker of the same app id (identities carry `aud` = the Worker name, and
  the fixture Workers get `EVERYAPP_AUDIENCE` as `everyAppWorker()` deploys
  them).

The seam itself, `getAppFetcher`, is covered by
`packages/perimeter/src/getAppFetcher.test.ts` with a fake Workers for
Platforms namespace (found, not found from `get` or the first fetch,
missing `DISPATCHER`, the naming-rule re-check, limits and the outbound
parameter passed through), and the dispatched apps' egress policy by
`apps/every-app-gateway/src/server/outbound.test.ts`.

### MCP conformance (the ToolBus)

`packages/toolbus` runs the official MCP conformance suite
(`@modelcontextprotocol/conformance@0.2.0-alpha.12`) against a local ToolBus:
the dev ToolBus in front of a real `everyApp()` + `defineTools()` app, on a
loopback port. It covers both protocol eras: `server-stateless`,
`http-header-validation`, `caching`, `tools-list` and
`dns-rebinding-protection` at 2026-07-28, and `server-initialize`, `ping`,
`tools-list` (and `dns-rebinding-protection`) at 2025-11-25 and 2025-06-18.

```bash
cd packages/toolbus
pnpm test:conformance                          # downloads the suite with npx
CONFORMANCE_PORT=19432 pnpm test:conformance   # pin the port (default: any free one)
```

`packages/toolbus/conformance-baseline.yml` lists the checks the ToolBus is
expected to fail, with the reason for each: the suite's diagnostic tools,
subscriptions (off), and prompts/resources (not served). Any other failure
fails the run, and so does a baseline entry that starts passing (delete it).
It needs the network, so it isn't part of `pnpm test` or CI.

### Claude Code against the held listen stream (the ToolBus)

`packages/toolbus/claude-code/listen-reopen.claude.ts` drives a real
`claude -p` (stream-json in and out, kept alive on stdin) against a
gateway-surface ToolBus on a loopback port (`claude-code/server.ts`, the real
HTTP layer with a re-readable view) and counts, on the server, the held
`subscriptions/listen` streams Claude Code opens, when each ends, and whether
a pushed `list_changed` makes it refetch `tools/list` (hearing) or not
(deaf). Claude Code's own `--debug-file` log is read for its reopen
decisions. Three phases, chosen with `LISTEN_PHASE`:

```bash
cd packages/toolbus
LISTEN_PHASE=smoke pnpm test:claude-code   # a 20 s hold: one reopen, one change heard (2 min)
LISTEN_PHASE=today pnpm test:claude-code   # the old 10-minute hold scaled to 60 s: deaf after five reopens (9 min)
LISTEN_PHASE=fixed pnpm test:claude-code   # the 30-minute hold in real time: still hearing past 90 minutes (95 min)
LISTEN_REPORT_DIR=/tmp/reports LISTEN_MODEL=sonnet   # where the timeline goes; the model (sonnet by default)
```

It needs the `claude` CLI logged in and spends a few cents per phase, so it
is not part of `pnpm test` or CI; the unit tests in `src/http.test.ts` pin
the constants and the stream's behaviour without a client.

### Hosted deploy API (third-party apps)

The hosted tier (app.everyapp.com, dispatch apps, deploy keys) is not
launching and its CLI surface is gone (`docs/hosted-vision.md`); this
section, the next two and "Hosted sign-up" describe the suites that keep the
gateway's hosted code honest.

`apps/every-app-gateway/src/server/deploy/deploy-api.sqlite.test.ts` runs
the real worker entry on SQLite with the launch gate open, and the CLI's
fake Cloudflare (`packages/cli/src/test/fakeCloudflare.ts`, loaded by path)
behind the deployer's REST calls and the gateway's `DISPATCHER` binding
(`FakeCloudflare.dispatcher()`): an owner's deploy key registers and
deploys an app built with everyAppWorker() (the tenant-neutral build,
placeholders throughout); the registry row is `dispatch`, the app's D1 is
created and migrated, the namespaced Worker's bindings are the deployer's
own (none of the placeholders left) and read back, and a request to its host
dispatches through getAppFetcher with the Worker's audience. It refuses
without the gate (and on a self-hosted gateway), a member's key, an access
token, a key holding any scope beside `deploy`, another organization, a
bundle with a binding outside the allowlist (before anything is created),
a bundle dropping a live Durable Object class (before its migrations run),
a stamp below the protocol floor, a key bound to another app, a second
deploy while one runs (leaving the row untouched, until it is past its
deadline), a third-party domain on, under or above `APP_BASE_DOMAIN`, and
a database with the app's name that no deploy of it created; it deletes
the Worker when the bindings read back differ, answers with the job when
its outcome can't be recorded, finishes a database a failed create left
claimed (made by Cloudflare or not), and deploys without a third-party
domain (no hostname).
`metadata.test.ts` covers the allowlist, Durable Object migrations and the
read-back comparison (fields Cloudflare adds pass, changed or missing ones
don't). The CLI side of the deploy API (deploy-key deploys) was removed on
2026-10-24 with the hosted-only CLI surface (restorable from `5ef30882`).

`install-api.sqlite.test.ts` covers Admin → Apps → Install app the
same way, calling the admin routes (`src/routes/api/admin/`) with a
session and a fake GitHub that serves an app release packed in the test
(`src/test/app-release.ts`: a tiny tar writer and Node's zlib): an admin
installs it (the job records the repository, tag, version and commit), and
the namespaced Worker gets exactly what a multipart deploy of the same
bundle gives it. It refuses without the gate (and on a self-hosted
gateway), a member, a signed-out caller, a suspended organization, a URL
that isn't a GitHub repository, a repository with no release (with the
clone-and-deploy advice), a tampered release and a bundle the policy
refuses, all before anything is registered, and a second deploy while one
runs. `release.test.ts` covers the tar reader (links, devices, absolute
and `..` paths, duplicates, bad checksums), the sha256 check, helper
Workers, the redirects to the tag, and the size caps (by length and as a
gzip bomb).

### Third-party hosts and per-host sessions

`apps/every-app-gateway/src/server/third-party-hosts.sqlite.test.ts` runs
the real worker entry and Better Auth on SQLite on a hosted gateway at
`app.everyapp.com` with the third-party domain `everyapp.dev`, two dispatch
apps registered by the deploy API's rules behind a fake `DISPATCHER`, and a
shared first-party app: the host classifier and the domain checks; the
handoff end to end (app host redirect with its nonce cookie, the control
plane's continue page and `POST /app-session/start`, the code exchange, the
page with the identity JWT); a signed-out browser sent to sign in; a code
refused in another browser, with another nonce, twice, on another host,
after 60 seconds or tampered; the Better Auth cookie never honoured on a
third-party host and the host session on no other host (nor another app's,
nor twice); sign-out, a lost app and a lost membership ending the host
session; no code for a member without the app, a non-member, a cross-site
post or a page elsewhere; app responses stripped of credentialed CORS and
the perimeter's cookies, and a sibling's post refused; personal access
tokens under their own organization's rules; 404 for unknown third-party
hosts and 503 for a row on the wrong class of host; and nothing of it on a
self-hosted gateway. The classifier, the tokens and the response rules
have unit tests in `packages/perimeter/src/hostRoutes.test.ts` and
`hostSession.test.ts`, and the perimeter's handoff hook in `gateway.test.ts`.

### Shared apps and organizations

`apps/every-app-gateway/src/server/shared-apps.sqlite.test.ts` runs the real
worker entry and Better Auth on SQLite on a hosted gateway with three
organizations (the platform organization the setup claim makes, and two
customers): a shared app opens for members of every organization with
their own organization in the identity JWT, an organization's own app stays
its own, a person acting under one organization opens another's app as
their membership there (hosted and self-hosted), a personal access token
stays in its organization, a suspended organization is refused for cookies
and tokens alike, and a self-hosted gateway opens a shared row for nobody;
then the listings: the launcher, the AI-connection consent, the gateway
`/mcp` catalog (connections that chose the app included) and Admin → Apps
(read-only elsewhere, no access management). The AppGateway entrypoint's
attribution of shared apps' calls is in `app-gateway-entrypoint.test.ts`
(and against SQLite in `background-org.sqlite.test.ts`); the CLI's shared-app
commands and their tests went with the hosted-only CLI surface on 2026-10-24
(restorable from `5ef30882`).

### The gateway's MCP connector and OAuth

`apps/every-app-gateway/src/server/mcp-auth/gateway-mcp.e2e.sqlite.test.ts`
runs the gateway's own `/mcp` end to end in process: the real worker entry,
the real `@cloudflare/workers-oauth-provider` on an in-memory KV, every
migration on SQLite, and real SDK apps behind their bindings. It covers the
discovery documents, a DCR client and CIMD clients (their metadata
documents stubbed: claude.ai, Claude Code on changing loopback ports, and
a ChatGPT-style client signing its token requests) through authorize →
consent → token → `tools/list` → `tools/call` → refresh → revocation, the
authorization endpoint's refusals (errors shown, never redirected; PKCE for
every client; nothing on the platform's domains, the gateway's host and
`APP_BASE_DOMAIN`, at consent and the token endpoint too), dynamic registration's limits (what is kept, 16 KiB, per
address and per gateway per day, `MCP_DCR_ENABLED`), the consent page's
protections (cross-site, another browser, replay, a double-submitted
approval, framing, caching), body limits and failures, reconnecting
replacing the earlier connection (by installation, in its organization
only), the per-request
re-checks (revoked connection, removed member, a member who left and came
back, deactivated user, app access removed, app deleted), read-only and
chosen-apps connections, personal tokens, the `MCP_OAUTH_ENABLED` kill
switch and the hourly housekeeping.

The consent page's form is tested as rendered, with React in happy-dom
(`apps/every-app-gateway/src/client/components/oauth/ConsentForm.test.tsx`):
what it posts is parsed with the decision's own parser, Allow arms only
after the page has been seen for a moment and the user moved, typed or
touched (a tap included, a mouse press alone not), a second press sends
nothing, and "Published by" is verified only when access goes to that
site.

Against a real local gateway (workerd under `vite dev` on
`http://localhost:<port>`), `apps/every-app-gateway/scripts/mcp-oauth-local.mjs`
plays an MCP client and its browser through the same flow, and with
`--conformance` runs the MCP conformance suite's authorization-server
scenarios. Setup and usage: `docs/runbooks/mcp-oauth.md`, "Test locally".

### Hosted sign-up

`apps/every-app-gateway/src/auth/hosted-sign-up.sqlite.test.ts` runs the
real Better Auth configuration on SQLite with a fake `EMAIL` binding that
keeps every mail: a stranger's sign-up makes the account, a personal
organization and an owner membership (and nothing at all when the
organization's batch fails), sign-in is refused until the mailed link
verifies the email and signs the account in once, an invitee joins only
the inviting organization, a bad invite link is refused with sign-up open,
sessions start in the right organization with none, one or two memberships
(personal, last active, first joined), only a verified account invites and
its organization's name is escaped in the mail, resends stop at the
per-address budget, `HOSTED_OPEN_SIGNUP=false`, a hosted gateway without
email refusing sign-up, open sign-up refused before the claim, and
self-hosted unchanged (invite-only, no personal organization, no
verification, no verification mail). The mail budgets and templates have
unit tests next to them (`server/email/sendEmail.test.ts`,
`server/email/templates.test.ts`).

### Signing in with Cloudflare Access

`apps/every-app-gateway/src/auth/cloudflare-access/` is tested at three
levels, against a mock Access (`src/test/mock-access.ts`: team keys and
signed outer-ring assertions, and an Access for SaaS OIDC application that
checks the client secret, the redirect URI and PKCE):

- `jwt.test.ts`: the JWT verifier on its own: a good token, wrong AUD,
  wrong issuer, expired (and within the minute of skew), not yet valid, no
  expiry, `alg: none`, HS256 keyed with the public key, a forged signature
  under a known key id, a service token, `email_verified: false`, garbage;
  the JWKS cache (one fetch, refetched after ten minutes, shared by
  concurrent checks, a fetch that never settles waited on no longer than its
  timeout and then replaced, a rotated key picked up, unknown key ids
  refetched at most every 30 s, fetch failures failing closed, keys never
  used past their lifetime, non-RS256 keys ignored), and where the assertion
  is read from.
- `config.test.ts`: the settings, including which URLs are accepted, the
  gateway's and the apps' AUD tags, and when `EMAIL_PASSWORD_SIGN_IN=false`
  is ignored.
- `access-sign-in.sqlite.test.ts`: the real Better Auth configuration on
  SQLite.
  - The outer ring's session check: an existing member, an account whose
    email isn't verified (linked after one password sign-in), an invited
    person, an auto-join domain and "everyone" (with the apps available to
    everyone), a stranger, a deactivated member, an unclaimed gateway,
    someone else's session in the browser, an expired session, assertions it
    can't verify, sign-in only with the gateway application's AUD and an
    application token, the JWKS down, other hosts, the sign-in methods
    endpoint.
  - A session counts only with Access's word for that person: server-side
    lookups (header or `CF_Authorization` cookie), the browser's check on
    any host, Better Auth's own endpoints (`/list-accounts`,
    `/update-user` refused, `/sign-out` still working); sign-ins as anyone
    else refused (`ACCESS_EMAIL_MISMATCH`, the owner's documented way out
    included) or without Access (`ACCESS_REQUIRED`); Delete deactivating
    someone auto-join would let back in.
  - OIDC sign-in end to end: the authorization request, state bound to the
    browser, a planted code refused by PKCE, ID tokens for another client,
    another issuer or with an unverified email, strangers, deactivated
    users, an unclaimed gateway, auto-join, linking an existing account only
    when its email is verified or while signed in, a different email
    refused, the outer ring's person only, posted ID tokens refused.
  - Login CSRF: an attacker's sign-in can't be finished in a victim's
    browser (the callback and linking variants).
  - An untrusted provider that can't take over an existing account;
    password sign-in turned off (only once an owner can sign in with
    Access, the setup claim still working, reset links refused); the
    membership policy on its own (an invitation used once by racing
    sign-ins).
- `outer-ring-perimeter.sqlite.test.ts`: the real worker entry with an app
  behind its binding: an app host serves the person Access vouches for (the
  apps' own Access application too), never passes Access's headers or
  cookie to the app, sends a browser whose session belongs to someone else,
  or comes without Access's word, back to sign in, takes a cookie session
  on its bypassed `/mcp` only with the `CF_Authorization` cookie, and a
  personal access token there as always.

The perimeter's own
tests (`packages/perimeter/src/headers.test.ts`, `gateway.test.ts`) check
that every `cf-access-*` header is stripped.
To try it by hand against a local gateway,
`apps/every-app-gateway/scripts/access-local.mjs` runs a
mock Access with an outer-ring proxy: `docs/runbooks/cloudflare-access.md`,
"Test locally".

### The platform side of the agentic-inbox and Postiz ports

Postiz is ported but not part of the launch (Ben, 2026-10-23); it stays
here as a test fixture for helper Workers, Workflows and the OAuth clients.
The ports (#322 to #327) run Postiz as two Workers (a TanStack Start
frontend, built with vinext until 2026-10-18, and a NestJS helper with a
Workflow and a cron) and agentic-inbox as one Worker with two Durable
Objects. Nothing of theirs can deploy from here, so these suites stand in
for a live account:

```bash
# Both ports' manifests through register → provision → build → policy →
# migrate (the fixture's nine-statement d1-sql init on SQLite) → upload, in the
# fake account; and inbound mail routes, `everyapp email set` included, in
# the same fake account
( cd packages/cli && pnpm exec vitest run src/commands/deploy/deployApp.ports.test.ts \
    src/commands/deploy/deployApp.email.test.ts src/commands/email/index.test.ts \
    src/lib/app/emailRoutes.test.ts src/lib/migrations/prisma.test.ts )

# The gateway's capability routes: email, members and OAuth clients, unit and on
# migrated SQLite; Workers AI in the AI proxy (the live SSE captures as
# fixtures); OPTIONAL_SECRETS covers every setting the registry names
( cd apps/every-app-gateway && pnpm exec vitest run --silent=true src/server/capabilities \
    src/server/email-capability.sqlite.test.ts src/server/app-email.sqlite.test.ts \
    src/server/members-capability.sqlite.test.ts src/server/oauth-client.sqlite.test.ts \
    src/server/ai-proxy.test.ts src/optional-secrets.test.ts )
# Per-app OAuth scope sets (docs/design/2026-10-oauth-scopes.md): the registry's
# scope policies, the scope parsers and the route allowlist matcher; the gateway's
# token-endpoint checks (positive, outside the sets, a background call, a removed
# set, missing scopes, grant types, the query-string rule) (#411); the
# manifest field (#414); the admin summary (#408); the SDK helper and dev twin (#412)
( cd packages/sdk && pnpm exec vitest run src/internal/capabilities.test.ts \
    src/internal/oauthScopes.test.ts src/server/authorizeUrl.test.ts \
    src/server/integrationFetch.test.ts )
( cd packages/perimeter && pnpm exec vitest run src/manifest/manifest.test.ts )
( cd apps/every-app-gateway && pnpm exec vitest run --silent=true src/server/capabilities \
    src/server/oauth-client.sqlite.test.ts src/server/deploy/metadata.test.ts \
    src/server/services/appCapabilities.test.ts )

# The SDK's halves: sendEmail, listMembers, the shared email and OAuth wire rules, the
# Workers AI normaliser, nodeServerHandler, and docs/capabilities.md's
# generated OAuth tables (UPDATE_DOCS=1 regenerates them)
( cd packages/sdk && pnpm exec vitest run src/server/sendEmail.test.ts src/server/listMembers.test.ts \
    src/internal/email.test.ts src/internal/oauthClient.test.ts \
    src/internal/aiProviders.test.ts src/server/nodeServer.test.ts \
    src/internal/capabilitiesDoc.test.ts )

# The gateway's config loads with every optional setting
pnpm -C apps/every-app-gateway build    # cf build && tsc --noEmit
```

What only a live account can show is in [TODO.md](../TODO.md), "Check on
the first live deploy", under the ports.

---

### The setup skills

The everyapp skill's setup files (`packages/cli/skills/everyapp/setup/*.md`,
one per integration a Gateway holds for apps) have two checks:

```bash
# Static, in CI: every file in setup/README.md's table exists and is listed,
# every `secret set NAME` is a Gateway setting the CLI accepts, every
# `pnpm everyapp …` is a route the CLI has (commandPaths() in src/app.ts),
# no file asks for a value in the chat or puts one on a command line, and
# each file has the sections the README's contract requires
( cd packages/cli && pnpm exec vitest run src/lib/app/setupSkills.test.ts )

# End to end, by hand: `claude -p` in a scratch checkout against a fake
# everyapp that speaks the CLI's NDJSON contract, with the person scripted;
# needs the claude CLI logged in, spends a few cents a scenario on sonnet
node packages/cli/test/setup-skills/run.mjs dataforseo
node packages/cli/test/setup-skills/run.mjs all --keep-going
```

`packages/cli/test/setup-skills/README.md` says what a pass means, where a
run's transcript and report land (`/tmp/setup-skills-runs/<scenario>-<n>/`)
and how to read a failure. The fake's shapes come from
`src/lib/output/events.ts` and captures of `status --json` and `secret list
--json`: change the fake when the CLI's contract changes.

### The build skill

The build-every-app skill (`packages/cli/skills/build-every-app/`) has the
same two checks:

```bash
# Static, in CI: the frontmatter, every cited starter and app path, every
# `pnpm everyapp …` a route; and the harness's own readers
( cd packages/cli && pnpm exec vitest run src/lib/app/buildSkill.test.ts test/build-skill )

# End to end, by hand: `claude -p` in a fresh copy of the starter with both
# skills in place, a scripted person asking for a feature, the fake everyapp
# answering dev and deploy with nothing, then `pnpm test` and `pnpm
# types:check` in the app; needs the claude CLI logged in, well under a
# dollar a scenario on sonnet
node packages/cli/test/build-skill/run.mjs add-notes
node packages/cli/test/build-skill/run.mjs add-notes --scratch-only   # the scratch and its checks, no agent
```

`packages/cli/test/build-skill/README.md` says what a pass means (the skill
read before the first edit, the table through drizzle with its migration,
tools with a risk, no login or header-read of the app's own, nothing
deployed, the app's checks green, a plain closing message) and where a run
lands (`/tmp/build-skill-runs/<scenario>-<n>/`). What the two harnesses
share (the claude session, the person's rules, the stubs) is
`packages/cli/test/shared/`.

### The onboarding loop

`packages/onboarding-loop` proves the setup prompt on /docs/gateway on a coding
agent, from a wiped, dedicated test Cloudflare account: `pnpm loop doctor`
once, then `pnpm loop run --harness claude --account loop-1` (45 to 75
minutes; the harnesses, the accounts and what a pass means:
`packages/onboarding-loop/README.md`, the design
`docs/design/2026-10-onboarding-loop.md`, the accounts
`docs/runbooks/onboarding-loop-test-accounts.md`). Its unit tests:
`pnpm -C packages/onboarding-loop test`. The wipe is
`pnpm everyapp teardown --account-id <id> [--dry-run]`, tested against the
fake account in `packages/cli/src/commands/teardown/index.test.ts`; it
refuses any account outside `EVERYAPP_TEST_ACCOUNTS`.

## B. Local testing with `everyapp dev`

`everyapp dev` runs the app's own `vite dev` server on an internal loopback
port and a **gateway-lite Node proxy** in front of it on `$PORT` (default
8787). The proxy runs the **real** perimeter (`handleGatewayRequest`, imported
from `@every-app/perimeter/dev`): real public-route policy, real header
strip/inject, a real RS256 identity JWT signed by the SDK's well-known dev
keypair (`@every-app/sdk/dev`), CSRF rules, security headers,
and a seeded dev user (`dev@everyapp.localhost`, org `dev-org`, role `owner`).
Hot reload is untouched — the app runs under `cf dev` (Vite with the
Cloudflare plugin); only ingress goes through the perimeter. The dev gateway module is dev-only and excluded from production
bundles.

Nothing is written into the app: `everyAppWorker()` gives a development
build `EVERYAPP_DEV=1` and the dev key's `EVERYAPP_IDENTITY_PUBLIC_KEYS` and
`EVERYAPP_IDENTITY_ISSUER` as plain text bindings, so the SDK verifies real
signatures in dev, on the same code path as production. A development build
has no `EVERYAPP_AUDIENCE`: the dev gateway mints for the app id, which the
SDK accepts as the audience only under `EVERYAPP_DEV`. The dev key is public;
the SDK trusts it only behind `EVERYAPP_DEV` and only from the dev issuer, and
the gateway-lite listens on 127.0.0.1 unless `--host`.

### Walkthrough (verified end-to-end on an app made with `everyapp create`)

1. **Run dev** from the app directory:

   ```bash
   pnpm everyapp create todo   # once
   cd apps/todo
   pnpm dev   # everyapp dev; honors $PORT (portless assigns it); --port works too
   ```

   `pnpm dev` runs this checkout's CLI, which builds itself first when its
   source or the SDK's changed. Local D1 migrations are applied before the
   app starts, with `cf d1 migrations apply --local`; `pnpm everyapp db
   migrate` applies new ones without a restart.

   The dev gateway parses the Host header dynamically (first label = app,
   remainder = base host), so all of these route to the same app with no
   hardcoded base host:

   - `http://todo.localhost:8787/` (browsers resolve `*.localhost` natively;
     for curl add `--connect-to todo.localhost:8787:127.0.0.1:8787` or
     `--resolve todo.localhost:8787:127.0.0.1`, [below](#probing-the-perimeter-with-curl))
   - `http://todo.fix-ui.everyapp.localhost/` (portless, per-worktree)

   Each git worktree gets its own `.cloudflare/state` and dev registry
   (`.everyapp/registry`), so several full gateway+app instances run side by
   side.

2. **You are already “logged in”** as the seeded dev user — every proxied
   request carries a freshly-minted identity JWT. The perimeter probes (all
   verified against the running starter app):

   ```bash
   C="--connect-to todo.localhost:8787:127.0.0.1:8787"

   # Through the gateway → 200 HTML, security headers + dev CSP stamped
   curl -s $C -o /dev/null -w '%{http_code}\n' http://todo.localhost:8787/   # 200

   # Direct to the internal vite port (printed at startup) → fail-closed 401
   curl -s http://127.0.0.1:<vite-port>/                                     # 401

   # Spoofed identity header, direct to the app → still 401 (signature fails)
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H 'x-everyapp-identity: forged' http://127.0.0.1:<vite-port>/          # 401

   # POST without Origin or a cookie → anonymous: 401 {"error":"unauthenticated"}
   curl -s $C -o /dev/null -w '%{http_code}\n' \
     -X POST http://todo.localhost:8787/anything                             # 401

   # The same POST with the app's Origin → reaches the app (the starter: 404)
   curl -s $C -o /dev/null -w '%{http_code}\n' -X POST \
     -H 'Origin: http://todo.localhost:8787' http://todo.localhost:8787/anything  # 404

   # A cookie without Origin → CSRF default-deny
   curl -s $C -o /dev/null -w '%{http_code}\n' -X POST -H 'Cookie: a=1' \
     http://todo.localhost:8787/anything                                     # 403

   # Another app's label → 421 (this dev server serves one app)
   curl -s -o /dev/null -w '%{http_code}\n' \
     --connect-to nosuch.localhost:8787:127.0.0.1:8787 \
     http://nosuch.localhost:8787/                                           # 421
   ```

3. **WebSockets** (vite HMR, and any the app opens) are raw-piped at the
   upgrade hop with the perimeter contract applied: Cookie / Authorization /
   `x-everyapp-*` stripped, a fresh identity JWT injected (`pipeUpgrade` in
   `packages/cli/src/commands/dev/proxy.ts`).

4. **Run the suites** as in section A.

### Probing the perimeter with curl

Browsers send what the perimeter needs on their own; curl and scripts don't.
Three things to add (checked with `pnpm everyapp dev --port 9080` in
`apps/todo`, curl 8.7.1 and Node 24 on macOS):

- **Pin `*.localhost` to 127.0.0.1.** The gateway-lite listens on
  127.0.0.1 only, and the system resolver answers `::1` first for
  `*.localhost` (`dscacheutil -q host -a name todo.localhost`). curl and
  Node's `fetch` fall back to 127.0.0.1 after the refused `::1` attempt, but
  a client that takes the first address fails (`ECONNREFUSED ::1`, as
  `http.get` with `autoSelectFamily: false` does). Pin it:

  ```bash
  curl --resolve todo.localhost:8787:127.0.0.1 http://todo.localhost:8787/
  # or: --connect-to todo.localhost:8787:127.0.0.1:8787
  ```

- **Send `Origin` on state-changing requests.** A POST (PUT, PATCH,
  DELETE) needs `Sec-Fetch-Site: same-origin` or an `Origin` whose host is
  the app's to count as the signed-in dev user. Without either it is
  anonymous: a private route answers `401 {"error":"unauthenticated"}`, the
  challenge a programmatic client needs, never a 403, because a request
  without a cookie has nothing a forger could ride. Only a request that
  carries a cookie gets the CSRF refusal, `403 csrf_denied`. So:

  ```bash
  curl --resolve todo.localhost:8787:127.0.0.1 -X POST \
    -H 'Origin: http://todo.localhost:8787' \
    -H 'content-type: application/json' -d '{}' \
    http://todo.localhost:8787/api/...
  ```

  | Request (no `Authorization`)                | Answer                          |
  | ------------------------------------------- | ------------------------------- |
  | no cookie, no `Origin`, no `Sec-Fetch-Site` | 401 `unauthenticated`           |
  | no cookie, another host's `Origin`          | 401 `unauthenticated`           |
  | no cookie, the app's `Origin`               | reaches the app as the dev user |
  | no cookie, `Sec-Fetch-Site: same-origin`    | reaches the app as the dev user |
  | a cookie, no `Origin`                       | 403 `csrf_denied`               |
  | a cookie, the app's `Origin`                | reaches the app as the dev user |

  The same holds behind the production gateway, with a real session.

- **Anonymous requests** to a public route: `-H 'x-everyapp-dev-anon: 1'`
  (or the cookie `everyapp_dev_anon=1` in a browser).

### Mail in local dev

`everyapp dev` has no gateway, so neither direction goes through Email
Sending or Email Routing:

- **Outbound** (`sendEmail()` from `@every-app/sdk/server`, the `email`
  capability): the SDK checks the message and the sender the way the gateway
  does (the installation's senders have a stand-in in dev,
  `EVERYAPP_EMAIL_SENDERS` in `.dev.vars`, a comma list or a JSON array;
  unset, every `from` is refused), then prints
  `[everyapp dev] email to <n> recipients subject "<subject>"` and answers
  `{ status: "logged" }`. With `EMAIL_REST_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID` and `EMAIL_FROM` in the app's `.dev.vars` it
  really sends, from the developer's own account
  ([docs/capabilities.md](capabilities.md#gateway-services-email)).
- **Inbound** (an app's `email()` handler): with `email: { inbound: true }`
  in the manifest, `everyapp dev` prints an `Email:` line in its ready block
  (its `to=hello@example.com` is an example: the addresses are the
  installation's, and the local endpoint takes any). It
  posts a raw RFC 5322 message to the app's **internal** port, where the
  Cloudflare Vite plugin's miniflare runs the handler:

  ```bash
  curl -X POST "http://127.0.0.1:<app port>/cdn-cgi/local/email?from=someone@example.net&to=hello@example.com" \
    --data-binary @message.eml
  # HTTP/1.1 200 OK
  # Worker successfully processed email
  ```

  `message.eml` needs `From`, `To`, `Subject` and a `Message-ID` header
  (without one: `400 Email could not be parsed: invalid or no message id
  provided`); miniflare refuses one over production's 25 MiB. The path is
  the one miniflare 5 serves under `@cloudflare/vite-plugin` 2.x; wrangler 4
  (miniflare 4) serves `/cdn-cgi/handler/email` instead, which on the Vite
  port is just an app route (`401`, no identity). Through the gateway-lite's
  host the path is an app route too, refused by the perimeter, so use the
  app port the ready block prints. The handler runs with no identity, as in
  production.

### Mirror mode (`--mode mirror`) — real login against a local gateway

`stub` mode (above) fakes the session with a seeded dev user — zero setup,
right for building your app. `mirror` mode swaps in a **real Better Auth
session** so you can exercise the actual login/launcher and org membership.
The session source is the only thing that changes: the perimeter, identity
JWT, CSRF, and header-strip are identical in both modes.

The session knob is a local variable — `--mode` or `EVERYAPP_DEV_MODE` (flag
wins). Mirror does **not** spawn or mount anything in the gateway; it points
at a **separately-running** local gateway and forwards login/launcher traffic
to it.

**Why a two-label base host.** The session cookie is set when you log in at the
gateway base host and must ride to the app subdomain — that requires the cookie
be scoped to a shared parent domain (exactly the production model). So mirror
mode needs a two-label base like `everyapp.localhost` (not bare `localhost`).
The CLI refuses a one-label base with setup guidance.

**Setup (one-time):**

1. Point a two-label host at loopback — portless (recommended) gives
   `*.everyapp.localhost`, or add `/etc/hosts` entries for
   `everyapp.localhost` and `<app>.everyapp.localhost`.
2. In the **gateway's** dev env (`apps/every-app-gateway/.dev.vars`):
   ```
   EVERYAPP_DEV_COOKIE_DOMAIN=everyapp.localhost
   GATEWAY_URL=http://everyapp.localhost:8787
   ```
   (`EVERYAPP_DEV_COOKIE_DOMAIN` enables cross-subdomain cookies — dev-gated;
   `import.meta.env.DEV` is `false` in a production build so prod cookie scope
   is never widened. `GATEWAY_URL` is the origin the browser actually uses —
   the base host the CLI serves, not `:3000`.) The local gateway runs as a
   self-hosted one; add `GATEWAY_DEPLOYMENT_MODE=hosted` to try the hosted
   policy (`apps/every-app-gateway/src/server/platform-policy.ts`).

**Run (two terminals):**

```bash
# Terminal 1 — the real gateway (Better Auth, launcher, admin, D1)
cd apps/every-app-gateway && pnpm dev          # serves on :3000

# Terminal 2 — your app behind the perimeter, mirror auth
cd apps/todo
pnpm everyapp dev --mode mirror --base-host everyapp.localhost
# (--gateway http://localhost:3000 by default; the CLI fails fast with
#  guidance if the gateway isn't reachable)
```

Open `http://everyapp.localhost:8787` → the **real** gateway launcher/login is
forwarded through. A self-hosted gateway has no sign-up: claim it once with
`pnpm setup-link` in `apps/every-app-gateway` (it prints the owner link;
everyone after that is invited), then open
`http://todo.everyapp.localhost:8787` — you reach the app as your **real**
logged-in user.

**Verified end-to-end** (against a stand-in gateway, via `Host:` headers):

| Probe | Result |
|---|---|
| base host `everyapp.localhost:8787/` | real gateway launcher forwarded through |
| `todo.everyapp.localhost:8787/` with a session cookie | **200** — real session resolved, dev-kid identity minted for the real user, app verifies |
| same, no cookie | **401** — perimeter fail-closed |
| one-label base (`localhost:8787`) | **421** with setup guidance |
| direct hit to the app's internal vite port | **401** |

**What's dev-permissive (and why):** per-app access (`user_app_access`) is not
enforced yet — any authenticated user with an active org reaches their
in-development app. Real per-app authorization lands with the Phase-5
app-registration flow; until then mirror gives you a real *identity*, not real
*access control*. The dev identity endpoint (`/api/dev/identity`) and the
cross-subdomain cookie config are both gated to dev builds and 404 / no-op in
production.

---

## C. Production verification

### Deploy checklist

1. **Gateway** owns a Workers Custom Domain for its own host
   (`apps.example.com`) and one per app host (`todo.apps.example.com`), the
   full list on every deploy, and holds the RS256 keypair (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`, kid
   `everyapp-identity`).
2. **Each app** is deployed PRIVATE from its manifest:
   - `everyapp deploy` builds the Worker `cloudflare.config.ts` defines
     from `everyapp.config.ts` (`everyAppWorker()`) with `workersDev:false`,
     `previewUrls:false`, **no routes**, and refuses a built Worker that
     differs;
   - the gateway’s public **key set** is injected as
     `EVERYAPP_IDENTITY_PUBLIC_KEYS` (JSON array), from the install row’s
     `jwt_public_key`, which the CLI wrote when it generated the keypair at
     the gateway’s first deploy;
   - pending D1 migrations auto-apply;
   - the app row is written to the registry (`apps.hostname`, `worker_name`,
     `tier`, `manifest`, `status`, `deployed_by_actor`) by the CLI itself,
     through `cf d1 query` with the operator's Cloudflare login (ADR-0003);
   - the gateway binds the app once a reconcile redeploys the gateway the
     checkout builds (from the build cache under `node_modules/.cache/everyapp`
     when its sources haven't changed) with the registry's full list of apps,
     and makes it `active` on the first request that reaches it (the deploy's
     live wait sends it); `everyapp status` shows whether the live
     bindings match, and whether the live release was built from this
     checkout (`upToDate`), from D1, cf and the checkout alone.

### Probes — prove a sub-app is NOT directly reachable

```bash
# 1. workers.dev must be disabled — expect DNS failure / no such host
curl -sS https://every-<org>-todo.<account>.workers.dev/ ; echo "exit=$?"
# => could not resolve host / 404 — there is no public hostname

# 2. A request that bypasses the gateway gets 401 from the SDK (fail-closed):
#    hit the app via any path that is NOT the gateway and you cannot produce a
#    valid x-everyapp-identity (you don't hold the private key).
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'x-everyapp-identity: forged.header.value' \
  https://todo.example.com.invalid/   # any non-gateway entry
# => 401

# 3. Through the gateway, a private route without a session redirects/401s:
curl -s -o /dev/null -w '%{http_code}\n' https://todo.example.com/tasks
# => 401 (or 302 to home login for an HTML navigation)

# 4. A declared public route responds without auth:
curl -s -o /dev/null -w '%{http_code}\n' https://todo.example.com/health
# => 200

# 5. The internal namespace is never public:
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://todo.example.com/__everyapp/tools/call
# => 404 (the perimeter refuses the tools contract from outside)

# 6. Uniform security headers on every answer; the CSP floor on HTML only
#    (a private route's anonymous 401 JSON or 302 carries none, so read it
#    off a page an anonymous caller can render, like the Gateway's sign-in
#    page; with Access on, Access answers that first):
curl -sI https://todo.example.com/ | grep -iE \
  'strict-transport-security|x-content-type-options'
# => HSTS, nosniff
curl -s -D - -o /dev/null https://apps.example.com/sign-in | grep -iE \
  'strict-transport-security|x-content-type-options|content-security-policy'
# => HSTS, nosniff, CSP with frame-ancestors 'none'
```

### Confirm the registry / binding state

```bash
# The gateway reconstructs bindings from the registry on every deploy.
# Verify the app row exists and is active:
pnpm everyapp status --json   # data.apps: each app's status and whether the live gateway binds it
# or inspect the apps table directly:
#   SELECT app_slug, hostname, worker_name, status FROM apps;
```

### Roll back a bad Gateway release

The gateway is the single public worker, so a bad Gateway release is the
only change that can affect every app at once. The proxy core is small and
slow-changing; recover with Cloudflare’s instant rollback:

```bash
# List the gateway Worker's recent deployments and send all traffic back to a good version:
npx cf workers deployments list --worker every-app-gateway
npx cf workers deployments create --worker every-app-gateway \
  --strategy percentage --versions '[{"version_id":"<VERSION_ID>","percentage":100}]'
```

A deploy also saves a D1 Time Travel restore point before it migrates a
database with data; `pnpm everyapp db restore --gateway` takes the Gateway's
database back to it (`--json` gives cf's own `time-travel restore` command). Gateway
migrations only add, so the previous version runs against the migrated
database.

That rollback is a stopgap: the install row still names the release everyapp
put live, which stays the truth, so the next Gateway deploy or rebind puts
the checkout's Gateway back (and, since the Worker then serves a version
everyapp didn't record, an unattended one may stop for a terminal). For a
lasting rollback, check out the good commit and run
`pnpm everyapp setup --allow-downgrade`.

Sub-apps are unaffected by a rollback (their workers and the registry are
unchanged); only the perimeter reverts. Because identity tokens live ≤120s,
revocation/identity changes converge within that window.
