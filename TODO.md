# TODO

Open decisions and follow-ups from the October 2026 platform work (#267–#274).
Check an item off, or delete it, once it's decided or done.

## Decide

Each of these shipped with a default. Confirm it or change it.

- [ ] **Password accounts and Cloudflare Access.** An existing password account has to connect Access once before it can sign in through Access.
- [ ] **Mobile app behind Access.** With Access in front of the whole gateway, the mobile app can't sign in. Mobile users need the SSO-button mode instead.
- [ ] **MCP defaults.** OAuth is on, and dynamic client registration is on with limits. `MCP_OAUTH_ENABLED=false` and `MCP_DCR_ENABLED=false` turn them off.
- [ ] **Destructive tools.** Tools marked destructive (e.g. delete todo) stay hidden from AI clients until approvals exist.
- [ ] **Old invites.** Invites are now one-time links, so invites emailed before #268 stop working.
- [ ] **Setup link expiring mid-wait.** If the owner setup link stops working while `everyapp setup` waits, setup doesn't make a new one.
- [ ] **RepoLens badges.** Badges are public even for private repos. Keep that, or return 404 for private ones?
- [ ] **RepoLens access.** Set `access: "everyone"` in its manifest before its first deploy if the whole org should see it (`--access` went with the flat command tree).
- [ ] **RepoLens retry backfill.** Left out of its MCP tools, because it deletes fetched history.
- [ ] **TanStack Start 1.169.** The platform's apps are pinned to Start 1.168.61, because 1.169 needs Vite 8. RepoLens already runs 1.169 on Vite 8, so the upgrade looks safe.
- [ ] **Gateway UI scope.** Only the gateway moved to OpenSEO's shadcn design system. The todo app, Chef, the workout tracker, the simple-todo template and the landing page still use daisyUI or their own styles.
- [ ] **Gateway look.** Every App's metallic primary buttons and neutral accents, on OpenSEO's surfaces. Dark mode uses OpenSEO's dark greys, with a lighter metallic so the buttons stand out on them. Check the dark-mode buttons.
- [x] **Gateway layout.** A sidebar (OpenSEO's app shell) replaces the top header and the admin tabs. Admin pages now open on phones too, where the old UI showed "not supported on mobile".
- [ ] **When the schema check runs.** `deploy` checks an app's drizzle migrations against its schema after the build, so under the app's lease: the build needs resources created under the lease, and the check needs the dependencies the deploy installs. The redesign's step 7 asked for it before the lease as well.
- [ ] **A schema check drizzle-kit can't finish.** When `drizzle-kit generate` fails (most often a renamed column, which it asks about only at a terminal), the deploy stops with `SCHEMA_CHECK_FAILED`. Only a missing drizzle-kit or drizzle config is a warning.
- [ ] **`dev --host` takes an address.** `everyapp dev` listens on 127.0.0.1; `--host 0.0.0.0` opens it to other machines. Vite's bare `--host` (no value) isn't supported.
- [ ] **`app create -y`.** With nothing left to confirm, `-y` means "never ask": an app id is then required, as under `--json`. A failed `cf workers types` or local migration in `create` is a warning, since `dev` redoes both.
- [ ] **The organization before an owner.** A deploy to a Gateway with no organization makes one named after the Cloudflare account (slug from that name, else "default"). Its org key, and so every app's Worker and resource names (`every-acme-todo`), comes from that slug for good, even after the claim renames the organization to the owner's name.
- [ ] **Deployer access needs a verified email.** A new app is granted to the `users` row whose verified email is the cf login's. Password accounts are never verified (only Access sign-in verifies), so without Access "private to you" means owners and admins only.
- [ ] **API-token deploys.** With `CLOUDFLARE_API_TOKEN` set the actor is `api-token:<account id>`, and nobody gets the new app as its deployer, even if cf reports the token's user's email.
- [ ] **`--no-wait` skips the whole live wait.** The app then goes live on its first visit. (Named after the certificate wait until the flat command tree.)
- [ ] **The live wait's outcomes.** No certificate after 10 minutes is a warning and exit 0 (as the certificate wait was); the Gateway answering for 10 minutes without activating the app is `APP_NOT_LIVE` (exit 1, retryable).
- [ ] **No SDK or CLI version check when deploying an app.** `minSdk` and `minCli` came from `/api/deploy/whoami`. The redesign's "a checkout older than the live Gateway refuses" (step 3) may be enough; else read the checkout's build constants.
- [ ] **Status reads certificates from Cloudflare's certificate packs** (active, exact host or one-label wildcard). A hostname covered only by Universal SSL could read as "no certificate yet".
- [ ] **The release-identity probe went with `/api/deploy/status`.** An upgrade that stopped before recording itself is no longer recognized as newer: `setup` and the rebinds stop unattended and ask at a terminal. Step 3's install row written before the upload closes that window. Since step 3 the install row is the only truth: a reconcile with the live release no longer checks which version the Worker serves (only cf's strict mode stops it over a dashboard edit).
- [ ] **Setup's reachability check only warns.** A Gateway that doesn't answer over HTTPS yet, or answers with Cloudflare Access's sign-in, is a warning before the owner link, and setup waits for the claim all the same.
- [ ] **App commands find the account without `--account-id`.** Since step 3: Gateway discovery through every account the login sees; one Gateway is the one, several need `--account-id`, `CLOUDFLARE_ACCOUNT_ID`, the named host or a prompt.
- [ ] **`--gateway` picks among several Gateways.** When the login sees several, the host `--gateway` (or `setup --domain`) names picks the one install with that host before anything asks; it is still `GATEWAY_URL_MISMATCH` when it names none.
- [ ] **Several Gateways, unattended: `choose_account`.** A new `action_required` action (exit 2) with `data.choices` (account, name, Gateway URL, and each one's rerun with `--account-id`); its `data.rerun` is a template (`… --account-id <account-id>`).
- [ ] **`CLOUDFLARE_ACCOUNT_ID` counts like `--account-id`.** Naming an account without a Gateway is `GATEWAY_NOT_FOUND` for app commands (saying where the Gateway is), not ignored; for `setup` (and `deploy`'s offer to install) it is where to install a new one.
- [ ] **Tokens that list no accounts.** An `--account-id` or `CLOUDFLARE_ACCOUNT_ID` that `cf auth whoami` doesn't list is probed anyway, for API tokens without account read access.
- [ ] **Errors while probing an account.** `auth` and `not_found` (also when reading the install row) mean "no Gateway here"; any other failure (network, timeout) stops the command rather than calling the account empty. No probe timeout beyond the runner's 2 minutes yet (live check below).
- [ ] **`status` with no Gateway fails.** It stops with `GATEWAY_NOT_FOUND` (exit 1) like every other command, instead of a `done` with `deployed: false`; a database without an install row is still a `done` with `installed: false`.
- [ ] **Device login under `--json` everywhere the connect path runs.** `setup`, `status`, `deploy` (and `secret`, `create --deploy`), `delete`, `db query` and `workflows` with `--json` wait for cf's device login.
- [ ] **What the build cache hashes.** Every file `git ls-files --cached --others --exclude-standard` lists under `apps/every-app-gateway`, `packages/sdk`, `packages/perimeter`, `packages/toolbus` and `pnpm-workspace.yaml`, as on disk (ignored files such as `.env*` never count). Without git there is no cache: every deploy builds.
- [ ] **The build cache keeps three builds**, the most recently used, under `node_modules/.cache/everyapp/<tree>.tar.gz`.
- [ ] **Releases ordered by commit time.** The downgrade guard orders by newest migration, then the last commit touching the Gateway's sources (`git log -1` over the hashed paths), not build time, which an old checkout or a cache hit gets wrong. The install row keeps it as `release_committed_at`, with `source_tree_sha256`. A dirty tree orders as its base commit; without git, as now.
- [ ] **Same version, different commits, in the refusal.** `DOWNGRADE_REFUSED` names versions, and adds each side's source commit date when the versions are equal (`0.2.0 of 2026-10-12`).
- [ ] **App deploys and deletes refuse an older checkout even without a rebind.** Checked before the registry is touched, with no override; only `setup --allow-downgrade` rolls the Gateway back.
- [ ] **A rebind with the live release skips migrations and the replace check**; one with a newer release (the checkout moved on) migrates first, as an upgrade.
- [ ] **The tree hash is the Gateway's identity, not the release SHA-256.** Builds aren't reproducible (checked locally: two builds of one tree name their client chunks differently), so another machine at the same commit builds another SHA-256. "The live Gateway" means the same SHA-256 or the same source tree everywhere: `status`'s `upToDate`, `setup`'s nothing-to-do, the downgrade guard, and a rebind that skips migrations.
- [ ] **Status's checkout fixes.** `GATEWAY_OUTDATED` (sources changed since the live build) runs `everyapp setup`; `CHECKOUT_BEHIND` runs `git pull`. `upToDate` is `null` when either tree hash is unknown.
- [ ] **The install row before the first upload** names the release being installed, with `live_version_id`, `live_domains` and `jwt_public_key` empty; app commands refuse it (`GATEWAY_NOT_INSTALLED`, run `setup`) and `status` says `GATEWAY_NOT_UPLOADED`.
- [ ] **`deploy --yes` installs the Gateway without asking** (so does `create -y --deploy`). At a terminal, `-y` takes `apps.<zone>` (still asking which zone when the account has several); unattended (`--json`, CI, piped output) `deploy` never installs one, `-y` or not: it stops with `install_gateway`.
- [ ] **The install offer proposes `apps.<zone>` only.** Another hostname means declining and running `setup --domain`; the offer doesn't ask for a hostname the way `setup` does.
- [ ] **The inline install waits for the owner.** `deploy`'s install runs setup's owner step (up to 15 minutes) before the app goes up; if nobody opens the link, the deploy ends with `claim_owner`, and the next `deploy` puts the app up.
- [ ] **`install_gateway`'s rerun names a host.** `pnpm everyapp setup --domain apps.<first active zone>` of the account setup would pick (with `--account-id` when one was given), or `<hostname>` when it can't tell (several accounts, no zone). `create --deploy` offers to install too; `secret set|unset` don't (`GATEWAY_NOT_FOUND`).
- [ ] **What `setup` ends with.** "Your Gateway is ready" and `Next:` only after an install or when it just made the owner; an upgrade ends "Gateway X at … is up to date."; a repair or a run with nothing to do prints only its one line. `--force-dns` stays a visible `setup` flag, since `DNS_RECORD_CONFLICT`'s rerun adds it.
- [ ] **`secret set` and `unset` change the live Worker and never deploy (Ben, 2026-10-17).** One `cf workers secrets bulk` call per Worker (the app's and each helper's, or the Gateway's) under its lease, after the replace check; the version Cloudflare makes is recorded as everyapp's (the app's Worker record, or the install row's `live_version_id`), so the next `deploy` or `setup` replaces it unattended. The output says which command deploys the checkout's code. Reverses the redesign's "`secret set` keeps redeploying": several secrets no longer cost a build each.
- [ ] **`secret list` prints every name**, everyapp's own (`GATEWAY_URL`, `EVERY_APP_ORG_ID`) included; `--for` takes only `gateway`; `secret`'s `-y` is accepted and asks nothing (nothing asks).
- [ ] **`db migrate` is local only.** `--local` is accepted, documented as the default; there is no production migrate outside `deploy`.
- [ ] **The skill is copied, not linked**, into `.claude/skills/everyapp` and `.agents/skills/everyapp` of each new app (a standalone app is its own repository; git on Windows checks symlinks out as files). A missing `AGENTS.md` is written; an existing one that doesn't mention the skill gets a line only after a person agrees. The skill's "Ship" line has no `--yes` (nothing to skip under `--json`).
- [ ] **`lib/interrupt.ts` kept whole.** Its upload record on Ctrl+C keeps the install row naming the live version (the downgrade guard, `status` and the replace check read it), and freeing the lease spares the rerun a wait of up to 3 minutes; the redesign expected both to go.
- [ ] **OpenSEO: a mode, not a fork.** OpenSEO gets `AUTH_MODE=everyapp` upstream. Since 2026-10-17 the mode is prototyped in the private scratch copy `bensenescu/open-seo-everyapp` (PRs #1 mode, #2 deploy-stage, #3 follow-ups; merge there when CI is green) and comes home to `bensenescu/open-seo` as one PR when Ben says it is settled; nothing is opened or merged on open-seo before then, and app.openseo.so is never deployed from the scratch repo. The Docker edition stays a fork, because it replaces the runtime.
- [ ] **Integrations before GitHub.** DataForSEO and Context.dev came first, as API-key integrations in gateway Worker secrets ([docs/capabilities.md](docs/capabilities.md)). The manifest's request is the grant, as for AI providers; admin approval and keys encrypted in D1 come with the Google phase. The redesign review ([docs/design/2026-10-redesign-review.md](docs/design/2026-10-redesign-review.md)) keeps the Worker secret as the operator default behind a `resolveCredential` seam, with per-organization keys later.
- [ ] **AI providers fold into `integrations`.** Reverses the phase-0 default (OpenRouter beside OpenAI in `providers` and `/api/ai`): one registry, one `/api/integrations/<id>/<host>/<path>` route, one `gatewayFetch`, with the model and route allowlists kept as the AI packs' own checks. `providers` and `ai` leave the manifest (redesign review #1).
- [ ] **Apps may frame their own pages.** The gateway keeps an app's `frame-ancestors 'self'` (and a stricter `base-uri 'none'`) instead of forcing `'none'`, for OpenSEO's report viewer.
- [ ] **App Workflows.** Allowed when the app's own Worker defines them and they're named `<worker>--<binding>`.
- [ ] **Helper Workers.** An app may ship Workers of its own (`workers` in its manifest), deployed as `<worker>--<name>` before the app's Worker. Only the app's Worker can reach one; it shares the app's D1, KV and R2 and calls the gateway as the app. OpenSEO's site-audit engine runs on one. Redesign review #3: a helper presents its own Worker name in the binding's props, so a background call is attributed to the Worker that made it.
- [x] **Manifest integration entries lose `as` and `background`.** Landed with the key renamed to `capabilities` (entries `{ access, why }`). An approval is of the app, attribution comes from the identity header, and an organization's connection always allows background use (Ben, 2026-10-15). Background writes on write-capable providers get an admin checkbox later (redesign review #2).
- [ ] **Google: the operator holds the OAuth client, each organization connects its own accounts.** Decided by Ben on 2026-10-15; designed in [docs/design/2026-10-google-integration.md](docs/design/2026-10-google-integration.md). The remaining defaults, each with a recommendation in that doc's Appendix B:
  - [ ] Hosted has two kinds of apps (settled by Ben, 2026-10-16): first-party catalog apps such as OpenSEO run as one shared Worker per app over multi-tenant Postgres (the hosted research's platform tier), and third-party apps run one Worker per organization on Workers for Platforms (dispatch tier). Google accounts and grants are per organization on both. A platform-tier Worker learns the organization from the identity token, or for background work asserts it with `x-everyapp-org` and the gateway checks that organization's install row (research H17a, [docs/research/2026-10-hosted-platform](docs/research/2026-10-hosted-platform/README.md) on `research/hosted-platform`, PR #299). The earlier "about 200 organizations under the 500-Workers limit" framing is withdrawn. Built without install rows (#310): the gateway accepts `x-everyapp-org` from a shared Worker for an active organization with a live member.
  - [ ] No multi-organization gate: every uploader we ship is trusted (the operator's CLI on self-host, the deploy service on the dispatch tier, our own code on the platform tier). A gateway-issued per-app caller credential stays a later hardening for self-host gateways where several people deploy for several organizations.
  - [ ] Names follow the hosted research so both designs read the same: manifest key `capabilities`, table `app_capability_grants` keyed by the app row, per-organization keys on `organization_data_keys`; one route name, settled in the contracts PR.
  - [ ] The gateway uses its own Google Cloud project and OAuth client, not OpenSEO's verified one, because adding redirect URIs to a verified client may trigger re-verification (research R39, unverified). Organizations reconnect Google once rather than having tokens migrated; the OpenSEO cutover is dropped and app.openseo.so stays as it is.
  - [ ] `INTEGRATIONS_KEKS` is a keyring (`active` plus keys by id) so it can be rotated; the rewrap cron and CLI runbook can follow the first release.
  - [ ] Removing a Google account revokes at Google only when no other organization holds the same identity, since Google revokes per person and client, not per token.
  - [ ] Owners and admins connect Google; members get an ask-an-admin link; agents can't create connect links.
  - [ ] `needs_reauth` emails the organization's owners and admins and banners the gateway home, because background work otherwise stops silently.
  - [ ] Rate limiting: start with Google's own 429 passed through; add per-organization and gateway-wide counters only if a shared client's quota becomes a problem.
  - [ ] Local dev: the SDK's direct-to-provider fallback goes away; the gateway-lite proxies `/api/integrations` from `.dev.vars`, and `everyapp dev google connect` stores a refresh token from one team Desktop-type client.
- [ ] **OpenSEO in Every App: how the two threads divide the work (reviewed 2026-10-16; Ben ruled the same day).** Settled by Ben: `app.openseo.so` keeps running as it is; on everyapp.com OpenSEO is a first-party app (one shared Worker over one multi-tenant Postgres database through Hyperdrive, identity from the gateway); organizations may also deploy forks of OpenSEO as third-party apps on Workers for Platforms with D1; the Google OAuth client and secret live in the gateway for both. The hosted thread ("Design a Multi-Tenant Hosted App Platform", PR #299; its research is numbered H0 to H42 and its chat plan of 27 PRs is written down nowhere else) had marked OpenSEO as not forkable onto the dispatch tier, so forks are new work for both threads. Defaults proposed, each to confirm:
  - [ ] One `AUTH_MODE=everyapp`, not one or two new modes. Identity is the same in both hosted shapes; what differs is three switches: `EVERY_APP_ORG_ID` set pins a fork to one organization, unset means the organization row comes from the token (first-party); `DATABASE_PROVIDER` picks D1 or Postgres as it does today; a job-runner flag with a derived capability list hides the job tools where no runner exists. The client reads `AUTH_MODE` at build time, so each extra mode would be a separate client build; per-tier differences reach the client as runtime data.
  - [ ] First-party OpenSEO deploys through `everyapp deploy` from its manifest (helper audit Worker, three Workflows, the five-minute cron), not through an OpenSEO Alchemy stage as the research's H18 assumed. The CLI gains a `hyperdrive` resource bound to the app and the helper, a Postgres migration step (drizzle-kit against a direct database URL the operator holds), `DATABASE_PROVIDER=postgres` as a text binding, and a placement hint near the database. The dispatch tier refuses `hyperdrive` (25 configs per account). Rendering stays Context.dev through the gateway rather than a Browser Rendering binding, unless audit quality suffers. As of 2026-10-16 the CLI side is #309 (merged), and the first deploy is open-seo-everyapp #2's Alchemy stage, registered with `everyapp register` (#307).
  - [ ] The first-party database is a new PlanetScale Postgres, not app.openseo.so's, in whichever Cloudflare account runs the hosted gateway, since service bindings are same-account (research D7, still open; default a new dedicated account for everyapp.com).
  - [ ] Forks ship in tiers. Tier 0 when the dispatch tier opens: research tools, SAM chat and Google through the gateway, with `run_site_audit`, `run_rank_tracker`, `run_ai_visibility_check` and `complete_ai_research_setup` hidden by a capability flag and a manifest without Workflows, crons, KV or the audit helper (about 1 to 1.5 agent-days). Rank tracking once the gateway scheduler (research H15) and a job runner exist; AI visibility next (its research-setup result moves from Workflow output to the database); audits last, after a spike on a Durable Object binding between two user Workers decides single Worker or helper. Full parity is not a launch requirement.
  - [ ] A fork is code the organization deploys itself with the CLI through the hosted deploy API (research H12), under the research's rules for custom code: zero inherited grants with the admin's "approve as upstream" shortcut; the Paid plan once audits add a second Durable Object class and audit-length CPU. No one-click "my own OpenSEO instance": anyone who just wants OpenSEO uses the first-party app, so H17b's lazy installs and warm D1 pool are not needed.
  - [ ] Third-party background work: the gateway scheduler (research H15) first; then a gateway-hosted replay step runner (the gateway posts `{instanceId, params, steps}` to `/__everyapp/workflow/<name>/step`; the Worker replays and runs one new step or returns `sleepUntil`), built by the hosted thread after H15 with the protocol in the contracts PR. OpenSEO's side is the same for any runner: a replay-based step shim, a jobs facade over its 10 Workflow call sites, three rethrow edits, about 4 agent-days. No Hatchet or Temporal; Inngest only if we buy instead of build; Dynamic Workflows (open beta) watched, not planned on. First-party OpenSEO keeps its Workflows, cron and helper Worker as they are.
  - [ ] Fork egress: OpenSEO fetches arbitrary customer sites, which default-deny egress for third-party apps (research H16) would block even at Tier 0 (website research). Default: a `crawl` capability the organization's admin approves at deploy, allowing open http(s) egress except the metered provider hosts.
  - [ ] Launch gating for first-party: an invite-only preview as soon as identity, Postgres and background organization attribution work, with Google shown as not available yet and provider calls attributed and logged at the gateway. Public sign-up waits for verified Google and the org wallet (research H13, H18). OpenSEO's own Autumn credits stay off on everyapp.com in both shapes.
  - [ ] Google consent screen reads "Every App" for every app and fork (branding is per Google Cloud project and Google enforces one brand per project); scopes are Search Console and Analytics read-only only (OpenSEO reads Business Profile data through DataForSEO and submits URLs through IndexNow); the project is owned by Ben's Google account with everyapp.com DNS-verified in Search Console. Verification is submitted this week; it is the external critical path.
  - [ ] This branch lands first: rebase phase 0 onto `main` and merge it, then the OpenSEO `t3/every-app-mode` PR (51 uncommitted files), so the hosted thread builds on committed code. Contract names come from the research (`capabilities`, `app_capability_grants`, `x-everyapp-org`, `aud = workerName`); the step-runner protocol joins them. The hosted thread owns the dispatch tier, deployer, scheduler, wallet, grants and the step runner; runs the live checks this week (service-binding props from a namespaced script, cross-script Workflow binding, Durable Object alarm limits on Workers for Platforms, a Durable Object binding between two user Workers, the 32-invocation cap); and amends its README (first-party OpenSEO on Postgres through Hyperdrive and the CLI, the Google relay through app.openseo.so dropped, `forkable` per tier for OpenSEO, H25 multi-Worker apps if forks ship audits). Done 2026-10-16: phase 0 landed as #303 and #306 and the OpenSEO mode is open-seo-everyapp #1 (was open-seo #983, closed unmerged on 2026-10-17 with the move to the scratch repo); `aud = workerName` is #304 and `x-everyapp-org` #310; the grants table was deferred.
  - [ ] Todo, chef and workout become first-party multi-tenant apps too (the hosted thread's default). The dispatch tier is needed for OpenSEO forks, not for anything first-party.
- [ ] **OpenSEO roles.** Gateway members are OpenSEO members: they research, but can't create or delete projects or connect Google. Cloudflare Access mode made everyone an owner.
- [ ] **OpenSEO's destructive tools.** Only its deletions (`delete_*`, `remove_*`) are destructive on the gateway, so saving keywords or reports stays usable. Its own MCP marks 11 tools destructive.

### Hosted build (2026-10-16)

Defaults the overnight build of the hosted platform shipped without Ben. Each item says what shipped; yes keeps it. [docs/hosted-platform-build.md](docs/hosted-platform-build.md) §3 has the reason and the walk-back for each.

**Hosting shape**

- [ ] **First-party hosts share the control plane's cookie.** First-party apps live at `<app>.app.everyapp.com` on one session cookie for `app.everyapp.com`; third-party apps live on `everyapp.dev` with a session per host (#314).
- [ ] **The host never picks the organization.** One hostname per first-party app; a person works in their session's organization (their personal one, else the last active, else the first joined; the switcher changes it).
- [ ] **The install organization is the platform organization**, always named Every App whatever the claimant types; it owns every shared app, and first-party Workers' binding props name it.
- [ ] **The hosted gateway activates first-party apps on their first request**, as self-host does.
- [ ] **A missing or mistyped `GATEWAY_DEPLOYMENT_MODE` fails closed in both modes**: a self-hosted gateway that loses it refuses the setup claim, Access sign-in, dynamic registration, app activation and account actions until someone sets it.
- [ ] **The hosted gateway ignores and logs `CLOUDFLARE_ACCESS_*` and `EMAIL_PASSWORD_SIGN_IN`** rather than refusing to start.
- [ ] **Install tables from before `--mode` aren't migrated**: `status` shows no Mode line for them, and writes fail until the table is recreated (thecomeup.cc is reinstalled anyway, below).
- [ ] **The identity audience is the Worker name for every app**, first-party and self-hosted included, with no compatibility window: an app not built with `everyAppWorker()` answers 500 until it sets `EVERYAPP_AUDIENCE`, and apps refuse identities between a gateway upgrade and their own redeploy.
- [ ] **A browser carrying two session cookies is locked out until it clears cookies** (a 401 with a hint), rather than treated as signed out.
- [ ] **`APP_BASE_DOMAIN` stays the gateway's host on hosted**, so the mobile shell's copy of the session cookie matches the server's and it never holds two.
- [ ] **Redirect URIs on the platform's domains are refused at authorize, consent and the token endpoint**, not at dynamic client registration.
- [ ] **Deferred**: publishing the SDK and CLI, the agent, organization deletion and export, legal pages, and email bounce handling.

**Sign-up and organizations**

- [ ] **Open sign-up with verified email and daily mail budgets**, no Turnstile or social sign-in yet; invited sign-ups verify too, and verification links last 24 hours.
- [ ] **The preview launches invite-only** (`HOSTED_OPEN_SIGNUP=false`, as the hosted-install runbook says).
- [ ] **Exactly one personal organization per verified account**; growth by invitation; no self-serve creation or deletion.
- [ ] **A personal organization is named after the person** ("Ada Lovelace", else the email's local part), not "Ada's workspace".
- [ ] **An invitee whose invitation expired before they joined has an account and no organization**, and gets no personal one at the next sign-in.
- [ ] **Mail budgets**: hosted 5 per address per kind per day and 2,000 verification, 1,000 reset and 2,000 invitation emails per gateway; self-hosted 10 and 1,000.
- [ ] **Self-hosted people in several organizations start in their last active one**, not the organization picker.
- [ ] **On hosted, Delete removes a person from the organization and keeps their account**; admins can't deactivate accounts or reset passwords.
- [ ] **A member of two organizations keeps one MCP connection per organization** for the same AI client, rather than the newest replacing all.
- [ ] **A suspension applies to the organization acted under**: a member of a suspended organization still opens their other organizations' apps.
- [ ] **A suspension takes up to 30 seconds** to stop a shared app's background work (the caches' window).

**Shared apps and attribution**

- [ ] **No install rows**: every organization gets every shared app, and an organization can't hide or cap one.
- [ ] **Other organizations see shared apps read-only in Admin → Apps** rather than not at all.
- [ ] **An API token may deploy, register and delete shared apps** as the account's own authority (CI), alongside the platform organization's owners and admins.
- [ ] **Externally deployed first-party Workers take the registry's names** (`every-everyapp-<app>`), not names of their own.
- [ ] **Chef is in the day-one catalog.**
- [ ] **Background work counts only for an active organization with at least one member who isn't banned.**
- [ ] **Pending and unverified members count as live** for background attribution.
- [ ] **A capability's status is answered to a shared Worker without naming an organization.**

**Capabilities and keys**

- [ ] **Keys at the gateway, metering later.** The DataForSEO, Context.dev, OpenRouter and OpenAI keys live only at the gateway; OpenSEO's Autumn is off in both Every App shapes; nothing is metered until the wallet; public sign-up waits for verified Google and the wallet (also the other thread's default 2).
- [ ] **DataForSEO's account-wide endpoints are refused for every app**, first-party OpenSEO included.
- [ ] **An organization's own app may call without an identity**: the call is served and attributed to the app's organization, with no `background` opt-in in the manifest.
- [ ] **`integrationFetch` and `integrationStatus` keep their names** (not `capabilityFetch`).
- [ ] **`read` is the only access level DataForSEO and Context.dev offer.**
- [ ] **The AI proxy's own refusals carry no `x-everyapp-error`** until the AI providers fold into the capability registry.
- [ ] **Helper Workers share all of the app's D1 and KV and call the gateway as the app**, with no narrower grant.
- [ ] **Helper Workers get the app's secrets by default.**

**OpenSEO**

- [ ] **OpenSEO's own MCP, API keys, team UI, invitations, ownership transfer and Google connect are off in `everyapp` mode** until the gateway provides them.
- [ ] **Every organization gets paid-size audits (10,000 pages) but two running at a time**, and the plan gates the gateway can meter stay open during the preview.
- [ ] **Scheduled rank checks and AI visibility run by default in the first-party shape** (open-seo #990, reversing #983); `FIRST_PARTY_SCHEDULED_CHECKS=off` holds them.
- [ ] **A `[research-spend]` log line is the per-organization record of research cost** until the wallet.
- [ ] **Gateway organizations are stored as `Organization <first 8 characters of the id>`** (OpenSEO shows no organization names in `everyapp` mode).
- [ ] **Forks keep their data in the single shared-workspace organization**, not under the organization's own id.
- [ ] **"Sign out on Every App" opens the gateway's home**, where you sign out, rather than signing out in one click.
- [ ] **A SAM chat closes 15 minutes after it connects** (open-seo #990) and reconnects through the gateway, which re-checks the member; there is no per-turn membership check.
- [ ] **OpenSEO attributes gateway calls through two async-context scopes** (the request being served, the organization named) rather than a `for` argument on its ~40 fetchers; a path that names nobody throws before the call leaves (open-seo #990).
- [ ] **Request paths forward the person's identity** rather than always sending `x-everyapp-org`.
- [ ] **Inside a request, a call naming another organization is refused.**
- [ ] **A request still working within 15 seconds of its identity's 120-second expiry continues as background work** for its own organization.
- [ ] **SAM resolves its organization on each model call**, so a missing binding fails the turn when the model calls out rather than when it is built.
- [ ] **The platform organization "Every App" has the slug `every-app` and the key `everyapp`**, so OpenSEO's Worker is `every-everyapp-openseo`; `EVERYAPP_WORKER_NAME` overrides the name otherwise, rather than editing a constant.
- [ ] **The audit Worker's gateway binding names the app Worker** as its `workerName`.
- [ ] **The `everyapp` stage keeps its KV, R2, Workers and Hyperdrive on `alchemy destroy`**, like production.
- [ ] **A separate `.env.everyapp` and `pnpm deploy:everyapp:first-party`** rather than a flag on `deploy:postgres`.
- [ ] **Hyperdrive keeps production's 30-connection origin limit** for the new PlanetScale database.

**Third-party tier**

- [ ] **Third-party deploys stay off until the launch gate in docs/hosted-platform-build.md §1 passes, and opening them is a hand edit**: a hosted gateway with `THIRD_PARTY_DEPLOYS` exactly `on`, which `secret set --for gateway` refuses to set (#311).
- [ ] **A deploy key is a personal access token whose only scope is `deploy`**, owners and admins only, 30 days by default (#311).
- [ ] **A deploy key opens no app and no `/mcp`**, even its owner's.
- [ ] **`GET /api/v1/deploy-key` tells the CLI the key's organization** (a route beyond the spec's three).
- [ ] **Registering a third-party app is a separate call before its build**; deploying an unregistered app answers 404.
- [ ] **A deploy runs inside its POST** (no queue or Durable Object): the finished job under 20 seconds, else `running` for the CLI to poll for up to 6 minutes; one running job per app; a job past its 5-minute deadline is abandoned.
- [ ] **Third-party apps may use up to 2 Durable Object classes and static assets**, while KV, Workflows, helper Workers and crons are refused and compatibility flags are limited to `nodejs_compat`, `nodejs_compat_v2`, `nodejs_als` and `global_fetch_strictly_public`.
- [ ] **A third-party Worker gets only `GATEWAY_URL` and `EVERY_APP_ORG_ID`, as plain text**; any other secret or variable is refused until a secrets API exists.
- [ ] **A third-party app's D1 is recorded in the CLI's resource ledger**, not a new `apps` column.
- [ ] **Without `THIRD_PARTY_DOMAIN` a deploy is accepted with no hostname**; a later deploy names it.
- [ ] **Third-party bundles are built with the sentinel Worker name `every-hosted--sentinel`**, and the deployer writes the real names.
- [ ] **An app's tier never changes** (`APP_TIER_MISMATCH`), shared and dispatch included.
- [ ] **`EVERYAPP_DEPLOY_TOKEN` switches `everyapp deploy` to the hosted deploy API** (renamed from `EVERYAPP_TOKEN` in #311's fix round, which the docs use for the MCP bearer).
- [ ] **`CF_DEPLOY_TOKEN` lives in the public gateway Worker for the preview**, not in a separate deployer Worker as the research preferred.
- [ ] **`APP_BASE_DOMAIN` is always set on a hosted gateway**, so #313's domain check runs (it is skipped when unset).
- [ ] **`THIRD_PARTY_DOMAIN` is checked against `APP_BASE_DOMAIN` only**, not also against `GATEWAY_URL`'s host.
- [ ] **A registration that fails after its deploy job started leaves a failed `deploy_jobs` row** as the record of the attempt (#313).
- [ ] **The hosted pipeline runs every static check, creates the D1, uploads assets and builds the upload's metadata before migrating**, as the self-host deploy does (#313).
- [ ] **The CLI's hosted-deploy success line** says the app takes bearer tokens only until per-host sessions exist (#313's wording; #314 now has them, so it needs new words).
- [ ] **Host sessions last 24 hours, with a silent re-handoff** when one ends (#314); revocation is immediate because every request re-reads the gateway's session, membership and access.
- [ ] **Personal access tokens work on third-party hosts** (`*.everyapp.dev`) under the first-party rules.
- [ ] **`everyapp.dev` goes on the Public Suffix List.**
- [ ] **The handoff page posts itself** rather than asking "Continue to <app>?".
- [ ] **The host-session key is derived from `BETTER_AUTH_SECRET`** (HKDF), so rotating that secret ends every host session; no separate secret.
- [ ] **Third-party hosts are served by one hand-made Workers route and a wildcard DNS record**, not per-app Custom Domains, until the CLI's hosted install manages them.
- [ ] **A dispatched app has no internet egress** until the manifest gains an `egress` list.
- [ ] **Third-party apps start at 5 seconds of CPU and 200 subrequests per invocation**, OpenSEO forks included.
- [ ] **The hosted deployer authenticates with an API token from our own Cloudflare account** (no OAuth).
- [ ] **Namespaced scripts are tagged `org=<id>` and `app=<id>`**, so deleting an organization's Workers is one delete-by-tag.
- [ ] **A failed create or SQL call is reported, not retried** (it may already have been applied).

**Deploy toolchain**

- [ ] **OpenSEO's first deploy is the Alchemy stage, registered with `everyapp register`**; `everyapp deploy` from its manifest (#309) is the target (also the other thread's default 7).
- [ ] **A helper Worker the manifest dropped keeps running**, with a warning, until `delete --purge`.
- [ ] **The deploy reads the PlanetScale URL from the app's `.everyapp/secrets.env`.**
- [ ] **One URL serves migrations and Hyperdrive** for the first-party OpenSEO, split later with `HYPERDRIVE_ORIGIN_URL` if needed.
- [ ] **OpenSEO's Workers use targeted placement in the database's region**, not smart placement (#309; open-seo #984 uses smart placement until OpenSEO moves to `everyapp deploy`).
- [ ] **A Hyperdrive config binds to every Worker of the app by default.**
- [ ] **A password-only rotation needs a manual `cf hyperdrive update`** until the deploy can detect it.
- [ ] **The CLI depends on `@every-app/cf-rest` for tests only** until the deployer lands.

**The other thread's unconfirmed defaults** (handoff §5; the fuller text is in "OpenSEO in Every App" above; defaults 2 and 7 are under "Capabilities and keys" and "Deploy toolchain")

- [ ] **One `AUTH_MODE=everyapp` with switches**, not one or two new modes (built that way in open-seo #983).
- [ ] **Forks ship in tiers**: research tools, SAM and Google first; rank tracking with the scheduler and step runner; AI visibility next; audits last.
- [ ] **A fork is code the organization deploys itself** through the hosted deploy API, with zero inherited grants; no one-click "my own OpenSEO".
- [ ] **Google's consent screen says "Every App"** for every app and fork; the project is owned by Ben's Google account; verification is submitted this week.
- [ ] **A new dedicated Cloudflare account for everyapp.com.** The build assumed the existing account; decide before the first live provisioning. The gateway, the first-party Workers and OpenSEO's Hyperdrive config must share one account.

## Build

- [x] **CLI redesign**, decided 2026-10-15 and built 2026-10-16 as #284 to #296 (`docs/cli-redesign.md` §8 has the implementation notes). Originally: calm output and pure `--json`; the registry written through D1 with no deploy API, deploy tokens or `login` (ADR-0003 first); the Gateway built from the checkout and found through the account; dev without files; the flat command tree; one routing mode and one naming scheme; the 3-minute lease and the schema-drift check. First, and in an hour: squash the Gateway's and the apps' migration histories to one generated file each, regenerated rather than appended while nothing live exists. No backwards compatibility: thecomeup.cc is reinstalled, not adopted.
- [ ] Approvals by browser link, then show destructive tools again.
- [ ] An "Agent activity" page over the `mcp_tool_calls` audit table.
- [ ] Access levels for personal access tokens.
- [ ] `everyapp access enable` (was `gateway access enable`), to set up the Cloudflare Access application from the CLI.
- [ ] Owner recovery link and ownership transfer.
- [ ] `everyapp setup --owner-email`.
- [ ] `everyapp setup --target local`.
- [ ] AI Gateway routing.
- [ ] Metered billing at the gateway (deferred).
- [ ] OAuth: refuse app hosts outside the gateway's base domain. Only theoretical today, because the deploy already forces them to match.
- [ ] A CI step that compiles the docs site.
- [ ] `SCHEMA_DRIFT` gets `rerun: "pnpm db:generate"`, and `LEASE_HELD`/`LEASE_LOST` the same command again, once errors carry `rerun` (the calm-output step). Their messages say it today.
- [ ] **Redesign stack 1, integrations core** (review #2, #1, #5): `resolveCredential` seam with the Worker secret as operator default, `app_integration_grants` with deploy-time auto-approval for API-key reads, typed refusal codes and header owned by the SDK, operator vs organization-admin wording; then the AI fold (one registry, route and `gatewayFetch`, which also replaces the AI status route); then explicit attribution (`for: Request | { background: true }`), OpenSEO's request scope, and expired vs forged identities at the gateway. Explicit attribution (`for:`) is built in #310.
- [ ] **Redesign stack 2, identity** (review #3, #4): deploy policy pins the gateway binding's props for the app and each helper; identity tokens use `aud = workerName`, the SDK checks `EVERYAPP_ORG_ID`, one `OrgRole` type. On the hosted platform tier the props carry no organization and the SDK's pin is the install row instead (Google design §10). `aud = workerName` is built (#304); pinning the props in deploy policy is still to do.
- [ ] **Redesign stack 3, resources** (review #6, #7): R2 in the manifest and `storageBindings`, assigned by the gateway and checked by policy; then provisioned, recorded and purged by the CLI with Workflows deleted by derived name; `everyapp.config.ts` typed with `as const satisfies EveryAppManifest`.
- [ ] **Google as a gateway integration** (Search Console, Analytics), so OpenSEO stops needing its own Google client and `BETTER_AUTH_SECRET`: the PR stack in [docs/design/2026-10-google-integration.md](docs/design/2026-10-google-integration.md) Appendix A (PR 0 to PR 11, about 19 agent-days, 7 to 8 wall-clock days with four subagents). PR 0 is now a rebase: `main` took the CLI redesign (#284 to #298) under this branch, so `deployApp.ts` moved to `commands/deploy/`, the deploy API and deploy tokens are gone, and a trial merge conflicts in 11 files. In hosted, Google rides the platform tier's install rows and organization assertion (research H17a); the design's §10 lists what each side takes from the other. Pieces of `poc/github-integration` are ported by hand onto phase 0's route and registry; the branch is tagged `archive/poc-github-integration` and deleted once PR 6 lands. Submit Google OAuth brand and scope verification for the hosted client before PR 5 starts.
- [ ] **First-party OpenSEO prerequisites surfaced by the 2026-10-16 review.** (a) Background organization attribution: `integrationFetch` from crons and Workflows sends no organization today, so a shared Worker's DataForSEO, Context and OpenRouter calls are attributed to the app but not the organization; `for: { background: true, organizationId }` sends `x-everyapp-org`, checked against the install row at the gateway (redesign stack 2). (b) A deployment-tier predicate in OpenSEO separate from `AUTH_MODE`: in `everyapp` mode every plan gate no-ops, so the audit tier is `self_hosted` (10,000 pages, unlimited concurrent audits), scheduled rank checks and AI visibility run for every organization with no plan check (the hosted pause switch is hosted-only), and research spend is untracked; limits read the tier, Autumn stays on `hosted` only. (c) `hyperdrive` in the manifest, SDK type and CLI policy for the app and its helpers; a Postgres migration engine in `everyapp deploy`; placement. (d) OpenSEO's GSC preflight item says "Held by the Every App gateway" like DataForSEO and OpenRouter, and its own Google callbacks return 404 in `everyapp` mode. Built 2026-10-16: (a) #310, checked against an active organization with a live member rather than an install row; (b) and (d) open-seo #983; (c) #309. #309 and #310 are merged; #983 is open.
- [ ] **Fork tier for OpenSEO.** Tier 0 capability flag and manifest variant; later the replay step shim and jobs facade behind a job-runner flag, with the AI research-setup result persisted in the database instead of Workflow output; KV caches fall back to Durable Object or D1 storage because the dispatch tier refuses KV.
- [ ] Later from the review: per-organization API keys as `integration_accounts` rows (#13); per-organization usage and spend caps (#14); one `everyAppWorkers` builder with `vars`, `compatibilityFlags` and helpers in one call, `global_fetch_strictly_public` as the default, `withOpenSeoRuntime` deleted (#15); app secrets declared in the manifest and set without a full redeploy (#16); helper Worker removal and helper Durable Object tombstones (#17); GitHub as one App per gateway with state-bound installations.
- [ ] Removing a Durable Object class a helper Worker defines. The deploy refuses it today; `--allow-delete-durable-object-data` covers only the app Worker's classes. (Review #17.)
- [ ] App secrets for a helper Worker added later. A secret reaches the helpers deployed with it, so a new helper lacks it until `everyapp secret set` runs again. (Review #16.)
- [ ] Per-organization usage limits and metering (the wallet) are a later feature: nothing is counted or refused on volume today; every provider call is attributed to an organization and logged. Ben ruled on 2026-10-16 that limits are not on by default.
- [ ] OpenSEO (open-seo #990) still maps the gateway's `org_daily_cap_exceeded` refusal to `RATE_LIMITED` and keeps paid-plan gates open because "the gateway's daily cap bounds the preview"; the caps are gone, so drop the dead branch and revisit those gates in the open-seo repository.
- [ ] Delete an app's Workflows and R2 buckets on `--purge`. (Review #6, second PR.)
- [ ] A longer tool-call limit than 30 seconds for apps that need it (OpenSEO's prompt exploration).

From the hosted build (2026-10-16; [docs/hosted-platform-build.md](docs/hosted-platform-build.md) §8 has the detail):

- [ ] **The OpenSEO follow-up PR** (open-seo, after #310): `for:` on every gateway call (the request in server functions and tools; `{ background: true, organizationId }` in the Workflows, the cron and SAM, with the organization in each Workflow's payload); `EVERYAPP_SHARED=1` and `EVERYAPP_AUDIENCE` (the Worker's name) on both Workers; the SDK and CLI linked from `main`; the Workers renamed `every-everyapp-openseo` and `every-everyapp-openseo--audit`; `everyapp register` after each deploy; then `FIRST_PARTY_SCHEDULED_CHECKS=on`. Built as open-seo #990 (open, stacked on #984; Ben merges), with SAM sockets closed after 15 minutes and scheduled checks on by default.
- [ ] **OpenSEO onto `everyapp deploy`** (#309 has merged): Hyperdrive, `database`, Postgres migrations and the audit helper's `cpuMs` in its manifest; then delete the Alchemy stage, `.env.everyapp` and the binding script.
- [ ] OpenSEO: a membership check per SAM turn at the gateway, if #990's 15-minute socket lifetime is too long.
- [ ] OpenSEO: a gateway GET sign-out page for the account menu, and hosted wording for the SAM setup gate and banners.
- [ ] `everyapp register` lists `EVERYAPP_AUDIENCE` (the Worker's name) in `data.worker`, which an externally built Worker needs since #304.
- [ ] Check for a hosted gateway before `register()` writes an inherited shared scope.
- [ ] Suspend and reactivate an organization from the UI or the CLI (today a D1 `UPDATE`).
- [ ] `everyapp dev`'s gateway-lite serves `/api/integrations` and `/api/ai`, so background attribution runs locally.
- [ ] Log both organizations on `caller_org_mismatch`; tighten the `orgSource` type.
- [ ] A hosted install resumed before its first upload keeps `--mode hosted`; `setup` resends a missing mode secret from the install row.
- [ ] Admin → Users hides the account actions the hosted policy refuses.
- [ ] The CLI's gateway test fake applies the setup claim and the deployment mode.
- [ ] A per-organization daily invitation budget.
- [ ] Validate the install organization's name at the setup claim; clear the verification row when a failed personal organization deletes the user; the sign-up page waits for `sign-in-methods` before rendering the invitation form.
- [ ] `status` warns when a hosted gateway has no email; a fixed subject line for invitation mail.
- [ ] Turnstile, disposable-domain lists and ASN budgets before open sign-up.
- [ ] Organization leave, transfer and delete.
- [ ] Strip session-named `Set-Cookie` headers from app responses.
- [ ] The mobile shell scopes its session cookie as the server does, if `APP_BASE_DOMAIN` ever differs from the gateway host.
- [ ] A gateway-computed catalog fingerprint stored with the snapshot; optionally, the control plane's duplicate-cookie 401 expires the gateway's own cookie variants.
- [ ] The hosted install's patch profile adds the `DISPATCHER` binding with the gateway's `Outbound` entrypoint (parameters `["everyapp"]`), and the gateway config fixture is updated on purpose (needs a namespace).
- [ ] A manifest `egress` list snapshotted into the registry row, and per-app or per-plan dispatch limits.
- [ ] Check a dispatched Worker's name against its row's organization key; decide whether the egress allowlist names ports; one copy of `appBindingName()`.
- [x] Third-party per-host sessions add their cookie names to `sessionCookieNames` (#314).
- [x] #311's second-review findings (fixed in #313, merged): run D1 migrations after every static refusal (a dropped Durable Object class, a foreign migration tag) and after assets; accept deploy keys scoped exactly `["deploy"]`; drop `CLOUDFLARE_ACCOUNT_ID` from the hosted-install runbook's settable list; start the job before updating the registry row, and end it when `finish()` throws; check `THIRD_PARTY_DOMAIN` against `APP_BASE_DOMAIN`; reword the CLI's "goes live on its first visit" until per-host sessions exist.
- [ ] Move `CF_DEPLOY_TOKEN` into a thin deployer Worker behind `DeployerPort` (#311).
- [ ] Third-party secrets through the deploy API, and app delete and purge through it (the namespace script and its D1).
- [ ] Meter third-party deploys through the wallet; sweep stale deploy jobs on the hourly cron.
- [ ] A Public Suffix List check, so `THIRD_PARTY_DOMAIN` can't be a sibling of `APP_BASE_DOMAIN` on one registrable domain (#313).
- [ ] Reword the CLI's hosted-deploy success line, which still says bearer tokens only, now that #314 has browser sessions on app hosts.
- [ ] The CLI's hosted install manages the `*.everyapp.dev/*` route and wildcard DNS (#314).
- [ ] Submit `everyapp.dev` to the Public Suffix List.
- [ ] Sign-out on third-party app hosts (the host cookie lingers until it expires, though the session is revoked server-side).
- [ ] Cache or fold `HostSessionAuthenticator`'s per-request reads.
- [ ] A path for the mobile shell to third-party hosts.
- [x] Host-session follow-ups PR (`hosted/host-session-followups`, #315, merged as 40090696): `Referrer-Policy: no-referrer` on the code exchange's 303 and the expired-link page; rebuild a WebSocket 101 response after stripping third-party headers; log a registration failure after its job started once, not twice.
- [ ] `packages/cli`'s `interrupt.test.ts` failed once on timing and didn't reproduce in 8 runs; give its "stop cf's process group" case (about 4 seconds) more than vitest's 5-second timeout.
- [ ] `HELPER_DURABLE_OBJECT_REMOVED` names the real way out; a Build Output directory without `worker.config.json` is an `APP_POLICY` error; the lenient manifest schema drops the helper-name format rules.
- [ ] `delete --purge` reports unrecorded helper Workers; `secret list` shows helpers; `everyapp dev` with helpers gets a test.
- [ ] #309 merged with these open: migrate D1 too when an app also has Postgres (or refuse the pair); record or gate adopting a Hyperdrive config whose password can't be compared; `POSTGRES_DATABASE_URL` in the drift check's environment; a length check on `<worker>--<binding>`; the new outputs in `sdk.mdx`.
- [ ] Detect a Hyperdrive password-only rotation; `everyapp db query` for Postgres; the gateway's tolerant manifest schema accepts `migrations.dialect` (or the gateway is always upgraded first).
- [ ] Drop `boolean` from the REST client's D1 parameters unless the live API accepts it.
- [x] #308: authenticators must name their session cookies, the control plane logs the refusal and the app-host 401 says to clear cookies; `d1.query()` returns exactly one result or throws, `d1.queryAll()` returns all, and more than 10 tags are refused; the DataForSEO path check compares whole segments, `integrationStatus` guards unknown ids, and the SDK types and two docs pages name the new keys.
- [x] The consolidation PR: the CLI reference's shared-app scope rule, the security model's organization binding, capability attribution and dispatch re-check, and the hosted-install runbook's `--mode` warning.

## Paused while we work from the checkout

- [ ] Publish again: npm for `everyapp` and `@every-app/sdk`, then the public repository sync. `.github/RELEASE.md` lists what pausing removed.
- [ ] OpenSEO links `@every-app/sdk` and `everyapp` from a checkout, so its CI can't install them until they're published.
- [ ] The docs site (`landing-page/content/docs`) still describes the published flow: `npx everyapp`, and `gitpick` for the examples (its CLI reference says `pnpm everyapp`). Update it when publishing resumes, or point it at the checkout flow until then.

## Move the website to everyapp.com

In order.

- [x] Registration transferred from Namecheap to Cloudflare (2026-10-15).
- [ ] Delete the Afternic parking records in the everyapp.com zone, keeping the apex null `MX` and `v=spf1 -all` TXT until email is set up.
- [ ] Deploy the site (`pnpm deploy` in `landing-page/`), then the redirect Worker (`pnpm deploy:redirect`). The redirect Worker takes over everyapp.dev and www.everyapp.com as Custom Domains and 301s them to everyapp.com, path and query kept. Keep everyapp.dev renewed.
- [ ] Google Search Console: verify everyapp.com, run Change of Address from everyapp.dev, submit `https://everyapp.com/sitemap.xml`.
- [ ] Email still says `support@everyapp.dev` and `ben@everyapp.dev` (Proton Mail; `notify.everyapp.dev` sends through Resend). Move it only after mail works on everyapp.com.

## Check on the first live deploy

Everything below needs a real Cloudflare account. The rest was checked locally: fake-cf end-to-end tests, `cf dev` smoke tests, and offline `cf deploy --prebuilt --dry-run`.

- [ ] `cf auth whoami` with several accounts, and the CI path with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- [ ] The real error text when an account has no workers.dev subdomain, even with workers.dev off. The CLI matches on that text.
- [ ] A brand-new Worker accepts a secrets file holding the PEM keys, and its first version has the required secrets.
- [ ] Remote `cf d1 migrations apply` doesn't prompt and prints the expected output. Check `cf d1 time-travel get-bookmark` output, and that the printed restore command works.
- [ ] Several SQL statements in one `cf d1 query --body @file` call run atomically. The lease, setup link and install record rely on it.
- [ ] The shape and order of `cf workers deployments list`, and who a `cf deploy` is attributed to. A cf deploy must not trigger the "edited in the dashboard" abort on the next deploy; a real dashboard edit must.
- [ ] Source map size limits and Issues symbolication. Logs and traces show up in the dashboard.
- [ ] Rate limit namespace ids 4180 and 4181 don't collide with others in the account, and the limits behave in production.
- [ ] `cf workers delete <name>`, and the D1 and KV deletes behind `--purge`.
- [ ] Redeploying an app with Durable Objects from before cf (UserSyncDO) keeps its data, now that `exports` replaces wrangler's `v1` migration tag.
- [ ] Activation latency: from the Gateway deploy that binds a new app to the first request that makes it `active` in D1, against the live wait's 10 minutes, including a new hostname's certificate; and that a Cloudflare Access redirect is told from the Gateway's own answers.
- [ ] The register batch on real D1: `WITH … INSERT OR IGNORE … SELECT … ORDER BY … LIMIT 1` (the org-key claim) and `UPDATE … RETURNING` through `cf d1 query --body @file`.
- [ ] `cf ssl certificate-packs list` lists each Custom Domain's pack as `active` once issued (what `status` reads).
- [ ] The gateway's hourly cron (`17 * * * *`) publishes with the Custom Domains in one `cf deploy`, survives later deploys and reconciles, and logs `mcp.maintenance` at :17.
- [ ] With `global_fetch_strictly_public` on the deployed gateway, claude.ai connects through CIMD (consent shows "Published by claude.ai"), not dynamic client registration.
- [ ] `everyapp secret set MCP_OAUTH_ENABLED --for gateway` (and `MCP_DCR_ENABLED`) makes a new version with the switch on, the switch takes effect without a deploy, and the secret survives the next `setup`.
- [ ] `everyapp secret set|unset NAME` (and `--for gateway`): after `cf workers secrets bulk`, the next unattended `deploy` or `setup` isn't stopped by cf's strict mode ("last updated via the script API") because the version was recorded. If it is, record the version differently or go back to setting through the deploy.
- [ ] The Gateway takes an app's tools on its first `/mcp` use, and again after a redeploy changes the app's `version_id` (the CLI no longer syncs them).
- [ ] The #270 manual test plan end to end: Claude Code, claude.ai, ChatGPT, Cursor, revocation, offboarding, the switches, and the audit query.
- [ ] An app with a cron and a secret of its own (RepoLens with `GITHUB_TOKEN`) deployed through `everyapp deploy`: the cron publishes for an app Worker, and a secret set once survives redeploys.
- [ ] An app with Workflows deployed through `everyapp deploy`: cf creates them under the app's names, a redeploy updates them, they run, `everyapp workflows` starts, lists and controls their instances, `--allow-delete-workflows` deletes a dropped one, and `--purge` deletes them. The read outputs and the missing-Workflow error were checked against the real API; `instances create`, the status changes and `workflows delete` weren't.
- [ ] DataForSEO through the gateway: a live call, a `task_post` then `task_get`, Lighthouse's multi-MB streamed body, and an AI answer that takes over a minute.
- [ ] A helper Worker: `cf deploy --prebuilt --worker <name>` uploads each Worker from one Build Output, and the app's service, Durable Object and Workflow bindings to it resolve.
- [ ] OpenSEO through `everyapp deploy`: `cf deploy` creates its R2 bucket, its cron runs, a site audit runs on the audit Worker (with a Context.dev-rendered page), and SAM answers through OpenRouter.
- [ ] First-party OpenSEO on Postgres: Hyperdrive's origin connection limit under many organizations plus crons and Workflow steps (production uses 30 with caching off), and Better Auth's unique `user.email` when two gateway identities share an email.
- [ ] Google through the gateway, once built: an organization connects, OpenSEO lists the account and reads Search Console and Analytics; an MCP identity without `mcp:write` can POST `searchAnalytics/query` and `:runReport` and nothing else; row writes per 1,000 proxied calls stay at three upserts plus a 10-minute `last_used_at`; `everyapp gateway integrations rewrap` leaves no `integration_org_keys` row on the old key before it is dropped; a Worker with `global_fetch_strictly_public` reaches the gateway-lite on 127.0.0.1 under `cf dev`.

For the CLI redesign (`docs/cli-redesign.md` §5 "Live checks" has the commands and what each outcome decides):

- [ ] With a login that sees several accounts, and with a token scoped to one: the error code `cf d1 list --name every-app-gateway` returns for the out-of-scope account, and per-probe latency. Decides the Gateway-discovery rule and timeout.
- [ ] `.cloudflare/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` matches `localD1Path(root, localD1Id(workerName, 'DB'))`.
- [ ] `cf auth activate <other-profile>` in an app directory, then a deploy: which login it runs under. Decides whether the runner passes `--profile` on every call.
- [ ] An API token with D1 edit only can `cf d1 query` the gateway database. Decides the wording of ADR-0003's "any D1-write token is an operator".
- [ ] Time from a Gateway deploy with a new binding to the first non-503 answer from the app's hostname (certificate included on a new hostname), against the live wait's 120 s timeout.
- [ ] The checkout tree hash (`hashCheckoutTree`) and the source commit time are identical across two clean checkouts of the same commit on two machines, and the tree hash changes on any edit under the Gateway, the SDK, perimeter or toolbus. Decides whether the build cache and `status`'s `upToDate` can be trusted by tree hash. (Two builds of one tree give different release SHA-256s, on one machine already; the CLI doesn't rely on them matching.)
- [ ] Reinstall thecomeup.cc from scratch (nothing adopts or migrates the old install any more): delete the Worker `every-app-gateway`, the D1 database `every-app-gateway`, the KV namespaces `every-app-gateway-OAUTH_KV` and `every-app-gateway-deploy`, and the `*.thecomeup.cc` wildcard DNS record and route; then `pnpm everyapp setup --domain thecomeup.cc` from a terminal and `pnpm everyapp deploy` in each app.

For the hosted platform ([docs/hosted-platform-build.md](docs/hosted-platform-build.md) §7 has the morning ops list: Google, the Cloudflare account and a write token, Workers for Platforms, PlanetScale, Email Sending, the gateway's secrets):

- [ ] Google: the Every App Cloud project and Web client, everyapp.com DNS-verified, the homepage and privacy policy on everyapp.com, the demo video, and brand and scope verification submitted (`webmasters.readonly`, `analytics.readonly`).
- [ ] `pnpm everyapp setup --domain app.everyapp.com --mode hosted` in the chosen account: `status` shows `Mode: hosted`, `sign-in-methods` answers `signUp` and `emailVerification` as configured, and each `<app>.app.everyapp.com` gets its certificate.
- [ ] Verification mail over Cloudflare Email Sending's REST path; the `/verify-email` redirect and one-time sign-in on the real domain and cookie scope.
- [ ] `deploy --shared` for todo, chef and workout, and `register` for OpenSEO, against the hosted install; a shared app opens for members of two organizations; a suspension takes effect within 30 seconds.
- [ ] A cron or Workflow call with `x-everyapp-org` is attributed to its organization (the gateway's `ai.proxy.request` and `integration.proxy.call` log lines name it).
- [ ] Workers for Platforms: the `DISPATCHER` binding with the gateway's `Outbound` entrypoint as the namespace's outbound Worker (a named entrypoint of the gateway Worker, not its own script), outbound parameters reaching it, the "Worker not found" wording, dispatch limits, and props on an upload-time service binding from a namespaced script.
- [ ] Before setting `THIRD_PARTY_DEPLOYS=on` (the account has no dispatch namespace today): a namespaced Worker binds `every-app-gateway`'s `AppGateway` with props; `GET /bindings` echoes props and bindings in the shape the deployer sent (otherwise the read-back deletes every upload); Durable Object migrations and the assets upload session work for namespaced scripts; real `cf build` output passes the deploy API's bundle checks; a deploy through `everyapp deploy --gateway` with `EVERYAPP_TOKEN` end to end.
- [ ] The REST client's unverified shapes: the delete-by-tag response (envelope or not), the codes for a missing or duplicate namespace, tag filters containing colons, boolean D1 parameters.
- [ ] Hyperdrive: `cf hyperdrive create --body @file` output and duplicate-name wording, `hyperdrive list` pagination, a deploy with `placement.region` and `limits.cpuMs`, and `cf dev` with a Hyperdrive binding.
- [ ] PlanetScale: `POSTGRES_DATABASE_URL=<url> pnpm db:migrate:pg` for the first-party OpenSEO (never without the variable: it falls back to `.env.local`), and OpenSEO's organization and member upserts on Postgres.
- [ ] OpenSEO's stage: `PATCH /workers/scripts/:name/settings` accepts props on a service binding, and `inherit` keeps the Durable Object, Workflow, assets, Hyperdrive, rate-limit and version-metadata bindings; the first deploy runs with `--dry-run`.
- [ ] SAM's WebSocket (`/agents/*`) through the gateway with the identity header, and its reconnect at 15 minutes resuming a streaming reply (open-seo #990).
- [ ] `wrangler d1 execute every-app-gateway --remote` finds the gateway's database by name in the hosted account (open-seo #990's runbook reads the identity key with it).
- [ ] A Vite build with a helper Worker: where the auxiliary Worker lands under `.cloudflare/output/v0/workers`, and its name.
- [ ] Cookie-tossing variants against real hosts.
- [ ] #314's handoff in real browsers: `__Host-` cookies, `SameSite=Lax` on the 303 back to the app host, the CSP's `form-action` on the redirect after the POST, and Safari.
- [ ] `everyapp.dev`: the zone, a proxied wildcard DNS record and the Workers route `*.everyapp.dev/*`, provisioned by hand; whether `everyapp setup` or a gateway redeploy keeps that route.
