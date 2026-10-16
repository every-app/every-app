# Live checks for hosted Every App (consolidated, 2026-10-15)

Every live check named in `README.md` (H0, H0a, H0b, R1-R47) and in the five
round-2 gap reports, deduplicated, grouped by what it blocks. Each entry
says what to run, what we expect, which decision or PR it settles, and what
it needs. Record each result under the entry as `RESULT (date): …` and keep
the file; `README.md` §6 points here.

Accounts and resources, once:

- **CF-SCRATCH**: a scratch Cloudflare account with Workers Paid and Workers
  for Platforms purchased (error 10121 otherwise). D7's "Every App Staging"
  account can be it. Needs: one dispatch namespace, a deployed copy of
  `every-app-gateway` (the account Worker that user Workers bind to), one
  deployer-style Worker to issue REST calls from inside Cloudflare, two
  cheap zones (control + content) for the cookie and hostname checks.
- **AUTUMN-SANDBOX**: Autumn sandbox `everyapp` in "Ben Senescu's Org", with
  the plans from `raw/autumn-billing-platform.md` created as code
  (`onboarding_plan`/Free, Pro, the top-up add-on, `usage_credits`,
  `topup_credits`, and an `apps` entity feature on one plan version only).
- **OR-MGMT**: an OpenRouter management key (`/api/v1/keys`), plus a
  provisioning key it creates.
- **DFS-SANDBOX**: a DataForSEO login that can call `sandbox.dataforseo.com`
  (and, for one check, a live login that can afford ~35 Labs calls).
- **BROWSER**: Safari and one Chromium browser.
- **NPM**: the `bensenescu` npm account (owner of `@every-app`), GitHub
  Actions on `every-app/private-every-app`.
- **EMAIL**: the hosted account once the `everyapp.com` zone is in it (or a
  scratch zone for the DNS checks); a fresh Gmail address; a Proton account.

Expected outcomes are written as "expected: …" when a source predicts them
and "unknown" when nothing does.

---

## A. Blocks the first code PR

These decide the shape of H8, H10, H13, H15 or H18, or the D14 answer. Run
before those PRs start. Size: about 3.5 d (H0 2 d, H0a 0.5 d, H0b 1 d).

### A1. Service binding with `props` from a user Worker (R1; H0)

- **Run** (CF-SCRATCH): create namespace `everyapp-scratch`. `PUT
  /accounts/{a}/workers/dispatch/namespaces/everyapp-scratch/scripts/probe`
  with a one-line module Worker whose `fetch` returns
  `JSON.stringify(await env.GW.whoami())`, and metadata
  `bindings: [{type:"service", name:"GW", service:"every-app-gateway",
  entrypoint:"AppGateway", props:{organizationId:"o1", appId:"probe",
  workerName:"probe"}}]`. In the scratch gateway, add a `whoami()` RPC on
  `AppGateway` that returns `this.ctx.props` (remove it afterwards: no
  method may echo props in production). Call `env.DISPATCHER.get("probe")`
  from the gateway and read the body. Then `GET .../scripts/probe/bindings`.
