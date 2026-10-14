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
- [ ] **`everyapp app secret set`.** It redeploys the app from the current directory, code and pending migrations included, and asks first. The better design re-uploads only the live version with the new secret.
- [ ] **Setup link expiring mid-wait.** If the owner setup link stops working while `everyapp setup` waits, setup doesn't make a new one.
- [ ] **Wildcard DNS.** A wildcard record that covers a new app hostname only gets a warning, so the thecomeup.cc switch isn't blocked.
- [ ] **`--printSetupLink`.** The flag is camelCase, unlike setup's other flags.
- [ ] **RepoLens badges.** Badges are public even for private repos. Keep that, or return 404 for private ones?
- [ ] **RepoLens access.** Deploy it the first time with `--access everyone` if the whole org should see it.
- [ ] **RepoLens retry backfill.** Left out of its MCP tools, because it deletes fetched history.
- [ ] **TanStack Start 1.169.** The platform's apps are pinned to Start 1.168.61, because 1.169 needs Vite 8. RepoLens already runs 1.169 on Vite 8, so the upgrade looks safe.

## Build

- [ ] Approvals by browser link, then show destructive tools again.
- [ ] An "Agent activity" page over the `mcp_tool_calls` audit table.
- [ ] Access levels for personal access tokens.
- [ ] `everyapp gateway access enable`, to set up the Cloudflare Access application from the CLI.
- [ ] `everyapp app secret delete`.
- [ ] Owner recovery link and ownership transfer.
- [ ] `everyapp setup --owner-email`.
- [ ] `everyapp setup --target local`.
- [ ] AI Gateway routing.
- [ ] Metered billing at the gateway (deferred).
- [ ] OAuth: refuse app hosts outside the gateway's base domain. Only theoretical today, because the deploy already forces them to match.
- [ ] A CI step that compiles the docs site.

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
- [ ] Adopting thecomeup.cc: resources are found by name (`every-app-gateway`, `every-app-gateway-OAUTH_KV`); the migration history copy works on the real database, then migration 0027 runs; the first cf deploy over the wrangler-deployed Worker probably hits the "edited via API" abort, so run it from a terminal; run `gateway upgrade` once before `reconcile`, so a release is cached.
- [ ] The gateway's hourly cron (`17 * * * *`) publishes with the Custom Domains in one `cf deploy`, survives later deploys and reconciles, and logs `mcp.maintenance` at :17.
- [ ] With `global_fetch_strictly_public` on the deployed gateway, claude.ai connects through CIMD (consent shows "Published by claude.ai"), not dynamic client registration.
- [ ] `everyapp gateway secret set MCP_OAUTH_ENABLED` (and `MCP_DCR_ENABLED`) redeploys the live release, the switch takes effect, and the secret survives the next `gateway upgrade`.
- [ ] An app deploy syncs its tools right after activation (no `TOOLS_SYNC_DEFERRED` in the common case), and `gateway deploy` syncs every active app in the token's organization.
- [ ] The #270 manual test plan end to end: Claude Code, claude.ai, ChatGPT, Cursor, revocation, offboarding, the switches, and the audit query.
- [ ] An app with a cron and an app secret (RepoLens with `GITHUB_TOKEN`) deployed through `everyapp app deploy`: the cron publishes for an app Worker, and a secret set once survives redeploys.
