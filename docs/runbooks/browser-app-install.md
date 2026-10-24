# Browser app installation

A signed-in organization owner or admin can install a public GitHub app release or an immutable oss.new conversion from **Admin → Apps → Install app**. External sites can open:

```text
https://<gateway>/install?source=<URL-encoded release URL>
```

The source site asks for the user's Gateway address and opens this link. There is no central Gateway discovery service. For oss.new, the source is `https://oss.new/apps/<64-character lowercase hex key>`. The Gateway preserves this link through sign-in and pre-fills a standalone approval page, outside the app sidebar. Opening the link never installs anything: the admin must submit **Install** on their Gateway. The source field stays visible while availability, job progress, failures, and the installed app link update below it. It is disabled during installation and enabled when the job finishes; editing it then clears the previous result and requires a new approval. **Admin → Apps → Install app** opens the same page. The source is retained as deployment provenance.

The workspace appears above the source. One eligible workspace is shown read-only; with several, the user chooses from active workspaces they own or administer, defaulting to their active workspace when eligible. Selecting a destination does not change the session's active workspace. Approval and progress requests include the selected organization ID, and the Gateway checks its membership, live admin role, and active status again. Changing the active workspace in another tab cannot redirect an approved installation or its progress polling. Both fields are locked while installation runs; editing either after completion clears the previous result and requires fresh approval.

## Configure a self-hosted Gateway

Browser installation is on by default. Interactive `pnpm everyapp setup` offers **Configure browser app installs?** (Yes/No, default No), explaining: "Install apps on this Gateway through your browser, without running deployment commands." Enter accepts No and continues setup without changing credentials. Yes opens a hidden Cloudflare API token prompt. The instructions link to [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens), explain how to create a custom token, and list the required permissions and resource scopes. The token is stored as `CF_DEPLOY_TOKEN` on the Gateway. Existing tokens and hosted Gateways are left alone; unattended setup does not prompt, and neither does `--yes`, which answers No. Run setup again later to configure it if skipped.

For unattended configuration, use the matching CLI with the token already in your local environment:

```sh
pnpm everyapp secret set CF_DEPLOY_TOKEN --from-env CF_DEPLOY_TOKEN --json
```

Setup already set `CLOUDFLARE_ACCOUNT_ID`. It is one of the Gateway's own keys, so `secret set` refuses it (`SECRET_NOT_SETTABLE`).

`CF_DEPLOY_TOKEN` needs Workers Scripts Edit and D1 Edit for the Gateway's account, plus DNS Read for its domain's zone. Keep it on the Gateway; neither the installing site nor the browser receives it. The Gateway must already have its normal `GATEWAY_URL`, `APP_BASE_DOMAIN`, identity keys, and Custom Domain in that account.

To opt out, set `BROWSER_APP_INSTALLS` to exactly `off`:

```sh
BROWSER_APP_INSTALLS=off pnpm everyapp secret set BROWSER_APP_INSTALLS --from-env BROWSER_APP_INSTALLS --json
```

Leaving this setting unset enables browser installs; setting it to `on` also enables them. The opt-out prevents new installs without affecting already installed apps. Missing deployer credentials still make installation unavailable.

The installer uploads ordinary private account Workers, disables workers.dev and preview URLs, and adds each app's service binding and Custom Domain to the Gateway. Existing Gateway bindings, including secrets, are inherited. Browser and CLI deploys share deployment leases, Worker ownership claims, and the CLI's record of the Gateway's live version, bound apps, and published hostnames. The app's serving deployment version ID is recorded in the resource ledger immediately after upload, so the CLI can manage it even if a later install step fails. Other Workers and existing DNS records are never taken over. This first self-hosted browser flow installs new apps and retries unfinished installs; updates to active or disabled apps remain CLI operations. Workers changed outside this installer require CLI reconciliation.

Run the first CLI update at a terminal: the pinned Cloudflare CLI asks for confirmation before replacing code previously uploaded through the script API. Later CLI updates can run unattended. This existing Cloudflare confirmation still applies after the Gateway's ownership and version checks pass.

This first browser deployer supports the existing release-reader/policy subset: D1 with SQL migrations, own Durable Objects, static assets, and Gateway capabilities. KV, R2, Hyperdrive, custom secrets, Workflows, helper Workers, crons, and inbound mail are refused before resource provisioning. Use the CLI for these apps. Installing a release does not import an upstream application's existing user data. A successful job records the upload, Gateway binding, and hostname publication; certificate readiness and first-visit activation can follow it.

## Hosted Gateways

Hosted installation continues to use its existing `THIRD_PARTY_DEPLOYS=on` launch gate, dispatch namespace, separate third-party domain, and isolation policy. Enabling self-hosted browser installation does not enable that API or relax its restrictions.

## Release intake

Only public GitHub repositories and the exact oss.new endpoint above are accepted. oss.new fetches have a 15-second timeout, send no browser/deployer credentials, and refuse redirects. Both sources use the same bounded archive reader, integrity check, manifest validation, binding allowlist, and migration pipeline. A bad or unsupported bundle is refused before provisioning. There is no arbitrary-URL fetch proxy or source-code execution on the Gateway.