- **Expected**: unknown. The binding itself is in the schema (verified #4,
  #12, #17). If `props` arrives, `whoami()` returns `{organizationId:"o1",…}`.
  `GET /bindings` is expected *not* to echo `props` (qualified #12).
- **Settles**: A2 option A; H10's binding allowlist; whether DO alarms on
  the dispatch tier get the broker or a per-app HMAC credential; the
  brokered-KV design. If `props` fails, H10 builds option B + C.

### A2. Cross-script Workflow binding from a user Worker (R2; H0)

- **Run** (CF-SCRATCH): deploy a regular Worker `wf-host` with a
  `WorkflowEntrypoint` class and `PUT /workflows/probe-wf {script_name:
  "wf-host", class_name:"ProbeWorkflow"}`. Upload user Worker `probe-wf-user`
  with `bindings: [{type:"workflow", name:"WF", workflow_name:"probe-wf",
  script_name:"wf-host"}]` and call `env.WF.create()` from it. Separately,
  try `cf deploy --prebuilt --dispatch-namespace` of a Worker that *defines*
  a Workflow class (expected: refused or `workflow.not_found`, verified #24,
  #29).
- **Expected**: unknown for the cross-script call; schema-permitted
  (qualified #10, #16, #44).
- **Settles**: whether dispatch catalog apps may call platform-hosted
  Workflow classes (A1 note). Does not change D2.

- **RESULT (2026-10-15, docs re-check at Ben's request)**: still unsupported
  as of today. Workflows limits page (updated 2026-09-21): "Workflows cannot
  be deployed to Workers for Platforms namespaces, as Workflows do not
  support Workers for Platforms." WfP limits page (updated 2026-10-13) and
  the WfP and Workflows changelogs (through 2026-10-08) carry no entry
  adding support. The Workflows `PUT /workflows/{name}` body still has only
  `script_name` + `class_name`, no namespace field. The Sep 24/27 2026
  `exports`-declared Workflows change does not mention dispatch namespaces,
  and the dispatch upload schema's `exports` discriminator still lists only
  `worker` and `durable-object`. Third-party API test 2026-09-27
  (skyphusion-labs/vivijure-control-plane#537): `PUT /workflows` with a
  namespaced `script_name` returns 500 `10001`, account-level script 200.
  Live probe from this session was not possible: the API connection is
  read-only (10000 on `POST /workers/dispatch/namespaces`) and the account
  has no dispatch namespace. Still to run in CF-SCRATCH: the cross-script
  binding above, and a direct `PUT /workflows` against a namespaced script
  to catch an undocumented change. Related, not a substitute: Dynamic
  Workflows (`@cloudflare/dynamic-workflows`, 2026-05-01) run tenant
  Workflow code inside Dynamic Workers loaded by a platform Worker, not in
  dispatch-namespace user Workers.

### A3. Crons and queue consumers on dispatch scripts (R3, R4; H0)

- **Run** (CF-SCRATCH): `PUT .../scripts/probe/schedules` (expected: 404,
  no such path; verified #5, #15, #30). `POST /queues/{q}/consumers
  {script_name:"probe"}` for a namespace script (unknown; qualified #49).
  Also confirm `wrangler deploy --dispatch-namespace` with `triggers.crons`
  prints no warning and sets nothing.
- **Settles**: A6 (gateway scheduler) is already decided; R4 decides whether
  org apps may ever own queues.

### A4. WebSocket through dispatch (R5; H0)

- **Run** (CF-SCRATCH): deploy todo (`UserSyncDO`) to the namespace via the
  patched build; open a socket through the gateway's dispatch branch.
- **Expected**: 101 Switching Protocols (undocumented either way).
- **Settles**: whether realtime apps (todo sync, SAM) need the platform tier.

### A5. Cookie tossing, both variants (R6; H0a)

- **Run** (CF-SCRATCH + BROWSER): gateway at `app.<control>`, two apps at
  `a-x.<content>` and `b-x.<content>` under scheme A's shared cookie (the
  thing we are replacing). Attacker signs in, copies their
  `__Secure-better-auth.session_token` value. Victim signs in in tab 1. In
  tab 2 the attacker's app page runs `document.cookie =
  "__Secure-better-auth.session_token=<attacker>; Domain=<base>; Path=/;
  Secure"`. Reload the control plane. Repeat with `Path=/api/auth`. Observe
  `/api/auth/get-session` and an app page.
- **Expected**: `Path=/` variant: victim's own account (first-wins parser,
  qualified #40). `Path=/api/auth` variant: `/api/auth/get-session` returns
  the attacker's account; app-host and root-path requests still see the
  victim (RFC 6265 §5.4 longer paths first).
- **Settles**: the finding-3 narrative and H4's duplicate-name refusal. If
  neither reproduces, scheme A is viable on CSRF grounds alone, but C stays.

### A6. Safari ITP and a custom `__Host-` cookie name (R15; H0a; D14)

- **Run** (BROWSER): the scheme-C handoff with the control plane visited
  only via redirect, in Safari with ITP on; check whether the per-host
  cookie survives 7 days and whether Better Auth's `cookies` config emits
  `__Host-everyapp_s` (no `Domain`, `Path=/`, `Secure`).
- **Expected**: unknown. Fallback: `__Secure-` host-only cookie.
- **Settles**: D14 (per-host sessions on self-host too) and H8's cookie
  name. Also in H0a: add the same connector twice in claude.ai and observe
  the refresh traffic's source range (R16; expected `160.79.104.0/21`).

### A7. `cf deploy --prebuilt --dispatch-namespace` with DO `exports`; four tags (R19; H0)

- **Run** (CF-SCRATCH): one deploy of the todo bundle into the namespace
  with `exports` for `UserSyncDO`, tags `org-x`, `app-todo`, `kind-fork`,
  `plan-free`.
- **Expected**: accepted (8 tags max, no `:`/`,`/`&`); Build Output v0
  warned "may change".
- **Settles**: H11/H10 artifact contract; `kind-fork` tag (D13). Pin `cf`
  and version the bundle schema regardless.

### A8. Assets session JWT from a second process; D1 batch atomicity; limits on alarms; `secret_key` (R7, R8, R9, R20; H0)

- **Run** (CF-SCRATCH): open an assets upload session from a Worker, upload
  the buckets from a laptop with the JWT (expected: works, JWT valid 1 h).
  `POST /d1/database/{id}/query` with a migration file that fails mid-way
  followed by `INSERT INTO d1_migrations` (expected: unknown; "executed as a
  batch", atomicity on failure unstated). A user Worker with an alarm loop
  and `metadata.limits.cpu_ms: 50` (expected: unknown). Upload with a
  `secret_key` binding and attempt `crypto.subtle.exportKey` (expected:
  throws, undocumented).
- **Settles**: whether asset bytes may bypass the gateway (R7); migration
  bookkeeping transactions (R8); DO denial-of-wallet ceilings (R9); the KEK
  shape (R20).

### A9. First-open install timing, with and without a pool D1 (R28; H0)

- **Run** (CF-SCRATCH, from a deployer-style Worker, not a laptop): 50
  sequential and 50 concurrent (10 at a time) fresh installs of the built
  todo bundle: `POST /d1/database` → `/query` (migration batch) →
  assets session → bucket uploads → script `PUT` → `GET /bindings`. Repeat
  claiming a pre-created, pre-migrated D1 instead of creating one. Log
  per-step wall time, p50/p95, and the `Ratelimit` header after every call.
  Delete everything by `org-` tag.
- **Expected**: target p50 ≤ 5 s, p95 ≤ 10 s with the pool (unknown; no
  documented D1-create or `PUT` latency).
- **Settles**: D2's lazy-install default; H17b's interstitial and pool size;
  whether prefetch on launcher open is needed.

### A10. API budget independence, dispatch vs the 32-invocation cap, asset dedupe, bytes per org (R29, R30, R31, R32; H0)

- **Run** (CF-SCRATCH): two account-owned tokens issuing calls in parallel,
  read `Ratelimit` on each (R29; expected: unknown, the docs say both "per
  token" and "per user cumulatively"). One gateway request dispatching
  sequentially to 40 user scripts (R30; expected: exception at 33 if
  dispatch counts). Upload the same asset manifest to two new scripts and
  check whether the second session returns empty `buckets` (R31). Seed 100
  synthetic orgs with a realistic 30-day MCP audit; read `GET
  /d1/database/{id}` `file_size` and `meta.duration` (R32; expected ~50 KB
  static, ~1.5 MB with audit, ~1 ms per query).
- **Settles**: `CfApiBudget` design (H10); whether H15 may dispatch
  in-process; install call count; C5's timing.

### A11. AI Gateway on a Workers-Logs account (R10; H0)

- **Run** (CF-SCRATCH): create one AI Gateway; `PUT` one spend-limit rule
  with `window: 86400` and a `partition` metadata key; one OpenRouter call
  through it with `cf-aig-metadata`; `getLog()` from the binding.
- **Expected**: `window` is seconds (undocumented); whether OpenRouter via
  AI Gateway is priced is unknown; `getLog()` on a Workers-Logs account
  unverified.
- **Settles**: H20's backstop config and whether the price table is the
  final figure for AI Gateway providers.

### A12. Autumn idempotency, entity caps under overflow, entities on Free, pool selection (R11; H0b)

- **Run** (AUTUMN-SANDBOX): (1) `POST /track` twice with the same
  `Idempotency-Key` (expected: 200/202 then 409 `duplicate_idempotency_key`;
  verified #27, #37). (2) Customer with 1,000 `usage_credits`; entity with
  `usage_limits: [{feature_id:"usage_credits", limit:100, interval:"month"}]`;
  `track` 150 with `entity_id` and default behavior (expected: clamped to
  100 / `allowed:false`), then `track` 150 with `overage_behavior:"overflow"`
  (expected: full 150 deducted, cap bypassed; qualified #36). (3)
  `entities.create` for a customer on `onboarding_plan`, whose plan lacks
  the `apps` feature (expected: unknown). (4) A customer holding both
  `usage_credits` and `topup_credits`; `track seo_data_usage 10`; read both
  balances (expected: unknown).
- **Settles**: H13's outbox (409 as "already applied"), that per-app caps
  live only in `OrgWallet`, when entities may be created (D5), and
  two-pool tracking by credit-system id.

### A13. DataForSEO Lighthouse body and head buffer (R12; H0b)

- **Run** (DFS-SANDBOX): `POST /v3/on_page/lighthouse/task_post` then
  `task_get/json/{id}`; record total body size, the byte offset of
  top-level `"cost"`, and that `cost` is `0` on `task_get`. Also one call
  each to `ai_optimization/.../llm_responses` and Lighthouse on
  `sandbox.dataforseo.com` with the prod login.
- **Expected**: `cost` within the first ~200 bytes on every docs example;
  key order not guaranteed (qualified #26); sandbox coverage of those two
  endpoints unknown (R36).
- **Settles**: H18's head-buffer size and whether an endpoint price table is
  needed; whether previews can use the sandbox for OpenSEO's AI and
  Lighthouse features.

### A14. OpenRouter `usage.cost` per endpoint and the key limit (R13; H0b)

- **Run** (OR-MGMT): one streamed call each on `/v1/chat/completions`,
  `/v1/responses`, `/v1/messages`; record where `usage.cost` lands.
  Create a provisioning key with `limit: 0.01, limit_reset: "daily"`, spend
  past it, record the status (402 or 403) and `error.metadata.limit_source`.
  Create provisioning keys in a loop (then delete them) to find any
  per-account count ceiling.
- **Expected**: extra final SSE chunk / `response.completed` /
  `message_delta` (qualified #34); `openrouter_key_limit` (verified #51, docs
  cite both codes); key ceiling unknown, no doc states one.
- **Settles**: the three tail parsers in H5/C2; the 402 mapping in H14;
  whether per-org keys (D6) survive at scale.

---

## B. Blocks the first outside org

Needed before a stranger deploys, but not before H1-H23 start.

### B1. npm trusted publishing from the private repo (R24; H29; D13)

- **Run** (NPM): `npm access list packages @every-app` and confirm the scope
  can add trusted publishers and a second maintainer. Configure a trusted
  publisher for `.github/workflows/publish.yml`; within the 2-day window
  publish `0.4.0-rc.0` under dist-tag `next` via `pnpm pack` then `npm
  publish <tgz>` (npm ≥ 11.5.1, `id-token: write`); also try `pnpm publish`.
- **Expected**: works without provenance (docs: "not supported for private
  repositories"); `pnpm publish` OIDC unknown.
- **Settles**: H29's workflow; fallback is a 90-day granular token in a repo
  secret.

### B2. Standalone catalog app builds with packed tarballs (R25; H29)

- **Run**: `pnpm -C packages/sdk build && pnpm -C packages/sdk pack`; pack
  the CLI; copy `apps/todo-app` to `/tmp`; replace `workspace:*` with `file:`
  tarballs; add the root's `allowBuilds` and `overrides`; `pnpm install &&
  pnpm run build && pnpm dev`.
- **Expected**: builds (configs read, not built).
- **Settles**: hidden coupling to fix before H29 (+0.5 d).

### B3. Dual-audience JWT in the SDK (R27; H2/H30)

- **Run**: unit test minting `aud: [workerName, appId]` with the
  `protocol.ts` minters and verifying with `everyApp()`'s jose check.
- **Expected**: jose accepts an array `aud` containing the expected value
  (library behavior, unverified in our wrapper).
- **Settles**: whether protocol transitions can use a dual-valued window or
  need a forced upgrade.

### B4. The hosted release pipeline's cf behavior (R40, R41, R42, R44; H27)

- **Run** (CF-SCRATCH, CI mode): `cf workers versions create --prebuilt` →
  `cf workers deployments create --strategy percentage` 50/50 → `cf deploy
  --prebuilt </dev/null` (R40; expected: unknown whether `last_deployed_from:
  api` makes it abort). During the split, log `CF_VERSION_METADATA.id` from
  `scheduled` over several minutes and compare triggers before/after
  `versions create` (R41). `cf-dry-run` with the hosted patch profile
  carrying a `dispatch_namespace` binding with `outbound` (R42; expected:
  passes `OutputWorkerSchema`). WfP `PUT .../secrets/{name}` then request;
  upload with `keep_bindings: ["secret_text"]`; request again (R44). `HOME=$(mktemp
  -d) cf build` and `cf workers types` with no login (R44).
- **Settles**: gradual vs 100% deploys; trigger application; whether the
  gateway is uploaded by cf or by the REST API; hosted `secret set`
  semantics; whether hosted CLI users need a cf login at all.

### B5. Token scopes (R43; H10/H27)

- **Run** (CF-SCRATCH dashboard): create a token with D1 Edit scoped to one
  database (expected: no such scope, account-wide only) and a token with
  per-Worker Editor on two Workers; try to `PUT` a new dispatch script with
  it (expected: unknown; "creating a new Worker requires Workers Admin" is
  stated for regular Workers).
- **Settles**: whether the deployer token can overwrite the gateway; the
  version alert as mitigation.

### B6. D1 increase turnaround and the API-limit question (R17, R29; D7)

- **Run**: at hosted-account creation, file the Developer Platform Limit
  Increase Request Form for D1 databases → 250,000 and storage → 5 TB; ask in
  the same form whether the API rate limit can be raised for a
  non-Enterprise account; record the dates of filing and reply here.
- **Expected**: D1 raised (documented "millions"); API limit not raised
  (Enterprise only).

### B7. WfP pricing on a second account (R18, R44)

- **Run**: buy WfP on the staging account; read the first invoice for
  whether $25 replaces or adds to Workers Paid's $5, whether the 1,000
  included scripts are counted at peak or as script-months, and which
  request pool a gateway → user Worker chain bills against.
- **Settles**: the cost model only.

### B8. Control-plane D1 under load (R22; C5)

- **Run** (CF-SCRATCH): load-test the perimeter at ~500 req/s with
  `cookieCache` off and on and the access cache on.
- **Expected**: ~1,000 qps at 1 ms per query per the limits page.
- **Settles**: whether audit/ledger leave D1 before launch and whether
  per-org gateway shards are needed.

### B9. PSL submission (R14; D1)

- **Run**: once the content domain is bought with >2 years of registration,
  add the `_psl` TXT record and open the PR against `publicsuffix/list`
  with the rationale.
- **Expected**: "quite likely to be declined" at prototype scale; no SLA.
- **Settles**: nothing blocking (scheme C is safe without it); same-site GET
  riding and content-domain cookie bombing remain if declined.

### B10. Autumn sandbox safety, renames, locks (R33, R34, R35; D5)

- **Run** (AUTUMN-SANDBOX): `billing.attach` Pro paying with `4242 4242 4242
  4242` (R33; expected: succeeds, it is a Stripe sandbox). Customer with
  `base-plan`, one lock and one entity; `customers.update {new_customer_id}`;
  `customers.get` with expand; finalize the lock (R34; unknown). `check`
  with a 100-credit lock; `customers.get` and compare `remaining`; let it
  expire; watch the webhook log (R35; unknown).
- **Settles**: invite-only until live Autumn (default already); never-rename
  (default already); wallet refresh cadence.

### B11. DataForSEO account limits (R36; H18)

- **Run** (DFS live login): email support asking whether the 30-concurrent
  and 12/min limits are per account or per login, the refusal
  status/error code, rate-limit headers, and 10,000 vs 2,000/min. Then fire
  35 parallel Labs live calls from one login and record the 31st response.
- **Settles**: `ProviderGate` per account vs per login; error mapping;
  whether the separate hosted login matters after the cutover.

### B12. Email Sending on a new account (R45; D15, H9, H28)

- **Run** (EMAIL): onboard `mail.everyapp.com` on the hosted account; request
  a password reset to a fresh, unverified Gmail address; read Email Sending →
  limits in the dashboard; `dig TXT _dmarc.mail.everyapp.com` and
  `_dmarc.everyapp.com`; file the increase. Before the zone moves, try
  onboarding from the hosted account while the zone is elsewhere (R47;
  expected: refused, "a domain from your Cloudflare account").
- **Expected**: a "conservative" daily quota or a "Sandbox" with verified
  destinations only; the unrestricted binding reaching arbitrary recipients
  on Workers Paid is stated by the beta changelog example but the
  send-bindings page says "any verified destination address".
- **Settles**: whether a Resend transport is needed behind `sendEmail.ts`;
  where DMARC lands for the subdomain; D7's zone move timing.

### B13. OpenRouter terms and settings (R46; D6, D16)

- **Run**: write to OpenRouter describing the broker (platform key, per-org
  provisioning keys, 1.28× markup, customers' own apps calling models) and
  ask whether §7 item 4 applies. Check the hosted key's settings: logging
  off, training opt-out on. After H20, inspect an AI Gateway log entry to
  confirm no body fields (`cf-aig-collect-log-payload: false`).
- **Settles**: whether org apps get metered AI through the broker; whether
  "prompts never stored" is true.

### B14. DMCA designation and the human-mail DNS (D16, D15)

- **Run**: search `copyright.gov/dmca-directory` for "Every App" and
  "OpenSEO"; register or amend to list `everyapp.com`, the content domain
  and `openseo.so` ($6). Add `everyapp.com` in Proton and copy its SPF and
  DKIM records; delete the duplicate `_dmarc.everyapp.dev` TXT.
- **Settles**: L7 and the apex mail setup.

---

## C. Nice to know

Useful, not blocking; most are v2 or cutover items.

| Check | Run | Expected / why it matters |
|---|---|---|
| GitHub App push to a user-created empty repo; the pre-filled `github.com/new` link for org members (R26; H33) | PR #281 POC app on a test org, "selected repositories" install; try the link as a member without repo-creation rights | Docs say invalid parameters are dropped silently; fallback is the v1 CLI path |
| A running Workflow instance resumes on new code (R37; H36) | Scratch Worker: instance with `step.sleep(2m)` logging a version constant after the sleep; deploy a new constant during the sleep | The 24 h legacy settle path covers both outcomes |
| `app.openseo.so` custom hostname under the zone hold; O2O reaches `*/*` (R38; H40) | Scratch SaaS zone: hostname with TXT pre-validation, read `status`; CNAME a scratch `openseo.so` subdomain and curl for `cf-connecting-o2o: 1` | Provider guide says only "Also prevent Subdomains" blocks a subdomain |
| Google OAuth re-verification; `sub` across clients (R39; H18 OpenSEO) | Google Cloud console / support; sign in through two clients and compare `sub` | Mitigated by the `app.openseo.so` relay and verified-email linking |
| Enterprise zone move between accounts (U13 openseo) | Ask the Cloudflare account team | Only if D7 ever prefers moving `openseo.so` |
| OpenSEO prod sizes (U14 openseo; H35) | Read-only SQL on a PlanetScale branch: users, orgs, members, Google-only and unverified users, paying customers by plan, `topup_credits > 0`; R2 bucket size; `OAUTH_KV` key count | Sizes the import and the `OAUTH_KV` copy |
| `OAUTH_KV` grants valid after a key-by-key copy (U15 openseo; H39) | Copy one grant and one client record to a scratch namespace bound to a scratch OpenSEO; refresh a token | If not, clients re-authenticate at cutover |
| Imported 1.6.22 rows verify on 1.7.7 (U17 openseo; H35) | One rehearsal sign-in on a scratch hosted D1 after the import dry run | Verified from code (`@better-auth/utils@0.4.2` in both trees); confirm once |
| Workers Logs event size and billing past 5B/day (econ U8) | Emit known logs from a test Worker; read Billable Usage after 2026-12-01 | The $3,000-5,500/day abuse estimate (C10) |
| Usage assumptions (econ U7) | Product analytics over the first 100 orgs: apps opened per Free org, requests/member/day, peak-hour share | Replaces the 1.5-of-4, 5 × 300/day, 10% figures in C10 |
| Migrated catalog DB size and average tenant DB size (econ U6) | Create and migrate each catalog DB, read `file_size`; sample real orgs after launch | ~50 KB and 4 MB assumed |
| Cloudflare for SaaS $0.10 is monthly (econ U12) | First invoice once H26 ships | Docs say "per additional hostname"; the 2022 blog says "a month" |
| An unused DO namespace costs nothing on self-host (release item 8) | The self-host account's bill after adding `OrgWallet`/`EveryAgent` classes | Expected $0 (no requests, no duration) |
| Staging domain names and cost (release item 9) | Registrar quote | Two cheap zones for the staging account |
| Gradual-rollout thresholds (release item 7) | Compare the first three production releases against Workers analytics by version | 10/50/100%, 10-minute dwell, 5xx gate are tuning |
| Device-session sign-out after the PAT exchange; PAT revocation on membership end (release item 10) | Unit test against `UserPatService` and the device-authorization plugin | H12 |
| Cloudflare OIDC for GitHub Actions API tokens (release item 11) | Cloudflare API token docs or a support ticket | Design assumes long-lived account-owned tokens in GitHub environment secrets |
| Postmark/SES/Resend details (email) | Only if R45 forces a second provider | Not needed under the default |
| Whether "provider" in 18 U.S.C. § 2258A/2258E covers this platform; counsel cost; whether 34 Harding Street is a business address (email/legal) | Counsel quote; Ben | Pre-public-sign-up review (D16) |
| pkg.pr.new private-repo support (forks U7) | Not relied on | n/a |
| `cf` 1.0 beta Build Output stability across forks built weeks apart (forks U10; R19) | Pin `cf` in mirrors; the deployer checks `buildOutputVersion` from `bundle.json` | Add Build Output version to the protocol floor if it drifts |
| AI Gateway per-value spend-limit overrides or strong consistency; managed multi-tenant Cloudflare OS (R23) | Changelog watch | A5's budget engine could move; positioning changes |
