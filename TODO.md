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
- [ ] **RepoLens access.** Deploy it the first time with `--access everyone` if the whole org should see it.
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
- [ ] **`--no-wait-cert` skips the whole live wait.** The app then goes live on its first visit. Rename it with the flat command tree (`--no-wait`?).
- [ ] **The live wait's outcomes.** No certificate after 10 minutes is a warning and exit 0 (as the certificate wait was); the Gateway answering for 10 minutes without activating the app is `APP_NOT_LIVE` (exit 1, retryable).
- [ ] **No SDK or CLI version check on app deploys.** `minSdk` and `minCli` came from `/api/deploy/whoami`. The redesign's "a checkout older than the live Gateway refuses" (step 3) may be enough; else read the checkout's build constants.
- [ ] **Status reads certificates from Cloudflare's certificate packs** (active, exact host or one-label wildcard). A hostname covered only by Universal SSL could read as "no certificate yet".
- [ ] **The release-identity probe went with `/api/deploy/status`.** An upgrade that stopped before recording itself is no longer recognized as newer: `deploy`/`upgrade`/`reconcile` stop unattended and ask at a terminal. Step 3's install row written before the upload closes that window. Since step 3 the install row is the only truth: a reconcile with the live release no longer checks which version the Worker serves (only cf's strict mode stops it over a dashboard edit).
- [ ] **Setup's reachability check only warns.** A Gateway that doesn't answer over HTTPS yet, or answers with Cloudflare Access's sign-in, is a warning before the owner link, and setup waits for the claim all the same.
- [ ] **App commands find the account without `--account-id`.** Since step 3: Gateway discovery through every account the login sees; one Gateway is the one, several need `--account-id`, `CLOUDFLARE_ACCOUNT_ID`, the named host or a prompt.
- [ ] **`--gateway` picks among several Gateways.** When the login sees several, the host `--gateway` (or `setup --domain`) names picks the one install with that host before anything asks; it is still `GATEWAY_URL_MISMATCH` when it names none.
- [ ] **Several Gateways, unattended: `choose_account`.** A new `action_required` action (exit 2) with `data.choices` (account, name, Gateway URL, and each one's rerun with `--account-id`); its `data.rerun` is a template (`… --account-id <account-id>`).
- [ ] **`CLOUDFLARE_ACCOUNT_ID` counts like `--account-id`.** Naming an account without a Gateway is `GATEWAY_NOT_FOUND` for app commands (saying where the Gateway is), not ignored; for `setup` and `gateway deploy` it is where to install a new one.
- [ ] **Tokens that list no accounts.** An `--account-id` or `CLOUDFLARE_ACCOUNT_ID` that `cf auth whoami` doesn't list is probed anyway, for API tokens without account read access.
- [ ] **Errors while probing an account.** `auth` and `not_found` (also when reading the install row) mean "no Gateway here"; any other failure (network, timeout) stops the command rather than calling the account empty. No probe timeout beyond the runner's 2 minutes yet (live check below).
- [ ] **`gateway status` with no Gateway fails.** It stops with `GATEWAY_NOT_FOUND` (exit 1) like every other command, instead of a `done` with `deployed: false`; a database without an install row is still a `done` with `installed: false`.
- [ ] **Device login under `--json` everywhere the connect path runs.** `app deploy` (and `app secret set`, `app create --deploy`), `app delete` and every `gateway` subcommand with `--json` wait for cf's device login; `app d1 query` and `app workflows` still stop with exit 2.
- [ ] **What the build cache hashes.** Every file `git ls-files --cached --others --exclude-standard` lists under `apps/every-app-gateway`, `packages/sdk`, `packages/perimeter`, `packages/toolbus` and `pnpm-workspace.yaml`, as on disk (ignored files such as `.env*` never count). Without git there is no cache: every deploy builds.
- [ ] **The build cache keeps three builds**, the most recently used, under `node_modules/.cache/everyapp/<tree>.tar.gz`.
- [ ] **Releases ordered by commit time.** The downgrade guard orders by newest migration, then the last commit touching the Gateway's sources (`git log -1` over the hashed paths), not build time, which an old checkout or a cache hit gets wrong. The install row keeps it as `release_committed_at`, with `source_tree_sha256`. A dirty tree orders as its base commit; without git, as now.
- [ ] **Same version, different commits, in the refusal.** `DOWNGRADE_REFUSED` names versions, and adds each side's source commit date when the versions are equal (`0.2.0 of 2026-10-12`).
- [ ] **App deploys and deletes refuse an older checkout even without a rebind.** Checked before the registry is touched, with no override; only `setup --allow-downgrade` rolls the Gateway back.
- [ ] **A rebind with the live release skips migrations and the replace check**; one with a newer release (the checkout moved on) migrates first, as an upgrade.
- [ ] **The tree hash is the Gateway's identity, not the release SHA-256.** Builds aren't reproducible (checked locally: two builds of one tree name their client chunks differently), so another machine at the same commit builds another SHA-256. "The live Gateway" means the same SHA-256 or the same source tree everywhere: `status`'s `upToDate`, `setup`'s and `gateway upgrade`'s nothing-to-do, the downgrade guard, and a rebind that skips migrations.
- [ ] **Status's checkout fixes.** `GATEWAY_OUTDATED` (sources changed since the live build) runs `everyapp setup`; `CHECKOUT_BEHIND` runs `git pull`. `upToDate` is `null` when either tree hash is unknown.
- [ ] **The install row before the first upload** names the release being installed, with `live_version_id`, `live_domains` and `jwt_public_key` empty; app commands refuse it (`GATEWAY_NOT_INSTALLED`, run `setup`) and `status` says `GATEWAY_NOT_UPLOADED`.
- [ ] **`lib/interrupt.ts` kept whole.** Its upload record on Ctrl+C keeps the install row naming the live version (the downgrade guard, `status` and the replace check read it), and freeing the lease spares the rerun a wait of up to 3 minutes; the redesign expected both to go.

## Build

- [ ] **CLI redesign**, decided 2026-10-15 (`docs/cli-redesign.md` §6), in the order of §5: calm output and pure `--json`; the registry written through D1 with no deploy API, deploy tokens or `login` (ADR-0003 first); the Gateway built from the checkout and found through the account; dev without files; the flat command tree; one routing mode and one naming scheme; the 3-minute lease and the schema-drift check. First, and in an hour: squash the Gateway's and the apps' migration histories to one generated file each, regenerated rather than appended while nothing live exists. No backwards compatibility: thecomeup.cc is reinstalled, not adopted.
- [ ] Approvals by browser link, then show destructive tools again.
- [ ] An "Agent activity" page over the `mcp_tool_calls` audit table.
- [ ] Access levels for personal access tokens.
- [ ] `everyapp access enable` (was `gateway access enable`), to set up the Cloudflare Access application from the CLI.
- [ ] `everyapp secret unset` (was `app secret delete`).
- [ ] Owner recovery link and ownership transfer.
- [ ] `everyapp setup --owner-email`.
- [ ] `everyapp setup --target local`.
- [ ] AI Gateway routing.
- [ ] Metered billing at the gateway (deferred).
- [ ] OAuth: refuse app hosts outside the gateway's base domain. Only theoretical today, because the deploy already forces them to match.
- [ ] A CI step that compiles the docs site.
- [ ] `SCHEMA_DRIFT` gets `rerun: "pnpm db:generate"`, and `LEASE_HELD`/`LEASE_LOST` the same command again, once errors carry `rerun` (the calm-output step). Their messages say it today.

## Paused while we work from the checkout

- [ ] Publish again: npm for `everyapp` and `@every-app/sdk`, then the public repository sync. `.github/RELEASE.md` lists what pausing removed.
- [ ] The docs site (`landing-page/content/docs`) still describes the published flow: `npx everyapp`, a starter app in `everyapp setup`, and `gitpick` for the examples. Update it when publishing resumes, or point it at the checkout flow until then.

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
- [ ] `cf ssl certificate-packs list` lists each Custom Domain's pack as `active` once issued (what `gateway status` reads).
- [ ] The gateway's hourly cron (`17 * * * *`) publishes with the Custom Domains in one `cf deploy`, survives later deploys and reconciles, and logs `mcp.maintenance` at :17.
- [ ] With `global_fetch_strictly_public` on the deployed gateway, claude.ai connects through CIMD (consent shows "Published by claude.ai"), not dynamic client registration.
- [ ] `everyapp gateway secret set MCP_OAUTH_ENABLED` (and `MCP_DCR_ENABLED`) redeploys the Gateway the checkout builds, the switch takes effect, and the secret survives the next `gateway upgrade`.
- [ ] The Gateway takes an app's tools on its first `/mcp` use, and again after a redeploy changes the app's `version_id` (the CLI no longer syncs them).
- [ ] The #270 manual test plan end to end: Claude Code, claude.ai, ChatGPT, Cursor, revocation, offboarding, the switches, and the audit query.
- [ ] An app with a cron and an app secret (RepoLens with `GITHUB_TOKEN`) deployed through `everyapp app deploy`: the cron publishes for an app Worker, and a secret set once survives redeploys.
- [ ] An app with Workflows deployed through `everyapp app deploy`: cf creates them under the app's names, a redeploy updates them, they run, `everyapp app workflows` starts, lists and controls their instances, `--allow-delete-workflows` deletes a dropped one, and `--purge` deletes them. The read outputs and the missing-Workflow error were checked against the real API; `instances create`, the status changes and `workflows delete` weren't.

For the CLI redesign (`docs/cli-redesign.md` §5 "Live checks" has the commands and what each outcome decides):

- [ ] With a login that sees several accounts, and with a token scoped to one: the error code `cf d1 list --name every-app-gateway` returns for the out-of-scope account, and per-probe latency. Decides the Gateway-discovery rule and timeout.
- [ ] `.cloudflare/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` matches `localD1Path(root, localD1Id(workerName, 'DB'))`.
- [ ] `cf auth activate <other-profile>` in an app directory, then a deploy: which login it runs under. Decides whether the runner passes `--profile` on every call.
- [ ] An API token with D1 edit only can `cf d1 query` the gateway database. Decides the wording of ADR-0003's "any D1-write token is an operator".
- [ ] Time from a Gateway deploy with a new binding to the first non-503 answer from the app's hostname (certificate included on a new hostname), against the live wait's 120 s timeout.
- [ ] The checkout tree hash (`hashCheckoutTree`) and the source commit time are identical across two clean checkouts of the same commit on two machines, and the tree hash changes on any edit under the Gateway, the SDK, perimeter or toolbus. Decides whether the build cache and `status`'s `upToDate` can be trusted by tree hash. (Two builds of one tree give different release SHA-256s, on one machine already; the CLI doesn't rely on them matching.)
