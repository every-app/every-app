# Release Process

Publishing is paused while we work from the repository: nothing goes to npm,
and nothing is synced to the public repository. `everyapp` and
`@every-app/sdk` are private packages. The apps take them from the workspace.
How to work this way is in the README, under "Work from This Checkout".

## Gateway releases

While publishing is paused, the checkout's Gateway is the only source. Every
Gateway deploy (`everyapp setup`, `everyapp update`, and the rebind
an app's `deploy` or `delete` runs) builds the release from
`apps/every-app-gateway` in the checkout the CLI runs from
(`packages/cli/src/lib/gateway/checkoutRelease.ts`), kept under the
checkout's `node_modules/.cache/everyapp/` by the tree hash of its sources.
A checkout behind the live Gateway is told to `git pull`. The release's
`release.json` records `minCli`: a CLI older than that refuses it and says
to update.

History: until 2026-10-24 the CLI also took a published release
(`everyapp setup --release <url|file>`, and without a checkout the latest
release of `GATEWAY_RELEASE_REPO`), published by a Gateway Release workflow
(`.github/workflows/release.yml`) on `gateway-v*` tags. Nothing used them
while the CLI runs only from a checkout, so they went with the simplify pass
(docs/simplify-2026-10-24.md, decision 7); commit `5ef30882` is the last
main that has them.

## Turning publishing back on

Pausing removed what only a published CLI needs. Bring back:

- **Publishing itself:** drop `"private": true` from `packages/cli/package.json`
  and `packages/sdk/package.json`, and restore their pack scripts. The SDK
  had `prepack` and `prepublishOnly`. The CLI had `prepack`, which
  type-checked, built, and ran `scripts/bundle-gateway.js` (the gateway
  release tarball, which stays out of the package now: see Gateway releases)
  and `scripts/bundle-templates.js` (the starter, now `starter/`, into
  `packages/cli/templates/`, its `.gitignore` shipped as `gitignore`).
- **A Gateway for a CLI with no checkout:** published Gateway releases
  (the `setup --release` flag, the latest-release fallback and the Gateway
  Release workflow, all at `5ef30882`), or a tarball inside the CLI package
  again. The downgrade guard already orders releases by their newest
  migration, then when their sources were committed (a release's
  `release.json` `committedAt`), and `status` compares the checkout's tree
  hash with the install row's only when there is a checkout.
- **Onboarding:** `everyapp setup` deployed a starter app (`--dir`,
  `--no-starter`), and `create` copied the bundled template, or cloned
  the public repository for it.
- **The cloneable apps and the template:** `@every-app/sdk` by semver range
  (with `linkWorkspacePackages: true` at the root), their own
  `pnpm-workspace.yaml` with `allowBuilds` for standalone installs, and
  `npx -y everyapp@latest` in their scripts.
- **Words:** `npx everyapp …` in the CLI's and the gateway's hints, the npm
  update check (`packages/cli/src/lib/version-check.ts`), and the README's
  install steps (`npx everyapp setup`, `gitpick` for the examples).

All of it is in the git history of the change that paused publishing (#276).

Then publish the SDK first, then the CLI, and only then sync the public
repository: the cloneable apps reference versions that must already exist
on npm. Before publishing the CLI, `cd packages/cli && npm pack --dry-run`
must list `dist/index.js`, and no `.dev.vars` or `.env*` entries. Once the
public repository is synced, bring back Gateway releases there (above):
until then a CLI with no checkout has no Gateway to install.
