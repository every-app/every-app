# App releases: a repository anyone can install from

An app that lives in its own repository (OpenSEO, OpenCRM, OpenAnalytics,
Agentic Inbox, or yours) is installed on a Gateway with
`pnpm everyapp install https://github.com/<owner>/<repo>`, which downloads
`everyapp-release.tar.gz` from the repository's latest GitHub release
(`landing-page/content/agent/deploy.md`, "Release installs"). A repository
that publishes no release answers `NO_RELEASE`. This runbook is how a
repository gets to publish one on every push, and how its clone builds with
no Every App checkout beside it. It was set up for the four launch apps on
2026-10-24 and verified live on the onboarding loop's test account (a fresh
clone's release of OpenAnalytics installed and went live; OpenCRM's stopped
on `R2_NOT_ENABLED`, the account having never enabled R2).

## What an app repository needs

1. **The CLI and the SDK, resolvable from a clone.** Nothing is published
   to npm while we work from the checkout (`.github/RELEASE.md`), and the
   `link:../private-every-app/...` paths the ports used only resolve on a
   machine with that checkout beside the app: a stranger's `pnpm install`
   left dangling symlinks, and `pnpm dev` failed with
   `everyapp: command not found`. So the two packages are vendored as
   tarballs in the app's `vendor/` directory and referenced as `file:`
   dependencies:

   ```json
   "dependencies":    { "@every-app/sdk": "file:vendor/every-app-sdk-0.3.0.tgz" },
   "devDependencies": { "everyapp": "file:vendor/everyapp-0.3.0.tgz" }
   ```

   A packed CLI runs `dev`, `db migrate` and `release` on its own (its
   bundle inlines the SDK, the perimeter and the toolbus; its other imports
   are its declared dependencies, which pnpm installs from the registry).
   It can't `create`, `setup`, `update`, `deploy` or `install`: those build
   the Gateway from a checkout and stop with `CHECKOUT_MISSING`. Deploys
   therefore run from an Every App checkout (`pnpm everyapp install <url>`
   there, or that checkout's CLI from the app's directory:
   `node ../every-app/packages/cli/bin/everyapp.js deploy`).

2. **A Release workflow.** `release.yml` in the app's `.github/workflows` runs
   `pnpm install --frozen-lockfile` and `pnpm exec everyapp release`, keeps
   the tarball as a run artifact on every pull request, and on a push to the
   default branch publishes a GitHub release with it: tagged
   `v<package.json version>`, or `v<version>-<yyyymmdd>-<sha>` when that tag
   is taken; a pushed `v*` tag releases under its own name; a manual run
   (`workflow_dispatch`) publishes a draft. No secret and no Cloudflare
   account: the release is tenant-neutral, and the Gateway that installs it
   fills in the account. The job needs `contents: write` (the file sets it).

## One command sets both up

From an Every App checkout, with the app's repository cloned beside it:

```sh
pnpm pack-for-app ../open-crm --workflow
```

`scripts/pack-for-app.mjs` builds the SDK and the CLI, packs both into
`<app>/vendor/` (replacing earlier tarballs), points the app's `package.json`
at them, writes `vendor/README.md` (which commit the tarballs come from, how
to refresh them, how to use a live checkout instead), copies
`scripts/pack-for-app/release.yml` into the app's `.github/workflows` as
`release.yml` with `--workflow`, and runs `pnpm install` in the app so its lockfile records the
tarballs' integrity. Commit `vendor/`, `package.json`, `pnpm-lock.yaml` and
the workflow. `--no-build` skips the builds (the tarballs are packed from
`dist/` as it is), `--no-install` the install.

Refreshing after a platform change is the same command without
`--workflow`. A refreshed tarball keeps its name; its integrity changes, so a
`pnpm install --frozen-lockfile` against the old lockfile fails with
`ERR_PNPM_TARBALL_INTEGRITY` rather than build with stale code, and the
script's `pnpm install` is what updates the lockfile.

The app's default branch is what the workflow releases from. A repository
whose default branch isn't `main` (Agentic Inbox's is `everyapp` until it is
renamed) lists it under `on.push.branches` too; the job publishes only when
the pushed branch is the repository's default.

## Checking a release before anyone installs it

- The pull request's "everyapp release" check is the build: it fails where
  `pnpm everyapp release` would (install, `cf build`, the app policy, the
  schema check).
- The reader `install` uses is `openAppRelease` in
  `packages/cli/src/lib/app/release.ts`; the tarball's name and layout
  (`release.json`, `.cloudflare/output/v0/`, `migrations/`) are what
  `extractRelease` checks. `pnpm everyapp install ./everyapp-release.tar.gz`
  from an Every App checkout installs a downloaded asset without GitHub.
- Downloads from GitHub are anonymous, so a private repository's releases
  answer 404 (`NO_RELEASE`) even to its own members: the URL form only works
  once the repository is public. Until then, download the asset with
  `gh release download <tag> -p everyapp-release.tar.gz` and install the file.

## What the apps' Workers need in the account

Three of the four launch apps bind an R2 bucket named after the app's Worker
(`bindings.r2({ name: worker.name })` in their `cloudflare.config.ts`). The
deploy makes the bucket when it doesn't exist (`packages/cli/src/lib/app/buckets.ts`,
since 2026-10-24; before that the upload failed with
`[10085] R2 bucket '<name>' not found`), but an account that never enabled
R2 can't have one made by the API: the deploy stops with `R2_NOT_ENABLED`,
and the person enables R2 once in the dashboard (R2 Object Storage → Get
started), then runs the command again. OpenAnalytics binds no R2 and
installs on a fresh account as it is.

## The alternatives, for the record

- **npm packages at a pinned version** (`"everyapp": "0.3.0"`): the
  cleanest once publishing resumes (`.github/RELEASE.md`, "Turning
  publishing back on"): drop `"private": true` from
  `packages/cli/package.json` and `packages/sdk/package.json`, publish the
  SDK then the CLI, and replace the `file:` specifiers. Until then every
  clone would break, and the ports' `pnpm-workspace.yaml` `minimumReleaseAge`
  (8 days) would refuse a just-published `everyapp` unless excluded.
- **A git dependency on the platform repository**
  (`github:every-app/every-app#<sha>&path:/packages/sdk`): pnpm resolves it
  but ships only `package.json` and `README.md` (the package's `files` is
  `dist`, which nothing builds), tried on 2026-10-24. Unusable without a
  build step pnpm doesn't run.
- **A sibling checkout** (`link:../every-app/...`): what the ports had,
  renamed; works only with the checkout beside the app, and the workflow
  would clone and install the whole platform on every run.
