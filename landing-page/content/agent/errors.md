---
title: Error codes
description: "Every code an everyapp command, the Gateway deploy API or everyapp status can report, one line each: what it means and what to do."
---

<!-- The headings are generated from the source by packages/cli/src/docs/errorsPage.ts (`pnpm -C packages/cli docs:update`); the line under each is written here and kept. -->

Codes are stable; messages are for people and say more. An entry's anchor is its code in lowercase (`/docs/agent/errors#deploy_failed`). Suggested commands are written `everyapp …`; a real message uses the invocation that started it (`pnpm everyapp` in a checkout). When a line isn't enough, read the message, then the source that raises the code.

## Errors and warnings

An `error` event ends the run, with `code`, `message`, `retryable` and in `data` maybe `fix` (a remedy in words), `rerun` (the command to run next, `rerunNote` after it) and `authorize: true` (ask the person before running the rerun: it adds a takeover flag). A `warning` event is something the run went on past. [The protocol](/docs/agent/json)

### ACCESS_APP_OUTSIDE_BASE
An app's hostname isn't under the apps' domain, so Access doesn't cover it.
### ACCESS_HOSTED
A hosted Gateway ignores the Access settings, so `access on|off` has nothing to do. `access show` still works.
### ACCESS_IN_FRONT
Cloudflare Access answered instead of the Gateway; whoever opens the link signs in to Access first. Expected behind Access.
### ACCESS_NOBODY_ALLOWED
Nobody has claimed the Gateway yet, and Access lets in only its members and invitees, so nobody could open the setup link. Claim the Gateway first, then run `everyapp access on`.
### ACCESS_PERMISSION_MISSING
The Cloudflare login can't manage Access. Use a login or token with Access: Apps and Policies (edit) and Access: Organizations, Identity Providers, and Groups (edit).
### ACCESS_ROUTE_NOT_EXPRESSIBLE
A public route has no Access path form, so it stays behind Access.
### ACCESS_SETUP_FAILED
Turning Access on during setup failed. Fix the cause, then run `everyapp setup` again (`--no-access` leaves it off; not recommended).
### ACCESS_SETUP_SKIPPED
`setup` left Access off on purpose (`--no-access`, or no owner yet). `everyapp access on` turns it on.
### ACCESS_TEAM_CREATE_FAILED
Cloudflare didn't create the Zero Trust team; team names are global. Pick another with `--team`.
### ACCESS_TEAM_INVALID
`--team` isn't a valid team name: 1-63 lowercase letters, digits and dashes.
### ACCESS_TEAM_REQUIRED
The account has no Zero Trust team and nobody can be asked for a name. Ask the person, then add `--team <name>` (the sign-in page becomes `<name>.cloudflareaccess.com` for good).
### ACCESS_TOO_MANY_PUBLIC_ROUTES
More public paths on one host than Access takes; the rest stay behind Access.
### ACCESS_UPDATE_FAILED
Warning: a `deploy`, `delete` or `update` couldn't bring Cloudflare Access up to date (often a login that can't edit Zero Trust). The command itself succeeded; `data.cause` is the error's code. Run `everyapp access on`.
### ACCOUNT_NOT_ACCESSIBLE
`--account-id` (or `CLOUDFLARE_ACCOUNT_ID`) isn't an account this login can use. Pass one the message lists, or `everyapp login` as someone else.
### ACCOUNT_REQUIRED
The login lists no accounts (an API token can). Pass `--account-id` or set `CLOUDFLARE_ACCOUNT_ID`.
### AI_DEFAULT_INVALID
`ai default` was given something that isn't a provider, `<provider>/<model>`, or a valid model id. Pick a provider `everyapp ai show` lists. Nothing was written.
### AI_GATEWAY_ID_INVALID
`ai gateway on --id` isn't a name Cloudflare takes: lowercase letters, digits and single hyphens, at most 64.
### APP_CHANGING
The app's registry row kept changing while the deploy recorded its upload (another run). Retryable.
### APP_DIR_EXISTS
The directory for the new app exists. Pick another name or move it away.
### APP_DIR_IN_CHECKOUT
`create` was given a path inside the EveryApp checkout but outside `apps/`. Use `apps/<name>` or `../<name>`.
### APP_DISABLED
The app is switched off in Admin → Apps; the Gateway serves it once turned on.
### APP_HOST_OUTSIDE_BASE
The app's hostname isn't one label below the app base domain, so it isn't published.
### APP_ID_RENAMED
That id is a previous id of an app that was renamed, and stays that app's (its Worker is named after it). Pick another id, or list it under `previousIds` in the renamed app's config. [Renaming an app](/docs/agent/deploy#renaming-an-app)
### APP_ID_REQUIRED
`create` got no name and can't ask (`--json`, `--yes` or no terminal). Run `everyapp create <name>`.
### APP_NEEDS_SETUP
Deployed, but a required setting is unset, so the app shows Needs setup. Run `everyapp configure <app>`.
### APP_NOT_BOUND
The Gateway can't bind the app's Worker. `everyapp status` says what to do.
### APP_NOT_FOUND
The Gateway has no app (or MCP app) with that id: never deployed, deleted, or a typo. Deploy it first, or check `everyapp status` / `everyapp mcp list`.
### APP_NOT_LIVE
The deploy uploaded, but the Gateway couldn't reach the app within the wait. Run `everyapp status`, then deploy again.
### APP_NOT_REGISTERED
The app row has no Worker or hostname yet. Deploy again.
### APP_POLICY
The app's built Worker breaks the app policy (the message lists each problem). Build it with `everyAppWorker()` in `cloudflare.config.ts` and fix what is listed. [deploy](/docs/agent/deploy)
### APP_SCOPE_MISMATCH
The app id is a shared app here, or the reverse. Give the app an id of its own.
### APP_TIER_MISMATCH
The app id is taken on another tier (an MCP app, a hosted app). Give the app an id of its own.
### APP_WORKER_MISSING
The app's Worker no longer exists. Deploy it again, or `everyapp delete <app>`.
### BUILD_FAILED
The app's production build failed. Fix the error in the output (or the log it names); `--verbose` streams the build.
### CANCELLED
The person declined a prompt or pressed Ctrl-C. Nothing changed.
### CAPABILITY_NOT_IN_CATALOG
`dev` can't ask the Gateway about a capability outside the catalog; it runs with the id as given.
### CAPABILITY_UNKNOWN
The manifest lists a capability the catalog and this Gateway don't know. Fix the id in `everyapp.config.ts`, or register it with `everyapp provider add <spec>`.
### CERT_CLEANUP_FAILED
The deleted app's certificate couldn't be removed. Harmless; it expires.
### CERT_PENDING
The certificate hasn't come yet; usually minutes. `everyapp status` shows when it's ready.
### CF_ABORTED
cf asked a question nobody could answer and stopped. Run it in a terminal.
### CF_ACCESS_NOT_ENABLED
The account never opened Zero Trust. Run `access on` again; if it repeats, open Zero Trust once in the dashboard.
### CF_ALREADY_EXISTS
A resource with that name exists already.
### CF_AUTH
Cloudflare refused the login or token. Give it the permission cf names, or `everyapp login`.
### CF_D1_ID_REJECTED
cf wanted a D1 id and got a name. A CLI bug; report it.
### CF_EMAIL_UNVERIFIED
The Cloudflare account's email isn't verified. Verify it at `data.url`, then retry.
### CF_FREE_PLAN
The account is on the Free plan. Subscribe to Workers Paid.
### CF_NOT_FOUND
Cloudflare has no such resource (a Worker, database, namespace).
### CF_OUTPUT
cf printed something other than the JSON expected. Update everyapp; report it if it repeats.
### CF_QUEUE_CONSUMER_WORKER
The Worker consumes a queue. Remove it from the queue's consumers first.
### CF_QUEUE_IN_USE
A Worker still binds the queue. Remove the binding first.
### CF_R2_NOT_ENABLED
R2 isn't enabled on the account. Enable it in the dashboard.
### CF_STRICT_CONFLICT
The Worker was changed outside everyapp, and cf won't overwrite it unattended (`rerun_interactive`).
### CF_SUBDOMAIN_MISSING
The account has no workers.dev subdomain. Register one in the dashboard.
### CF_TIMEOUT
A cf call ran past its time limit. Retryable.
### CF_UNKNOWN
cf failed for a reason not recognized. The message is cf's; `--verbose` shows its output.
### CF_VERSION_DIFFERS
The app's `cf` version isn't the one everyapp is tested with.
### CHECKOUT_UNCOMMITTED
From a checkout of the Every App repository, `update` (or `setup` over a live Gateway) found uncommitted changes in the Gateway's sources, so nothing changed: it deploys the checkout as it is on disk, and a migration it applies can't be taken back. Commit or stash them. `data.rerun` adds `--unmerged` (`data.authorize`: ask first) to deploy it anyway.
### CHECKOUT_UNMERGED
From a checkout, `update` (or `setup` over a live Gateway) is at a commit (`data.commit`) that isn't on the remote's main branch (`data.notOn`, usually `origin/main`): a branch, or commits not pushed. Nothing changed. Switch to the main branch and `git pull`, or merge the commit first. On a fork or a branch you deploy on purpose, `data.rerun` adds `--unmerged` (`data.authorize`: ask first).
### CLOUDFLARE_LOGIN_FAILED
cf's login didn't complete. Run `everyapp login` again, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
### CLOUDFLARE_TOKEN_REJECTED
Cloudflare refused `CLOUDFLARE_API_TOKEN`. Set a valid token, or unset it and `everyapp login`.
### COMMAND_FAILED
The command failed to load or run outside the normal reporting. Read `--help`; report it if it repeats.
### CONFIRMATION_REQUIRED
A step needs a yes and nobody could answer. Ask the person; if they agree, run the `rerun` (it adds `--yes`). `--yes` never approves bundled providers: that's `--register-providers`.
### CUSTOM_DOMAIN_OWNER_UNCHECKED
Which Worker holds a Custom Domain couldn't be read unattended; the deploy went on.
### D1_NOT_FOUND
The app has no production D1 database for that binding yet. Deploy it first.
### DATABASE_URL_INVALID
A database URL in `.everyapp/secrets.env` doesn't parse. Write it as `postgres://<user>:<password>@<host>:<port>/<database>`.
### DEPLOY_NOT_UPLOADED
cf finished without uploading a new version (someone answered no to its prompt). Deploy again.
### DEPLOY_TOKEN_HOSTED
A hosted Gateway's deploy token isn't changed with `deploy-token`.
### DEV_EXPOSED
`dev` listens beyond this machine: anyone who reaches the port is the dev user.
### DEV_PORT_IN_USE
`dev`'s port is taken. The `rerun` uses the next free port (`data.free`).
### DEV_PORT_UNAVAILABLE
`dev` can't listen on that host and port. Pass another `--port` or `--host`.
### DEV_REQUEST_FAILED
A request failed in the local Gateway (answered 502).
### DEV_SERVER_FAILED
The app's dev server exited before it was ready. Read its output above the error.
### DEV_SERVER_TIMEOUT
The app's dev server didn't listen within 90 seconds. Make it listen on the port in `PORT` (`server.port` in `vite.config.ts`).
### DEV_WRONG_HOST
A request for another host was refused (421).
### DNS_RECORD_CONFLICT
A DNS record already answers a hostname to publish. Delete it (Cloudflare → DNS) or pick another name; the `rerun` adds `--force-dns`, which replaces it: ask first.
### DNS_RECORD_REPLACED
`--force-dns` replaced the DNS records at a new hostname.
### DNS_UNREADABLE
The login can't read the zone's DNS records. Give the token Zone → DNS → Read; the `rerun` adds `--force-dns`: ask first.
### DOCS_PAGE_NOT_FOUND
`everyapp docs <page>` names no page, on the site or in the bundled copy. `everyapp docs` lists them; a setup guide is `setup/<name>`.
### DOMAIN_CHANGE_UNSUPPORTED
The Gateway can't move to another address. Rerun without `--domain`; to move, remove everything and set up again.
### DOMAIN_REQUIRED
`setup` needs an address and nobody can be asked. Ask the person; the `rerun` or `choices` carry `--domain apps.<zone>`.
### DRIZZLE_KIT_MISSING
Postgres migrations need `drizzle-kit` in the app's devDependencies.
### DURABLE_OBJECT_MOVED
A Durable Object class can't move to another Worker. Give the class a new name.
### DURABLE_OBJECT_REMOVED
`everyapp.config.ts` dropped a Durable Object class, so deploying deletes its data. Declare it again, or, after asking, rerun with `--allow-delete-durable-object-data`.
### EMAIL_ADDRESS_TAKEN
An inbound address belongs to another app or Email Routing rule; addresses are never taken over. Pick another.
### EMAIL_CATCH_ALL_NOT_APEX
A catch-all `*@<domain>` only works on a zone's apex. List each address instead.
### EMAIL_CATCH_ALL_TAKEN
The zone's catch-all already sends mail somewhere. Set it back to Drop in Email Routing, or list addresses one by one.
### EMAIL_INBOUND_INVALID
An `--inbound` address is invalid (the message says why). When lowercasing fixes it, the `rerun` does that.
### EMAIL_INBOUND_NOT_DECLARED
The app doesn't declare `email: { inbound: true }` and export `email()`. Add both, deploy, then run this again.
### EMAIL_INBOUND_UNDECLARED
Inbound addresses are stored but the app doesn't declare inbound mail. Declare `email: { inbound: true }` and deploy, or `everyapp email unset inbound`.
### EMAIL_MX_ELSEWHERE
An inbound domain already gets its mail somewhere else (its MX records point at Google Workspace or another provider), and turning Email Routing on would replace them: that mail would stop arriving there. Receive on a subdomain without mail of its own instead; rerun with `--replace-mx` only if the person said that mail should move to Cloudflare. `--enable-email-routing` alone doesn't.
### EMAIL_NOTHING_TO_SET
`email set` needs `--sender`, `--inbound`, or both.
### EMAIL_NOT_DECLARED
The app doesn't declare `capabilities: { email: { access: "write" } }`. Add it, deploy, then run this again.
### EMAIL_ROUTES_PARTIAL
The inbound list was saved but routing stopped part-way. Retryable; `everyapp deploy` also finishes it.
### EMAIL_ROUTING_DISABLED
Email Routing is off for an inbound address's domain. Turning it on locks the domain's MX and SPF to Cloudflare: ask, then rerun with `--enable-email-routing`.
### EMAIL_SENDERS_HOSTED
A hosted Gateway sends app mail from its own sender; `--sender` isn't taken there. `--inbound` still works.
### EMAIL_SENDER_INVALID
A `--sender` pattern is invalid (the message says why). When lowercasing fixes it, the `rerun` does that.
### EMAIL_ZONE_NOT_FOUND
An inbound address's domain isn't a zone in this Cloudflare account. Add the domain, or use another.
### EVENT_SINK_CONFLICT
`events add` got a URL and `--email` together, or `--email` with a signing secret. A subscription delivers one way; only a webhook is signed.
### EVENT_TARGET_REQUIRED
`events add` named neither a webhook URL nor `--email`. Add one: `events add https://hooks.example.com/everyapp` or `events add --email admins`.
### FEATURE_INCOMPLETE
An optional feature is half set up: it never blocks the app but doesn't work. Run `everyapp configure <app>` to finish it, or unset its values.
### GATEWAY_AMBIGUOUS
This machine is signed in to several Gateways and the command didn't say which (`data.gateways` lists them). Pass `--gateway <url>` or set `EVERYAPP_GATEWAY_URL`.
### GATEWAY_AT_ZONE_APEX
The Gateway is at a zone's apex, so its cookie covers every subdomain. Prefer `apps.<zone>`.
### GATEWAY_BUILD_FAILED
Building the Gateway from this checkout failed. Fix the build error (often `pnpm install` after a `git pull`), then run it again.
### GATEWAY_CHECK_FAILED
Discovery couldn't tell whether a Gateway exists, so nothing changed. Retry; if it repeats, check the login can read D1 in that account.
### GATEWAY_DOWNGRADE
`setup` or `update` would replace the live Gateway with an older one, so nothing changed. To go forward instead, update everyapp (in a checkout, `git pull`) and run `everyapp update`. To roll back on purpose, `data.rerun` adds `--downgrade` (`data.authorize`: ask first): the older code goes back and the database keeps its migrations. `data.schemaAhead` says whether the database has migrations the older Gateway doesn't know; `everyapp db restore --gateway` puts the database back to before its last migrating update, and loses what was written since. With `--downgrade` it is a warning and the deploy goes ahead.
### GATEWAY_NOT_FOUND
No Gateway in any account this login sees (`data.accounts`). Log in to the right account, pass `--account-id`, or `everyapp setup`.
### GATEWAY_NOT_INSTALLED
The Gateway's database exists but its install never finished. Run `everyapp setup`; it resumes.
### GATEWAY_OUTDATED
The Gateway's database lacks the newest Gateway migration this everyapp was built with (`data.needs`), so commands that connect to it refuse until it catches up. Run `everyapp update`, then this again; `data.gatewayUrl` and `data.accountId` say which Gateway. A person at a terminal is asked "Update it now?" instead, and on Yes the update runs and the command starts again. Nobody is asked under `--json`, without a terminal, in CI or with `--yes`: a script never updates a Gateway it didn't name.
### GATEWAY_REFUSED
The Gateway refused the admin command's credential (401/403), or `/mcp` redirected (Access in front, or not the Gateway's URL). Make a new personal access token, or `everyapp login --gateway <url>` again (`data.fix`).
### GATEWAY_RELEASE_LATEST
No Gateway release for this everyapp version; the latest one was used. If it is older than this everyapp, other commands refuse it (`GATEWAY_OUTDATED`) until a newer one is deployed.
### GATEWAY_RELEASE_UNAVAILABLE
The live Gateway's release isn't available to rebind. Run `everyapp update`, then this again. A rename is refused with it before anything is written (`data.rename` has `from`); an app that an earlier everyapp renamed without publishing its new hostname gets it with `data.rename.previousHostnames`: the old hostname still serves the app, and `everyapp update`, then the deploy again, finishes the rename.
### GATEWAY_TOOL_ERROR
The Gateway's tool refused the call; the headline is its message and `data.code` its code (`LAST_OWNER`, `GROUP_NOT_FOUND`, `INVALID_INPUT`, …). A tool the credential can't see answers as unknown: sign in with read & write and all apps. `everyapp call --list` shows what it may call.
### GATEWAY_UNREACHABLE
The Gateway didn't answer yet; the owner link works once it does.
### GATEWAY_UPDATED
An `update` made a newer Gateway live while this command waited for the lease; nothing changed. Run the same command again (retryable).
### GATEWAY_URL_MISMATCH
`--gateway` or `EVERYAPP_GATEWAY_URL` names a different host than the Gateway's own. Rerun without it, or fix the variable.
### GITHUB_RUN_MISSING
`release --publish` runs only in GitHub Actions (it needs `GITHUB_REPOSITORY`, `GITHUB_SHA` and a token).
### GIT_FAILED
`create` couldn't make the first git commit; the app was created anyway. Set git's `user.name` and `user.email`, then commit.
### HELPER_DURABLE_OBJECT_REMOVED
A helper Worker's Durable Object class was dropped from `everyapp.config.ts`. Keep declaring it.
### HELPER_WORKER_KEPT
A helper Worker the manifest dropped keeps running. Delete it in the dashboard if unwanted.
### HOSTNAME_TAKEN
Another app on this Gateway has that hostname. Pick another app id.
### HOST_OWNED_BY_OTHER_GATEWAY
The hostname belongs to another Gateway in the account, even with `--force-dns`. Use another.
### HYPERDRIVE_ORIGIN_MISSING
The deploy must create a Hyperdrive config and has no database URL. Set `POSTGRES_DATABASE_URL` (or `<BINDING>_ORIGIN_URL`) in `.everyapp/secrets.env`.
### IDENTITY_KEY_UNKNOWN
The Gateway's install row has no identity public key, so apps can't verify it. Restore `JWT_PUBLIC_KEY` (the key-rotation runbook in `docs/runbooks/key-rotation.md`).
### INSTALL_FAILED
The app's dependency install failed. Read the tail or the log it names; from `create`, the `rerun` is `cd <dir> && pnpm install`.
### INSTALL_INPUTS_MISSING
A Worker binds a resource `everyapp.config.ts` doesn't declare. Declare it under `resources`.
### INSTALL_PLACEHOLDER_LEFT
A build placeholder survived in a Worker's config. Build from `everyAppWorker()` and leave names, keys and ids out of `cloudflare.config.ts`.
### INVALID_APP_BASE_DOMAIN
The Gateway's host and app base domain don't fit together. A CLI bug if it happens; report it.
### INVALID_APP_HOST
An app hostname isn't one label below the app base domain. A CLI bug if it happens; report it.
### INVALID_APP_HOSTNAME
The app id doesn't make a DNS label of at most 63 characters. Pick a shorter id.
### INVALID_APP_ID
Not a valid app id: lowercase letters, digits and single dashes, at most 64. `data.fix` says what to change.
### INVALID_BUILD_OUTPUT
A `worker.config.json` in the Build Output is invalid. Rebuild; if it repeats, report it.
### INVALID_DEV_MODE
`--mode` (or `EVERYAPP_DEV_MODE`) must be `stub` or `mirror`.
### INVALID_DOMAIN
Not a full hostname. Use a name like `apps.example.com`.
### INVALID_GATEWAY_NAME
`setup --name` takes 1-16 lowercase letters or digits, like `demo` or `staging`.
### INVALID_GATEWAY_URL
`--gateway` or `EVERYAPP_GATEWAY_URL` isn't a URL (or, for linked dev, not https). Fix or unset it.
### INVALID_MANIFEST
`everyapp.config.ts` fails the manifest schema. Fix what the message names. [manifest](/docs/agent/manifest)
### INVALID_VALUE
A flag's value isn't valid (exit 252). The message lists what it takes.
### INVALID_WORKER_NAME
The app id makes a Worker name that's too long or reserved. Pick another id.
### INVITATION_NOT_PENDING
No pending invitation matches, or it expired or was used. `everyapp workspace users` lists pending ones; invite again if it expired.
### LEASE_HEARTBEAT
The run couldn't renew its lease; another run may take over.
### LEASE_HELD
Another deploy holds the lease (`data.holder`, and `everyapp status` shows it). Retry once it's done.
### LEASE_LOST
The run lost its lease before a step it can't undo. Retryable.
### LINKED_DEV_GATEWAY_REQUIRED
Linked dev needs `--gateway <https url>`.
### LINKED_DEV_HOST_REFUSED
Linked dev only listens on this machine (`127.0.0.1`, `::1`, `localhost`).
### LINKED_DEV_REFUSED
The Gateway refused linked dev's token for this app: linked dev is off (`everyapp workspace linked-dev on`), or the person isn't an owner or admin, or can't open the app.
### LINKED_DEV_REVOKE_FAILED
The token was forgotten locally, but the Gateway couldn't revoke the grant. Revoke it under Your connections.
### LOCAL_DNS_STALE
The app is live, but this machine's DNS still caches the name as missing. Wait or flush DNS.
### MANIFEST_NOT_FOUND
No `everyapp.config.ts` here. Run the command in the app's directory, or name the app.
### MCP_APP_BUILTIN
A built-in MCP app's tools can't be changed; `everyapp mcp off <id>` stops serving it.
### MCP_APP_ID_MISSING
`mcp refresh` was given no app. Nothing changed; the message and `data.apps` name each MCP app with how its last listing went. Rerun with one id.
### MCP_APP_NO_ACCOUNT
`mcp connect` is for an MCP app that signs in with OAuth. This one takes a key (`data.rerun` sets it), no credential, or its OAuth client isn't set yet.
### MCP_TOOL_CHANGE_INVALID
`mcp tool` needs something to change (`--risk`, `--on` or `--off`), and not `--on` with `--off`.
### MIGRATIONS_FAILED
A local D1 migration failed. Fix the migration file it names, then run it again.
### MIGRATION_FAILED
A production migration failed before the upload, so the serving version keeps running. Fix the migration and deploy again.
### MIRROR_BASE_HOST
`--base-host` needs at least two labels, like `everyapp.localhost`.
### MIRROR_GATEWAY_UNREACHABLE
Mirror mode needs a local Gateway running (`pnpm dev` in `apps/every-app-gateway`) or `--gateway <url>`.
### MIRROR_SESSION
The local Gateway has no session for the browser yet; log in at the URL it gives.
### MISSING_ARGUMENT
A required argument is missing (exit 252). See `data.usage`.
### MISSING_CLOUDFLARE_CONFIG
The app has no `cloudflare.config.ts`. Copy the starter's.
### MISSING_FLAG_VALUE
A flag needs a value, or a required flag is missing (exit 252).
### NESTED_APP
`create` was run inside an app. Run it from the directory that holds your apps.
### NETWORK_ERROR
The network failed. Retryable.
### NODE_TOO_OLD
The project's pinned Node is older than 22.18. Raise the pin (`volta pin node@22`).
### NONSTANDARD_CLOUDFLARE_CONFIG
`cloudflare.config.ts` doesn't use `everyAppWorker()`; the Worker is still checked against the policy.
### NO_D1
The app declares no `resources.d1`. Add one, then deploy.
### NO_RELEASE
The GitHub repository has no release with `everyapp-release.tar.gz`. Clone it and `everyapp deploy` from its directory.
### NO_RESTORE_POINT
No restore point recorded for that database; only a deploy that migrates makes one.
### OAUTH_GATEWAY_UNREACHABLE
The CLI's sign-in to a Gateway (`login --gateway`, an admin command's first run, linked dev) couldn't reach its OAuth metadata. Check the URL and the network, then run again.
### OAUTH_OFF
The Gateway offers no OAuth sign-in for the CLI (usually `MCP_OAUTH_ENABLED` is off there), or the URL isn't an Every App Gateway.
### OAUTH_REGISTRATION_OFF
The Gateway doesn't register new OAuth clients (`MCP_DCR_ENABLED=false`), so the CLI can't sign in there for the first time. [mcp](/docs/agent/mcp)
### OAUTH_SIGNIN_FAILED
The CLI's browser sign-in didn't end in a token: refused, denied (`access_denied`), timed out after 10 minutes, or a refresh was refused (`invalid_grant`). The headline says which; fix it and sign in again.
### ORGANIZATION_NOT_FOUND
No organization with that slug, id or name.
### ORG_KEY_UNAVAILABLE
Every organization key from the slug is taken. An operator assigns one.
### OWNER_NOT_CLAIMED
Nobody has claimed the Gateway and the owner link can't be shown here (`CI`). Hand the person the `rerun` to run in a terminal.
### OWNER_WAIT_NETWORK
The network dropped while `setup` waited for the owner link. The link still works; run `everyapp setup` again.
### PASSWORD_RESET_REQUIRES_ACTIVE_USER
The member is deactivated. `everyapp workspace reactivate <email>` first.
### PIPED_LINE_INVALID
`configure` reads `NAME=value` lines on stdin, one per line. A bare value goes to `everyapp secret set NAME`.
### POSTGRES_URL_MISSING
A Postgres app needs `POSTGRES_DATABASE_URL` in `.everyapp/secrets.env`.
### PREVIOUS_ID_UNKNOWN
`previousIds` of an app that is already registered names an id another app on this Gateway had; a previous id stays the app's that had it. Drop it from `previousIds`. An id no app has or had is no error: it is history, and an app that isn't registered yet is then installed as a new one. [Renaming an app](/docs/agent/deploy#renaming-an-app)
### PRISMA_MISSING
A Prisma app needs `prisma` in its devDependencies.
### PROVIDER_APP_UNKNOWN
That id isn't an MCP app here (`everyapp mcp list`); a server by URL is added with `everyapp mcp add <url>`.
### PROVIDER_BUILTIN
A registered provider can't take a built-in provider's id.
### PROVIDER_BUNDLED_BUILTIN
The app bundles a spec for a built-in provider; the catalog's entry is used.
### PROVIDER_CLIENT_INCOMPLETE
Part of a key or client was given (an OAuth client id without its secret). Give all of it.
### PROVIDER_CONNECTION_NOT_FOUND
No connection to that provider for that person, or none that the app `--app` names may use.
### PROVIDER_CONNECTION_WHICH
`provider disconnect` needs exactly one of `--user <email>` and `--all`.
### PROVIDER_EXISTS
The provider is registered already; the `rerun` adds `--replace`: ask first.
### PROVIDER_HOST_REFUSED
A host in the spec isn't one a key may go to (an IP, `localhost`, a private name).
### PROVIDER_IN_USE
Apps list the provider under `capabilities`. Remove it from them first.
### PROVIDER_KEY_UNSET
The MCP app is on, but its key isn't set, or was set for other hosts. Set it with `everyapp secret set <NAME>`.
### PROVIDER_NOT_FOUND
Not a built-in provider, preset, file or URL, or not registered here (`everyapp provider list`).
### PROVIDER_PRESET_UNKNOWN
`--oauth` takes an OAuth preset or a spec. `everyapp provider presets` shows the presets.
### PROVIDER_SECRET_TAKEN
A setting in the spec isn't the provider's: settings start with the id upper-cased (`STRIPE_` for `stripe`) and can't be another provider's.
### PROVIDER_SPEC_DIFFERS
The app bundles a provider spec that differs from the one registered here. Ask the person; then redeploy with `--register-providers`, or remove the bundled file.
### PROVIDER_SPEC_INVALID
A provider spec the app bundles isn't valid JSON or fails the spec rules (the message lists them).
### QUERY_FAILED
D1 refused the SQL. Fix the SQL.
### QUEUE_HANDLER_MISSING
The new version is live without its queue consumers. Export `queue(batch, env)` beside the fetch handler, then deploy again.
### QUEUE_NAME_INVALID
A queue's name (Worker name, `--`, binding) is too long or invalid. Shorten the binding name.
### R2_NOT_ENABLED
R2 isn't enabled on the account. Enable it once in the dashboard, then rerun.
### RELEASE_CORRUPT
The release's contents don't match its hash. Download it again.
### RELEASE_DOWNLOAD_FAILED
Downloading the release failed. Retryable on timeouts and 5xx.
### RELEASE_INVALID
The tarball isn't a release of the right kind (app vs Gateway), or its `release.json` is invalid.
### RELEASE_LOCAL_STATE
The release would include local state or secrets (`.dev.vars`, `.env*`, `*.pem`). Remove them.
### RELEASE_MIGRATIONS_UNSUPPORTED
Only D1 SQL migrations ship in a release; a Postgres app can't be released yet.
### RELEASE_NOT_FOUND
The release `install` names isn't there (not a URL or file, or a 404).
### RELEASE_PACK_FAILED
`release` couldn't pack the Build Output (the message says why).
### RELEASE_PUBLISH_FAILED
GitHub refused a call during `release --publish`. Retryable on 5xx and 429.
### RELEASE_TOO_LARGE
A release is at most 200 MB.
### RELEASE_UNSUPPORTED
The release uses a Build Output this CLI doesn't deploy. Update everyapp.
### REMOTE_MCP_CREDENTIAL_REJECTED
Warning: `mcp add` checked the key with one `tools/list` and the server refused it. Check the key and where it goes (`--auth`, `--header`, `--param`), then `everyapp secret set <ID>_MCP_TOKEN` again.
### REMOTE_MCP_EXISTS
The id is an MCP app already, for another server (`data.url`). Add this one under its own id with `--name <id>`, or `everyapp mcp remove <id>` first to replace the other. The same server added again is not an error: `mcp add` answers `done` with `data.added` false and where it stands.
### REMOTE_MCP_INVALID
`mcp add` got flags or a server answer a remote MCP app can't use (the message says which). Fix and rerun.
### REMOTE_MCP_NEEDS_CREDENTIAL
The server asks for a credential and nothing said how to give it. Add it with `--auth bearer|header|query|basic|oauth` or `--provider <id>`; `--force` adds it with none.
### REMOTE_MCP_OAUTH_DISCOVERY
The server's OAuth metadata can't be found or isn't usable (no PKCE, not https). If it takes an API key instead, use a static `--auth`.
### REMOTE_MCP_OAUTH_NO_CLIENT
The server's authorization server registers no clients. Register one with the redirect URI the message prints, then add again with `--client-id <id> --client-secret-from-env <VAR>`.
### REMOTE_MCP_PROBE_FAILED
The server didn't answer the probe from this machine; the app was added anyway.
### REMOTE_MCP_PROVIDER_HOST
`--provider`'s hosts don't include the MCP URL's host. Use the server's own `--auth`, or the provider whose host it is.
### REMOTE_MCP_TOOL_NOT_LISTED
The tool isn't in the server's last listing; the override is kept for when it appears.
### REMOTE_MCP_URL_REFUSED
The Gateway won't fetch that MCP URL: it must be public `https://`, not an IP, not on this Gateway, and not a provider's host unless `--provider` names that provider.
### RENAME_AMBIGUOUS
`previousIds` names more than one app on this Gateway; a rename moves one. List only the ids of the app being renamed.
### RENAME_CONFLICT
The app changed (another deploy or a delete) while it was being renamed; nothing was renamed. Run the deploy again.
### RENAME_NOT_MOVED
The new hostname didn't answer during this run, so the old hostname still serves the app in full instead of redirecting. Nothing is broken; deploy again once the new hostname answers to finish the move.
### RENAME_TARGET_EXISTS
The new id is already an app on this Gateway (or a deleted one's, or another app's previous id); two apps can't be merged. Rename to another id, or drop the other app from `previousIds`.
### RENAME_UNSUPPORTED
That app can't be renamed this way: it is deployed through the hosted deploy API (its Worker must carry its id), or the rename would change nothing. The Gateway's own installs (a browser install, the hosted deploy API) also answer it for a manifest whose `previousIds` name an app there: rename it with `everyapp deploy` or `everyapp install` first.
### REPEATED_FLAG
A flag was given twice (exit 252).
### RESERVED_APP_ID
`everyapp` is reserved. Pick another id.
### RESOURCES_KEPT
`delete --purge` kept resources with the app's names that no deploy recorded creating.
### RESOURCE_NAME_CONFLICT
Two bindings would share a resource name. Rename one in `everyapp.config.ts`.
### RESOURCE_NAME_MISSING
The Gateway gave no name for a resource; it predates this CLI. Run `everyapp update`.
### RESOURCE_NAME_TAKEN
A resource with the app's assigned name exists that this app didn't create. Delete or rename it, then rerun.
### RESOURCE_OWNED
Another app already records that resource. Rename the binding.
### RESOURCE_RECREATED
A recorded resource was gone, so the deploy made a new, empty one.
### RESOURCE_REPLACED
A recorded resource was replaced by a different one with the same name. Delete or rename it, then rerun.
### RESTORE_TARGET_TWICE
`db restore` takes an app or `--gateway`, not both.
### SCHEMA_CHECK_FAILED
The schema check (`drizzle-kit generate`) failed. Run `pnpm db:generate` in a terminal; it asks about renames.
### SCHEMA_CHECK_SKIPPED
The schema check couldn't run (no `drizzle-kit`); the deploy went on.
### SCHEMA_DRIFT
The schema has changes no migration covers. Run `pnpm db:generate`, commit the migration, then deploy.
### SDK_VERSION_MISMATCH
Warning: the app's `@every-app/sdk` isn't the version this everyapp pins. Pin both to one version: `pnpm add @every-app/sdk@<version> everyapp@<version>`.
### SECRETS_PARTIALLY_APPLIED
The change reached some Workers and not others. Run the `rerun`, which sets what's left.
### SECRETS_STORE_MISSING
The account has no Secrets Store. Create one once in the dashboard, then rerun.
### SECRETS_STORE_VALUE_MISSING
A Secrets Store secret needs a value. Add `<BINDING>=<value>` to `.everyapp/secrets.env`, then rerun.
### SECRET_EMPTY
The variable `--from-env` names is empty or unset.
### SECRET_NAME_INVALID
A secret name is letters, digits and underscores, starting with a letter.
### SECRET_NAME_RESERVED
The name is reserved (`GATEWAY_URL`, `CF_VERSION_METADATA`, `EVERYAPP_*`, `EVERY_APP_*`, `APP__*`). Pick another.
### SECRET_NOT_DECLARED
The name is neither a Gateway setting nor one the app declares. Declare it in `everyapp.config.ts`, or fix the name. [secrets](/docs/agent/secrets)
### SECRET_NOT_SETTABLE
That Gateway setting isn't set this way: install-owned settings belong to `setup`, dev-only ones go in `.dev.vars`, sign-in settings go through `everyapp signin`.
### SECRET_SEVERAL_NAMES
One value can't set several names. Run it once per name.
### SECRET_VALUE_REQUIRED
No value and no terminal to ask. Use `--from-env <VAR>` or pipe the value; better, have the person run it in a terminal.
### SETTING_VALUE_INVALID
The value doesn't fit the setting (the message says what it takes, like `true` or `false`).
### SHARED_APP_FORBIDDEN
Only an owner or admin of the platform organization may deploy or delete a shared app.
### SHARED_APP_NOT_PLATFORM
Only the platform organization registers shared apps.
### SIGNIN_FLAG_NOT_APPLICABLE
That flag isn't a setting of this provider. `everyapp signin show <id>` lists its settings.
### SIGNIN_ISSUER_INVALID
The OIDC issuer must be an https URL serving `/.well-known/openid-configuration`.
### SIGNIN_TENANT_INVALID
The Microsoft tenant is a GUID, or `common`, `organizations` or `consumers`.
### SIGNIN_UNKNOWN_PROVIDER
Not a sign-in provider (`everyapp signin list`). For another identity provider, use `oidc`.
### SIGNIN_VALUE_REQUIRED
A required setting is missing and there's no terminal. Give the flags the `rerun` shows (secrets with `--client-secret-from-env`).
### SQL_FILE_NOT_FOUND
No file at the `--file` path (`--file -` reads stdin).
### SQL_REQUIRED
`db query` needs SQL as an argument or `--file`.
### SQL_TWICE
Pass the SQL or `--file`, not both.
### SYSTEM_ERROR
A system error (`ENOENT`, `EACCES`); the message names the file or call.
### TEARDOWN_ACCOUNT_FORBIDDEN
That account is on the forbidden list and can never be torn down.
### TEARDOWN_ACCOUNT_NOT_VISIBLE
`CLOUDFLARE_API_TOKEN` doesn't see that account.
### TEARDOWN_ALLOWLIST_IGNORED
An allowlist or forbidden-list entry isn't an account id and was ignored.
### TEARDOWN_CONFIRMATION_REQUIRED
`teardown` needs the account id typed at a terminal, or `--confirm <id>`. Show the plan; run it only if the person agrees.
### TEARDOWN_CONFIRM_MISMATCH
`--confirm` isn't the account id (or the Gateway's Worker name with `--gateway`).
### TEARDOWN_DELETE_FAILED
One resource couldn't be deleted; the rest went on.
### TEARDOWN_GATEWAY_AND_ALL
`--gateway` and `--all` can't go together.
### TEARDOWN_INVALID_ACCOUNT_ID
Not a Cloudflare account id (32 hex characters).
### TEARDOWN_INVALID_GATEWAY
Not a Gateway name (1-16 lowercase letters or digits).
### TEARDOWN_NEEDS_TOKEN
`teardown` needs `CLOUDFLARE_API_TOKEN` for the test account.
### TEARDOWN_NOT_ALLOWLISTED
The account isn't on the teardown allowlist of dedicated test accounts (`EVERYAPP_TEST_ACCOUNTS`).
### TEARDOWN_READ_FAILED
One kind of resource couldn't be listed; anything of that kind stays.
### TEARDOWN_TOKEN_TOO_BROAD
The token sees accounts that aren't test accounts. Mint one for the test account only.
### TIER_POLICY
The manifest asks for something the app's tier doesn't allow. Change `everyapp.config.ts`, then deploy again.
### TOOLS_CATALOG
A problem in the app's tool catalog under `dev`.
### TOO_MANY_ARGUMENTS
More arguments than the command takes (exit 252).
### UNEXPECTED
A bug. The `rerun` adds `--verbose` for a stack trace to report.
### UNKNOWN_COMMAND
No such command (exit 251). Try `data.didYouMean` or `--help`.
### UNKNOWN_D1_BINDING
`--binding` isn't one of the manifest's `resources.d1`.
### UNKNOWN_FLAG
The command has no such flag (exit 252). Try `data.didYouMean` or `--help`.
### UNSAFE_CF_DIRECTORY
The directory everyapp runs cf in (`~/.everyapp/cf`) isn't private to this user. Fix its owner and mode as the message says.
### UNSUPPORTED_RUNTIME
everyapp needs Node 22.18 or newer, not Bun. Install Node 22 or 24.
### UPLOAD_NETWORK_FAILED
The upload failed on the network. Retryable once online.
### UPLOAD_UNRECORDED
cf failed after the upload went live, so it isn't recorded. Deploy again.
### USER_IN_OTHER_ORGANIZATION
The member is in another organization too, and a password is account-wide; they use Forgot password instead.
### USER_NOT_FOUND
Not a member of the organization (`everyapp workspace users`).
### VALUE_ON_COMMAND_LINE
A secret value was typed on the command line, where it lands in shell history. Use the prompt, `--from-env` or stdin, and rotate the value if it was real.
### VECTORIZE_CONFIG_MISMATCH
The recorded Vectorize index has another shape than the manifest declares. Rename the binding for a new index, or change the shape back.
### VECTORIZE_NAME_TOO_LONG
The Vectorize index name is too long. Shorten the binding name.
### VERSION_UNKNOWN
Cloudflare reported no version after the upload. Deploy again.
### WORKERS_PAID_UNVERIFIED
Workers Paid couldn't be confirmed; setup went on.
### WORKER_NAME_MISMATCH
The Worker name given isn't the one the Gateway assigns. Drop `--worker`, or use the expected name.
### WORKER_NAME_TAKEN
A Worker with the app's name exists that this app didn't deploy (or the registry has it for another app). Delete it, or pick another app id.
### WORKER_TYPES_FAILED
Worker types couldn't be generated; `pnpm dev` tries again.
### WORKFLOW_NAME_TAKEN
A Workflow with the app's name for that binding exists already. Delete or rename it, then rerun.
### WORKFLOW_NAME_TOO_LONG
A Workflow's name is over 64 characters. Shorten the binding name.
### WORKFLOW_REMOVED
`everyapp.config.ts` dropped a Workflow, so deploying deletes it and its instances. Declare it again, or, after asking, rerun with `--allow-delete-workflows`.
### ZONE_CUSTOM_DOMAIN_LIMIT
The zone would pass Cloudflare's 100 Custom Domains. Delete unused apps, or use a second Gateway on another domain.
### ZONE_CUSTOM_DOMAIN_LIMIT_NEAR
The zone is close to Cloudflare's 100 Custom Domains.
### ZONE_NOT_ACTIVE
The zone's nameservers don't point at Cloudflare yet. Finish that in the dashboard, then rerun.
### ZONE_NOT_FOUND
No zone in the account holds that hostname. Use a name under one of the account's domains, or add the domain.

