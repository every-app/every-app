# Release Process

`@every-app/sdk`, `everyapp` and the Gateway are released together at one
version. The version is committed: it is in `packages/sdk/package.json`,
`packages/cli/package.json`, `apps/every-app-gateway/package.json` and the
SDK's `SDK_VERSION` (`packages/sdk/src/server/tools.ts`), and a test fails
when they disagree. A checkout says the newest release, and so does
everything built from it. The design is
[docs/design/2026-11-simplify-releases.md](../docs/design/2026-11-simplify-releases.md).

## Day to day: test `main`, then release

Commits land on private `main` for a day or two. During that time the
`everyapp` command on a maintainer's machine is the checkout's, and
everyapp.team runs the Gateway built from that checkout. Nothing is
published until the release. The commands are fish.

**Once per machine.** `everyapp` becomes a link to the checkout's launcher
(`packages/cli/bin/everyapp.js`), which works from any directory:

```fish
npm uninstall -g everyapp
mkdir -p ~/.local/bin; and ln -sf ~/workspaces/private-every-app/packages/cli/bin/everyapp.js ~/.local/bin/everyapp
fish_add_path ~/.local/bin
```

Keep that checkout on `main`; work on branches happens in worktrees.

**Use today's `main` CLI.** The next `everyapp` installs the dependencies
if the lockfile changed and rebuilds itself; `everyapp --version` names the
commit (`everyapp 0.3.0 (checkout 6afd18bb)`).

```fish
git -C ~/workspaces/private-every-app pull
```

**Put today's `main` Gateway on everyapp.team.** It builds the Gateway from
the checkout (a minute or two), migrates the database with a restore point,
then uploads. It stops if the checkout has uncommitted Gateway changes or
isn't on `origin/main`. Only a person runs this; an agent never does.

```fish
everyapp update --gateway https://everyapp.team
```

**Go back to the last release.** The checkout's CLI deploys the newest
published Gateway release over the live one. `--downgrade` says the
rollback is meant. The code goes back; the database keeps its migrations,
which is the reason for the rule below.

```fish
everyapp update --gateway https://everyapp.team --release https://github.com/every-app/every-app --downgrade
```

To put the database back as well, to before its last migrating update
(this loses what was written since; it asks first):

```fish
everyapp db restore --gateway
```

For the released CLI itself, without changing the link: `npx
everyapp@latest <command>`.

**Cut the release.** See "Releasing" below.

```fish
pnpm release patch
# merge the pull request it opens, then:
git switch main; and git pull; and pnpm release ship
```

**The rule that makes this safe: until the release, a Gateway migration on
`main` only adds** (a table, a column, an index). Going back to the last
release leaves the migrations in place, and the released apps and CLIs
keep running against a Gateway that is ahead of them, so a migration that
drops or renames what the last release reads breaks both. Drop it in the
release after.

While everyapp.team runs a checkout's Gateway:

- An `everyapp` from before 0.4.0 pinned in an app (its `node_modules`)
  can redeploy an existing app, but can't bind a new app or hostname or
  delete one (`GATEWAY_RELEASE_UNAVAILABLE`): the live Gateway came from a
  checkout it doesn't have. Use the linked `everyapp` for those. From
  0.4.0 every `update` saves the Gateway's release in the account's R2
  bucket and any machine binds from there
  ([docs/design/2026-11-gateway-release-store.md](../docs/design/2026-11-gateway-release-store.md)).
- The apps keep their pinned `@every-app/sdk`. A Gateway ahead of an app's
  SDK is what every user has after updating their Gateway, so it has to
  work; nothing checks it but using the apps.
- A worktree whose branch adds a migration can't talk to everyapp.team
  (`GATEWAY_OUTDATED`) and must not update it. Try it on a sandbox:
  `pnpm e2e` ([docs/runbooks/e2e.md](../docs/runbooks/e2e.md)).

## Releasing

1. `pnpm release <patch|minor|major|x.y.z>` (`scripts/release.mjs`) writes
   the next version into those four places, commits `Release <version>` on
   a new branch `release/<version>`, pushes it and opens its pull request
   (`--no-push` stops after the commit). Merge it. Merging publishes
   nothing. Plain semver: `patch` for anything, `minor` for a breaking
   change (pre-1.0).
2. `pnpm release ship`, from `main` after the merge, at a terminal. It
   shows the version, what will be published and the commits the public
   `main` doesn't have, checks that the Leak Check on `main` is green and
   that the push is a fast-forward, asks, and on yes pushes `main` to
   every-app/every-app. `--dry-run` shows the same and pushes nothing.
   That push is the release: the public Release workflow
   (`.github/workflows/release.yml`) sees a version that isn't released
   yet. It builds, checks that the built CLI says the version, creates the
   Gateway release `gateway-v<version>` at that commit (the
   `every-app-gateway-release.tar.gz` a CLI with no checkout downloads),
   and publishes `@every-app/sdk` and then `everyapp` to npm under `latest`
   by trusted publishing (no npm token; provenance). `ship` watches that
   run. Each step skips what is out already, so `gh workflow run
   release.yml -R every-app/every-app` finishes a run that failed half way.
3. `ship` ends by asking the built CLI whether it would install each
   public app's latest release. When it would, it says no app needs
   re-pinning. When it wouldn't, it names the app and prints that app's
   re-pin command.

Only Ben runs `ship`: it makes commits public and publishes to npm, and
neither can be taken back. The push it makes by hand is `git push
git@github.com:every-app/every-app.git main:main`.

- **npm can take several minutes to list a version** after the publish
  step succeeds (0.3.1, the first release `ship` made); `ship` waits on
  the workflow, which waits for npm.
- **It pushes over SSH.** `ssh -T git@github.com` must greet you by name on
  the machine that runs it.
- **Re-pinning an app is by hand**, with `pnpm pack-for-app <app> --npm
  <version>`. `ship` opens no pull requests in the app repositories.
- **There is no staging step.** The days on everyapp.team above are the
  check before a release; `pnpm e2e` gives a sandbox Gateway for anything
  riskier.

## When an app re-pins

A release doesn't make the apps re-pin. Each app pins the exact `everyapp`
and `@every-app/sdk` it was built with and keeps working on a newer
Gateway: the pins of the public apps differ, and 0.3.1 installed all of
them. Re-pin an app (`docs/runbooks/app-releases.md`) when:

- it wants a new SDK export, or an SDK fix that runs in its Worker;
- a newer CLI refuses its published release (`RELEASE_INVALID`), which is
  what `ship`'s closing check finds;
- its `release.yml` needs a newer `everyapp release --publish`.

Never because the Gateway moved.

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
   sources. A checkout behind the live Gateway is told to `git pull`, and
   one with uncommitted Gateway changes or at a commit that isn't on
   `origin/main` doesn't replace a live Gateway without `--unmerged`.
3. The published release of every-app/every-app for the CLI's own
   version: the GitHub Release tagged `gateway-v<version>`, or when there
   is none yet, the newest stable one (`/releases/latest`), said so.

A downloaded release lands in a private temp dir and is checked against
the SHA-256 its own `release.json` records before anything is deployed.
`setup` and `update` refuse to put a Gateway older than the live one over
it (`GATEWAY_DOWNGRADE`); `--downgrade` is the rollback, which puts the
older code back and leaves the database's migrations where they are.
Every other command refuses a Gateway whose database is older than the
CLI's (`GATEWAY_OUTDATED`; `update` brings it up, and a person at a terminal is
offered that update on the spot), and an app's deploy warns when its `@every-app/sdk` isn't the CLI's version
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
