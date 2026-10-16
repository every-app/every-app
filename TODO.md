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
- [ ] **Wildcard DNS.** A wildcard record that covers a new app hostname only gets a warning, so the thecomeup.cc switch isn't blocked.
- [ ] **RepoLens badges.** Badges are public even for private repos. Keep that, or return 404 for private ones?
- [ ] **RepoLens access.** Deploy it the first time with `--access everyone` if the whole org should see it.
- [ ] **RepoLens retry backfill.** Left out of its MCP tools, because it deletes fetched history.
- [ ] **TanStack Start 1.169.** The platform's apps are pinned to Start 1.168.61, because 1.169 needs Vite 8. RepoLens already runs 1.169 on Vite 8, so the upgrade looks safe.
- [ ] **Gateway UI scope.** Only the gateway moved to OpenSEO's shadcn design system. The todo app, Chef, the workout tracker, the simple-todo template and the landing page still use daisyUI or their own styles.
- [ ] **Gateway look.** Every App's metallic primary buttons and neutral accents, on OpenSEO's surfaces. Dark mode uses OpenSEO's dark greys, with a lighter metallic so the buttons stand out on them. Check the dark-mode buttons.
- [x] **Gateway layout.** A sidebar (OpenSEO's app shell) replaces the top header and the admin tabs. Admin pages now open on phones too, where the old UI showed "not supported on mobile".
- [ ] **When the schema check runs.** `deploy` checks an app's drizzle migrations against its schema after the build, so under the app's lease: the build needs resources created under the lease, and the check needs the dependencies the deploy installs. The redesign's step 7 asked for it before the lease as well.
- [ ] **A schema check drizzle-kit can't finish.** When `drizzle-kit generate` fails (most often a renamed column, which it asks about only at a terminal), the deploy stops with `SCHEMA_CHECK_FAILED`. Only a missing drizzle-kit or drizzle config is a warning.

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
- [ ] A Custom Domain and a route deployed together, and the certificate wait. How they interact with the route the wrangler-era deploy left on thecomeup.cc.
- [ ] The shape and order of `cf workers deployments list`, and who a `cf deploy` is attributed to. A cf deploy must not trigger the "edited in the dashboard" abort on the next deploy; a real dashboard edit must.
- [ ] Release cache: a `cf kv` put and get of the ~6.6 MiB base64 tarball comes back byte for byte, and `kv keys list` has the expected shape.
- [ ] Source map size limits and Issues symbolication. Logs and traces show up in the dashboard.
- [ ] Rate limit namespace ids 4180 and 4181 don't collide with others in the account, and the limits behave in production.
- [ ] `cf workers delete <name>`, and the D1 and KV deletes behind `--purge`.
- [ ] Redeploying an app with Durable Objects from before cf (UserSyncDO) keeps its data, now that `exports` replaces wrangler's `v1` migration tag.
- [ ] How long `/api/deploy/status` takes to show a new version, compared with the verify timeout.
- [ ] The gateway's hourly cron (`17 * * * *`) publishes with the Custom Domains in one `cf deploy`, survives later deploys and reconciles, and logs `mcp.maintenance` at :17.
- [ ] With `global_fetch_strictly_public` on the deployed gateway, claude.ai connects through CIMD (consent shows "Published by claude.ai"), not dynamic client registration.
- [ ] `everyapp gateway secret set MCP_OAUTH_ENABLED` (and `MCP_DCR_ENABLED`) redeploys the live release, the switch takes effect, and the secret survives the next `gateway upgrade`.
- [ ] An app deploy syncs its tools right after activation (no `TOOLS_SYNC_DEFERRED` in the common case), and `gateway deploy` syncs every active app in the token's organization.
- [ ] The #270 manual test plan end to end: Claude Code, claude.ai, ChatGPT, Cursor, revocation, offboarding, the switches, and the audit query.
- [ ] An app with a cron and an app secret (RepoLens with `GITHUB_TOKEN`) deployed through `everyapp app deploy`: the cron publishes for an app Worker, and a secret set once survives redeploys.
- [ ] An app with Workflows deployed through `everyapp app deploy`: cf creates them under the app's names, a redeploy updates them, they run, `everyapp app workflows` starts, lists and controls their instances, `--allow-delete-workflows` deletes a dropped one, and `--purge` deletes them. The read outputs and the missing-Workflow error were checked against the real API; `instances create`, the status changes and `workflows delete` weren't.

For the CLI redesign (`docs/cli-redesign.md` §5 "Live checks" has the commands and what each outcome decides):

- [ ] With a login that sees several accounts, and with a token scoped to one: the error code `cf d1 list --name every-app-gateway` returns for the out-of-scope account, and per-probe latency. Decides the Gateway-discovery rule and timeout.
- [ ] `.cloudflare/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` matches `localD1Path(root, localD1Id(workerName, 'DB'))`.
- [ ] `cf auth activate <other-profile>` in an app directory, then a deploy: which login it runs under. Decides whether the runner passes `--profile` on every call.
- [ ] An API token with D1 edit only can `cf d1 query` the gateway database. Decides the wording of ADR-0003's "any D1-write token is an operator".
- [ ] Time from a Gateway deploy with a new binding to the first non-503 answer from the app's hostname (certificate included on a new hostname), against the live wait's 120 s timeout.
- [ ] `hashReleaseTree` is identical across two clean checkouts of the same commit on two machines, and changes on any edit under the Gateway, the SDK or perimeter. Decides whether the build cache can be trusted by tree hash.
