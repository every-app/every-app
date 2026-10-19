# Release Process

Publishing is paused while we work from the repository: nothing goes to npm,
and nothing is synced to the public repository. `everyapp` and
`@every-app/sdk` are private packages. The apps take them from the workspace.
How to work this way is in the README, under "Work from This Checkout".

## Gateway releases

Where a Gateway deploy or rebind takes the Gateway from is one resolver,
`packages/cli/src/lib/gateway/source.ts`:

1. `everyapp setup --release <url|file>`: that release (a GitHub repository
   URL for its latest release, a release tarball's URL, or a downloaded
   `every-app-gateway-release.tar.gz`).
2. A CLI running from a checkout: the release that checkout builds
   (`packages/cli/src/lib/gateway/checkoutRelease.ts`, kept under the
   checkout's `node_modules/.cache/everyapp/` by the tree hash of its
   sources). A checkout behind the live Gateway is told to `git pull`.
3. Otherwise: the latest release of `https://github.com/every-app/every-app`
   with an `every-app-gateway-release.tar.gz` asset (`GATEWAY_RELEASE_REPO`
   in `packages/cli/src/lib/gateway/release.ts`). The Gateway isn't shipped
   inside the CLI package, so a new Gateway never waits for a CLI release.

`.github/workflows/release.yml` publishes that asset: on a push of a
`gateway-v*` tag, or run by hand (Actions → Gateway Release → Run workflow,
with a tag, by default `gateway-v<apps/every-app-gateway version>`). It builds
the SDK and `pnpm -C apps/every-app-gateway build:release`, then creates the
GitHub release on the tag (at the commit it ran on, when the tag is new), or
replaces the tarball of the release that has it. The release's `release.json`
records `minCli`: a CLI older than that refuses it and says to update.

The CLI downloads anonymously, and the private repository's releases can't
be downloaded without signing in (GitHub answers 404). So until the public
repository `every-app/every-app` is synced again and publishes releases,
the default (3) only works for a CLI running from a checkout, which never
reaches it. To install a release without a checkout, download its tarball
(signed in, from this repository's Releases page, or `gh release download
<tag> -p every-app-gateway-release.tar.gz`) and run `everyapp setup
--release ./every-app-gateway-release.tar.gz`. App deploys from such a CLI
rebind with the default, so they need the public releases too.

## Turning publishing back on

Pausing removed what only a published CLI needs. Bring back:

- **Publishing itself:** drop `"private": true` from `packages/cli/package.json`
  and `packages/sdk/package.json`, and restore their pack scripts. The SDK
  had `prepack` and `prepublishOnly`. The CLI had `prepack`, which
  type-checked, built, and ran `scripts/bundle-gateway.js` (the gateway
  release tarball, which stays out of the package now: see Gateway releases)
  and `scripts/bundle-templates.js` (`templates/simple-todo`, into
  `packages/cli/templates/`, its `.gitignore` shipped as `gitignore`).
- **The CLI's use of that bundle:** none. The Gateway comes from GitHub
  releases now (above), not from a tarball inside the CLI package; the
  bundle scripts stay gone. The downgrade guard orders releases by their
  newest migration, then when their sources were committed (a release's
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
public repository is synced, publish a Gateway release there (above): until
then a CLI with no checkout has no Gateway to install.
