# Browser app installation

A signed-in organization owner or admin can install a public GitHub app release or an immutable oss.new conversion from **Admin → Apps → Install app**. On a self-hosted Gateway that means the install organization's owners and admins (the oldest organization with an owner, the one setup's claim made): the Gateway's `CF_DEPLOY_TOKEN` is the account's, so no other organization may spend it, and nobody installs before the Gateway has an owner. External sites can open:

```text
https://<gateway>/install?source=<URL-encoded release URL>
```

The source site asks for the user's Gateway address and opens this link. There is no central Gateway discovery service. For oss.new, the source is `https://oss.new/apps/<64-character lowercase hex key>`. The Gateway preserves this link through sign-in and pre-fills a standalone approval page, outside the app sidebar. Opening the link never installs anything: the admin must submit **Install** on their Gateway. The source field stays visible while availability, job progress, failures, and the installed app link update below it. It is disabled during installation and enabled when the job finishes; editing it then clears the previous result and requires a new approval. **Admin → Apps → Install app** opens the same page. The source is retained as deployment provenance.

The workspace appears above the source. One eligible workspace is shown read-only; with several, the user chooses from active workspaces they own or administer (on a self-hosted Gateway, only the install organization is ever offered; the Install app entry and this list go by the person, so an admin of the install organization whose active workspace is another one still sees both), defaulting to their active workspace when eligible. Selecting a destination does not change the session's active workspace. Approval and progress requests include the selected organization ID, and the Gateway checks its membership, live admin role, and active status again; on a self-hosted Gateway a request for any organization but the install organization is refused and logged (`app_install.refused`, with the organization ids and the user). Changing the active workspace in another tab cannot redirect an approved installation or its progress polling. Both fields are locked while installation runs; editing either after completion clears the previous result and requires fresh approval.

## Configure a self-hosted Gateway

Browser installation is off until the operator turns it on: the deploy token is account-wide, so spending it from a browser is a choice, never a side effect of having stored the token. On a self-hosted Gateway only the install organization's owners and admins install, and only from a session signed in within the last 10 minutes (an older one gets `APP_INSTALL_REAUTH_REQUIRED`: sign in again, then install; polling a running job has no such rule). Interactive `pnpm everyapp setup` offers **Configure browser app installs?** (Yes/No, default No), explaining: "Install apps on this Gateway through your browser, without running deployment commands. Owners and admins, from a session signed in within the last 10 minutes; off until you say yes here." Enter accepts No and continues setup without changing credentials. Yes opens a hidden Cloudflare API token prompt and, with the token, writes `BROWSER_APP_INSTALLS=on`. The instructions link to [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens), explain how to create a custom token, and list the required permissions and resource scopes. The token is stored as `CF_DEPLOY_TOKEN` on the Gateway. Existing tokens and hosted Gateways are left alone; unattended setup does not prompt, and neither does `--yes`, which answers No. Run setup again later to configure it if skipped.

For unattended configuration, use the matching CLI with the token already in your local environment, then turn installs on:

```sh
pnpm everyapp secret set CF_DEPLOY_TOKEN --from-env CF_DEPLOY_TOKEN --json
BROWSER_APP_INSTALLS=on pnpm everyapp secret set BROWSER_APP_INSTALLS --from-env BROWSER_APP_INSTALLS --json
```

Setup already set `CLOUDFLARE_ACCOUNT_ID`. It is one of the Gateway's own keys, so `secret set` refuses it (`SECRET_NOT_SETTABLE`).