## The Gateway's deploy API

Answered as `{ "error": "<code>", "message": "…" }` by the hosted deploy API and by Gateway app installs (Admin → Apps → Install app); no everyapp command calls them.

### APP_INSTALL_FORBIDDEN
Only owners and admins install apps from the browser.
### APP_INSTALL_NOT_AVAILABLE
Browser installs are off on this Gateway. Turn them on with `everyapp deploy-token add`, or install with `everyapp install <url>`.
### APP_INSTALL_REAUTH_REQUIRED
Installing needs a sign-in from the last 10 minutes. Sign out and in again.
### APP_INSTALL_SIGN_IN_REQUIRED
Sign in again to install apps.
### BINDINGS_MISMATCH
The uploaded Worker's bindings didn't read back as sent. Deploy again.
### BINDING_OWNED
The Gateway already has a binding named `APP__<worker>` that isn't this app's. `everyapp setup` rebinds from the registry.
### BUNDLE_REFUSED
The app can't be deployed as a third-party app; the message lists each problem. Change `everyapp.config.ts` or the build.
### BUNDLE_TOO_LARGE
The upload is over the deploy API's size or file limits. Shrink the Build Output.
### CLOUDFLARE_API_ERROR
A Cloudflare API call failed. Check the account and Cloudflare's status, then retry.
### CLOUDFLARE_PERMISSION_REQUIRED
Cloudflare refused the Gateway's deploy token. Give it the permissions on [deploy](/docs/agent/deploy#gateway-app-installs).
### CONFIGURATION_REQUIRED
A required Hyperdrive URL or Secrets Store value was left empty on the approval page.
### DEPLOYER_NOT_CONFIGURED
The Gateway lacks a setting deploying needs (the message names it). The operator sets it.
### DEPLOYMENT_VERSION_MISSING
Cloudflare returned no serving version after upload. Check the Worker before retrying.
### DEPLOY_FAILED
The deploy failed inside the Gateway. Deploy again.
### DEPLOY_FORBIDDEN
Only owners and admins deploy apps.
### DEPLOY_IN_PROGRESS
Another deploy of the app is running. Wait, then deploy again.
### DEPLOY_KEY_APP_MISMATCH
The deploy key is bound to another app.
### DEPLOY_KEY_INVALID
The deploy key is unknown, revoked or expired. Create one in Admin → Tokens.
### DEPLOY_KEY_REQUIRED
Send a deploy key as the bearer token.
### DEPLOY_NOT_FOUND
No such deploy job in the organization.
### DEPLOY_SCOPE_REQUIRED
The token isn't a deploy key. Create one in Admin → Tokens.
### EMAIL_ROUTES_TOO_MANY
Too many Email Routing rules on the domain to reconcile safely. Install with the CLI.
### EMAIL_ROUTE_MISSING
A routed address doesn't reach the app. Deploy the app.
### INTERNAL_ERROR
The deploy API or install failed unexpectedly. Try again.
### INVALID_BINDING
A built binding has no Cloudflare upload form. Rebuild with a current SDK.
### INVALID_BUNDLE
The upload is malformed.
### INVALID_RELEASE_URL
Not a release URL the install takes.
### INVALID_REPO_URL
Not a GitHub repository URL (`https://github.com/<owner>/<repo>`).
### INVALID_REQUEST
The request body isn't what the route takes.
### NOT_A_MEMBER
The deploy key's owner is no longer an active member.
### NOT_FOUND
No such deploy API route, or the path's organization isn't the key's.
### ORGANIZATION_SUSPENDED
The organization is suspended.
### PROTOCOL_TOO_OLD
The upload comes from an everyapp too old for this Gateway. Update everyapp.
### QUEUE_MISSING
A queue a consumer needs wasn't listed after provisioning. Retry.
### RELEASE_CHANGED
The downloaded release differs from the one reviewed. Review it again.
### RELEASE_FETCH_FAILED
GitHub or the release host was unreachable or answered wrongly. Try again.
### RESOURCE_LIST_TOO_LARGE
The account has too many resources to list safely. Install with the CLI.
### RESTORE_POINT_MISSING
A migration needs a restore point and Cloudflare returned none. Nothing was applied; retry.
### UNAUTHORIZED
No membership in the chosen organization.
### WORKER_CHANGED
The serving Worker version differs from the one recorded, or a gradual deployment is in progress. Check it; confirm replacement only when intended.

