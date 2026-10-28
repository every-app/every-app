# Pre-release check on the staging Gateway

Before a release goes public (`pnpm publish:rc`, the public push, a Gateway release tag), the CLI as it would publish runs against a named Gateway in Ben's main Cloudflare account, beside everyapp.team (docs/design/multi-gateway.md). Nothing here touches the default Gateway: every name the staging Gateway makes carries its name.

## The staging Gateway

| What        | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| Account     | `23bc28f0b638fbfc1c7f838573c17ee3` (Bensenescu@gmail.com's Account)   |
| Name        | `demo` (Worker and D1 `every-app-gateway-demo`)                       |
| Host        | `demo.everyapp.team` (apps at `<app>.demo.everyapp.team`)              |
| Access      | the account's Zero Trust team; applications "Every App gateway (demo)" and "Every App apps (demo)" |
| Install     | `pnpm everyapp setup --name demo --domain demo.everyapp.team` from `main`, with the checkout's CLI |
| Pick it     | `--gateway demo` (or `--gateway https://demo.everyapp.team`) on every command; the login sees two Gateways in this account, so nothing guesses |
| Remove it   | `pnpm everyapp teardown --account-id 23bc28f0b638fbfc1c7f838573c17ee3 --gateway demo` (typed confirmation `every-app-gateway-demo`); never a plain `teardown` here |

## The check, step by step

1. **Install the CLI as it would publish.** In the checkout at the release commit:

   ```sh
   pnpm -C packages/sdk build
   pnpm -C packages/sdk pack --pack-destination /tmp/ea-prerelease
   pnpm -C packages/cli build
   pnpm -C packages/cli pack --pack-destination /tmp/ea-prerelease
   npm install --prefix /tmp/ea-prerelease/prefix -g /tmp/ea-prerelease/every-app-sdk-*.tgz /tmp/ea-prerelease/everyapp-*.tgz
   export PATH=/tmp/ea-prerelease/prefix/bin:$PATH
   everyapp --version
   ```

   No `npm publish`.

2. **Update the staging Gateway** to the release: `everyapp update --gateway demo` (from the checkout: its build; from the packed CLI: `--release` the built tarball). Then `everyapp status --gateway demo --json` is green.
3. **Create and deploy an app**: `everyapp create /tmp/ea-prerelease/check-app`, `cd` there, `everyapp deploy --gateway demo --json`, open `https://check-app.demo.everyapp.team` behind Access, then `everyapp delete check-app --gateway demo`.
4. **Linked dev** (once #866 is in): `everyapp dev --gateway https://demo.everyapp.team` from the app, sign in through the staging Gateway, the local app serves.
5. **Sign in with Every App** from the OpenZen Mac app (`~/workspaces/open-notes`) against `https://demo.everyapp.team`, behind Access.
6. Record the run below.

## Runs

| Date | Release | Gateway | create + deploy | linked dev | native sign-in | Notes |
| ---- | ------- | ------- | --------------- | ---------- | -------------- | ----- |
|      |         |         |                 |            |                |       |