`CF_DEPLOY_TOKEN` needs Workers Scripts Edit and D1 Edit for the Gateway's account, plus DNS Read for its domain's zone. Add Edit permissions for the resources an app uses: Workers KV Storage, Workers R2 Storage, Queues, Workflows, Hyperdrive, Vectorize, AI Gateway, or Secrets Store. When Cloudflare Access is enabled, add Account → Access: Apps and Policies → Edit so the installer can reconcile public callbacks and bearer routes. Apps with configured inbound email need the zone's Email Routing permissions; explicitly enabling routing also changes its MX/SPF records. Missing API permissions stop the installation with `CLOUDFLARE_PERMISSION_REQUIRED`. Keep the token on the Gateway; neither the installing site nor the browser receives it. The Gateway must already have its normal `GATEWAY_URL`, `APP_BASE_DOMAIN`, identity keys, and Custom Domain in that account.

To turn installs off again, set `BROWSER_APP_INSTALLS` to exactly `off` (or unset it):

```sh
BROWSER_APP_INSTALLS=off pnpm everyapp secret set BROWSER_APP_INSTALLS --from-env BROWSER_APP_INSTALLS --json
```

Only exactly `on` enables browser installs; unset, `off` or anything else keeps them off. Turning them off prevents new installs without affecting already installed apps. Missing deployer credentials still make installation unavailable.

The installer uploads ordinary private account Workers, disables workers.dev and preview URLs, and adds each app's service binding and Custom Domain to the Gateway. Existing Gateway bindings, including secrets, are inherited. Browser and CLI deploys share deployment leases, Worker ownership claims, and the CLI's record of the Gateway's live version, bound apps, and published hostnames. The app's serving deployment version ID is recorded in the resource ledger immediately after upload, so the CLI can manage it even if a later install step fails. Other Workers and existing DNS records are never taken over. The browser can install, retry, and update the same release as `pnpm everyapp install`; a Worker changed outside EveryApp needs explicit replacement confirmation. Removing Durable Object data or Workflows needs its own confirmation, as does enabling Email Routing or registering bundled providers. A disabled app stays disabled after an update.

Run the first CLI update at a terminal: the pinned Cloudflare CLI asks for confirmation before replacing code previously uploaded through the script API. Later CLI updates can run unattended. This existing Cloudflare confirmation still applies after the Gateway's ownership and version checks pass.

Self-hosted browser installation uses `@every-app/perimeter/install`, the same Worker policy, Cloudflare Build Output schema, placeholder rewriting, resource provisioner, ownership ledger, Durable Object checks, inbound-email planner, and Access route plan as the CLI. It supports D1 SQL migrations, KV, R2, Hyperdrive, own Durable Objects, Workflows, helper Workers, Queues and their consumers, cron schedules, Vectorize, AI Gateways, Secrets Store, declared account bindings (Workers AI, Browser Rendering, Images, email sending, Analytics Engine), app settings/secrets, and Gateway capabilities. The approval page collects installation values; Hyperdrive origins and Secrets Store values go only to provisioning, never to the app as plaintext. Existing secrets are preserved, and setting defaults are applied without replacing configured values. Postgres/Prisma migrations still require source and are refused, just as the CLI release installer refuses them.

Opening an external `/install?source=…` link reviews the release without registering an app or provisioning account resources. Approval is bound to the reviewed archive hash; a changed release needs a new review. The page identifies an update to an existing app, and lists bundled providers' destination hosts before their separate registration consent. A successful job includes Access reconciliation for the app's public/bearer routes when Access is enabled. Installing a release does not import upstream application data. Gateway providers may still need their credentials configured; certificate readiness and first-visit activation can follow publication.

## Hosted Gateways

Hosted installation continues to use its existing `THIRD_PARTY_DEPLOYS=on` launch gate, dispatch namespace, separate third-party domain, and isolation policy. Enabling self-hosted browser installation does not enable that API or relax its restrictions.

## Release intake

Only public GitHub repositories and the exact oss.new endpoint above are accepted. oss.new fetches have a 15-second timeout, send no browser/deployer credentials, and refuse redirects. Both sources use the same bounded archive reader, integrity check, manifest validation, binding allowlist, and migration pipeline. A bad or unsupported bundle is refused before provisioning. There is no arbitrary-URL fetch proxy or source-code execution on the Gateway.