## What status reports

`everyapp status` lists each problem in `data.fixes[]` as `{ code, severity, message, run, note?, fix? }`: run `run` when it isn't `null`. See [status](/docs/agent/status).

### ACCESS_UNKNOWN
Whether Access is on couldn't be read. Check again.
### APP_BINDING
Goes live on its first visit. Nothing to run.
### APP_NEEDS_SETUP (status)
A required setting is unset, so the app doesn't open. Run `everyapp configure <app>`.
### APP_NOT_BOUND (status)
The app's Worker isn't named the way the Gateway names it. `everyapp delete <app>`, then deploy again.
### APP_NOT_UPLOADED
Registered, but no deploy finished. Deploy it again.
### APP_WORKER_MISSING (status)
The app's Worker no longer exists. Deploy it again, or `everyapp delete <app>`.
### BINDINGS_DIFFER
The live Gateway doesn't bind or publish what the registry lists. Run `everyapp setup`.
### CERTIFICATES_UNKNOWN
Cloudflare didn't list the zone's certificates. Check again.
### CERT_PENDING (status)
A hostname's certificate hasn't come yet. Wait.
### CHECKOUT_BEHIND
This checkout's Gateway is older than the live one; an update from here is refused (`GATEWAY_DOWNGRADE`) unless `--downgrade` says to put the older Gateway back. `git pull`.
### DEPLOY_RUNNING
A deploy is running. Wait.
### EMAIL_INBOUND_UNDECLARED (status)
Inbound addresses are stored but the app doesn't declare inbound mail. Declare `email: { inbound: true }` and deploy, or `everyapp email unset inbound`.
### EMAIL_ROUTES_UNKNOWN
Cloudflare didn't list the Email Routing rules. Check again.
### EMAIL_ROUTE_MISSING (status)
A routed address doesn't reach the app. Deploy the app.
### EMAIL_ROUTE_PENDING
An inbound address isn't routed yet. Deploy the app.
### GATEWAY_CHANGED
The Gateway Worker was changed outside everyapp. Run `everyapp setup`.
### GATEWAY_NOT_INSTALLED (status)
Setup stopped before it recorded the install. Run `everyapp setup`.
### GATEWAY_NOT_UPLOADED
The install stopped before its first upload. Run `everyapp setup`.
### GATEWAY_OUTDATED (status)
Error when the Gateway's database lacks the newest migration this everyapp needs (the other commands refuse it until it catches up); info when only a newer Gateway release is available. Either way `everyapp update`; deploying an app never changes the Gateway.
### NO_OWNER
Nobody has claimed the Gateway, so nobody can sign in. Run `everyapp setup` for a new owner link.
### SETTINGS_UNKNOWN
Cloudflare couldn't list a Worker's secrets, so some settings show as unknown (`set: null`, never blocking). Check again.
