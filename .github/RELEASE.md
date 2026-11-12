# Release Process

`@every-app/sdk`, `everyapp` and the Gateway are released together at one
version. The version is committed: it is in `packages/sdk/package.json`,
`packages/cli/package.json`, `apps/every-app-gateway/package.json` and the
SDK's `SDK_VERSION` (`packages/sdk/src/server/tools.ts`), and a test fails
when they disagree. A checkout says the newest release, and so does
everything built from it. The design is
[docs/design/2026-11-simplify-releases.md](../docs/design/2026-11-simplify-releases.md).

## Releasing

1. `pnpm release <patch|minor|major|x.y.z>` (`scripts/release.mjs`) writes
   the next version into those four places and commits `Release <version>`
   on a new branch `release/<version>`. Push it, open the pull request,
   merge it. Plain semver: `patch` for anything, `minor` for a breaking
   change (pre-1.0).
2. Push `main` to every-app/every-app (by hand, once the Leak Check on
   `main` is green): `git push git@github.com:every-app/every-app.git
   main:main`. That's the release: its Release workflow
   (`.github/workflows/release.yml`) sees a version that isn't released
   yet. It builds, checks that the built CLI says the version, creates the
   Gateway release `gateway-v<version>` at that commit (the
   `every-app-gateway-release.tar.gz` a CLI with no checkout downloads),
   and publishes `@every-app/sdk` and then `everyapp` to npm under `latest`
   by trusted publishing (no npm token; provenance). Each step skips what
   is out already, so `gh workflow run release.yml -R every-app/every-app`
   finishes a run that failed half way.
3. Re-pin the first-party apps to the version
   (`pnpm pack-for-app <app> --npm <version>`, or the app's Dependabot pull
   request).

By hand, `pnpm release publish` (from `main`, after the merge) publishes
the two npm packages the same way, with npm's web authentication. It also
asks the built CLI whether it would install each public app's latest
release, and names the apps to re-release. `--dry-run` stops before npm.

Before a big release, the optional pre-release check on the staging
Gateway is [docs/runbooks/pre-release-check.md](../docs/runbooks/pre-release-check.md).

## Gateway releases

A Gateway deploy (`everyapp setup`, `everyapp update`, and the rebind an
app's `deploy` or `delete` runs) takes the Gateway from one of three
places, in this order (`packages/cli/src/lib/gateway/source.ts`):

1. `--release <url|path>` on `setup` or `update`: that release. A
   github.com repository URL means its latest release
   (`/releases/tag/<tag>`: that one), any other HTTPS URL a tarball to
   download, anything else a local `every-app-gateway-release.tar.gz`.
2. A checkout, when everyapp runs from one (`pnpm everyapp`): the release
   it builds from `apps/every-app-gateway`
   (`packages/cli/src/lib/gateway/checkoutRelease.ts`), kept under the
   checkout's `node_modules/.cache/everyapp/` by the tree hash of its
   sources. A checkout behind the live Gateway is told to `git pull`.
3. The published release of every-app/every-app for the CLI's own
   version: the GitHub Release tagged `gateway-v<version>`, or when there
   is none yet, the newest stable one (`/releases/latest`), said so.

A downloaded release lands in a private temp dir and is checked against
the SHA-256 its own `release.json` records before anything is deployed.
Every other command refuses a Gateway whose database is older than the
CLI's (`GATEWAY_OUTDATED`; `update` brings it up), and an app's deploy
warns when its `@every-app/sdk` isn't the CLI's version
(`SDK_VERSION_MISMATCH`; not for an SDK linked from a checkout).

The Release workflow builds `every-app-gateway-release.tar.gz` with
`apps/every-app-gateway/scripts/build-release.ts` and publishes it on a
GitHub Release of every-app/every-app, where the CLI downloads it
anonymously. A version with a prerelease suffix is published as a GitHub
prerelease, so `/releases/latest` stays the newest stable one.

`checkoutRelease.ts` compares the checkout with the `gateway-v<version>`
tag of the Gateway's package.json version to tell an unreleased commit from
a release.

The CLI reads its version from its own package.json at run time
(`packages/cli/src/lib/version.ts`). Never import `version` from
package.json in the CLI: tsup inlines it at build time, which is how
0.3.0-rc.6 shipped saying 0.3.0.

From a checkout, `everyapp --version` adds the commit (`everyapp 0.3.0
(checkout 6afd18bb)`), and the launcher (`packages/cli/bin/everyapp.js`)
keeps the checkout runnable after a `git pull`: it installs the
dependencies when `pnpm-lock.yaml` changed since the last install (`pnpm
install --frozen-lockfile`, recorded by the lockfile's hash under
`node_modules/.cache/everyapp/`), then rebuilds the CLI when its sources
changed. `EVERYAPP_AUTO_INSTALL=0` or `CI` turns the install off. A
published everyapp has no source beside it and does neither.
