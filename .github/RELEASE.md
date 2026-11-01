# Release Process

Publishing is paused while we work from the repository: nothing goes to npm,
and nothing is synced to the public repository. `everyapp` and
`@every-app/sdk` are private packages. The apps take them from the workspace.
How to work this way is in AGENTS.md: `pnpm everyapp` from the checkout,
never `npx everyapp`.

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
the SHA-256 its own `release.json` records before anything is deployed;
its `minCli` refuses a CLI older than the one it was built with.

### Publishing a Gateway release

The Gateway Release workflow (`.github/workflows/gateway-release.yml`)
builds `every-app-gateway-release.tar.gz` with
`apps/every-app-gateway/scripts/build-release.ts` and publishes it on a
GitHub Release of the repository it runs in. It runs on a push of a
`gateway-v<version>` tag, or by hand with the tag's name. The tag's
version is the CLI version it goes with: `gateway-v0.3.0-rc.4` is the
Gateway for `everyapp@0.3.0-rc.4`, and `release.json` says `version:
0.3.0-rc.4`, with `minCli` and `minSdk` the CLI's and the SDK's versions
at that commit. A version with a prerelease suffix is published as a
GitHub prerelease, so `/releases/latest` stays the newest stable one.

The CLI downloads anonymously from `github.com/every-app/every-app`, so
the release has to be on the public repository: push the tag there.
Publishing is one script, then the tag:

1. From a clean `main`: `pnpm publish:rc <version>` (`scripts/publish-rc.mjs`).
   It sets both packages to that version, builds the SDK then the CLI,
   checks that the built CLI says that version, publishes both under `next`
   (npm asks for web authentication), puts the package.json files back,
   moves `latest`, and prints the next commands. It also sets
   `PUBLISHED_VERSION` (`packages/cli/src/lib/app/publishedVersions.ts`), the
   version `everyapp create` pins new apps at, before building; commit that
   one-line change afterwards.
2. Push that commit to the public repository, then tag it there:
   `git tag gateway-v<version> <commit> && git push public gateway-v<version>`.
   The workflow publishes the release in a few minutes.
3. Check `npx everyapp@<version> --version` and `status` from a directory with
   no checkout: it must name the version and the release.

The CLI reads its version from its own package.json at run time
(`packages/cli/src/lib/version.ts`), so the version set at publish time is
the one it says and the Gateway release it asks for. Never import
`version` from package.json in the CLI: tsup inlines it at build time, which
is how 0.3.0-rc.6 shipped saying 0.3.0.

Keep the Gateway package's version (`apps/every-app-gateway/package.json`)
on the CLI's, prerelease suffix aside: a checkout's own build reports that
version, and `checkoutRelease.ts` compares the checkout with the
`gateway-v<version>` tag to tell an unreleased commit from a release.

## Turning publishing back on

Pausing removed what only a published CLI needs. Bring back:

- **Publishing itself:** drop `"private": true` from `packages/cli/package.json`
  and `packages/sdk/package.json`, and restore their pack scripts. The SDK
  had `prepack` and `prepublishOnly`. The CLI had `prepack`, which
  type-checked, built, and ran `scripts/bundle-gateway.js` (removed: the
  gateway release tarball stays out of the package now, see Gateway releases)
  and `scripts/bundle-templates.js` (removed too: the starter, now
  `starter/`, into `packages/cli/templates/`, removed; its `.gitignore`
  shipped as `gitignore`).
- **A Gateway for a CLI with no checkout:** done (Gateway releases, above).
- **Onboarding:** `everyapp setup` deployed a starter app (`--dir`,
  `--no-starter`), and `create` copied the bundled template, or cloned
  the public repository for it.
- **The cloneable apps and the template:** `@every-app/sdk` by semver range
  (with `linkWorkspacePackages: true` at the root), their own
  `pnpm-workspace.yaml` with `allowBuilds` for standalone installs, and
  `npx -y everyapp@latest` in their scripts.
- **Words:** `npx everyapp …` in the CLI's and the gateway's hints, the npm
  update check (`packages/cli/src/lib/version-check.ts`, removed), and the README's
  install steps (`npx everyapp setup`, `gitpick` for the examples).

All of it is in the git history of the change that paused publishing (#276).

Then publish the SDK first, then the CLI, and only then sync the public
repository: the cloneable apps reference versions that must already exist
on npm. Before publishing the CLI, `cd packages/cli && npm pack --dry-run`
must list `dist/index.js`, and no `.dev.vars` or `.env*` entries. Once the
public repository is synced, bring back Gateway releases there (above):
until then a CLI with no checkout has no Gateway to install.
