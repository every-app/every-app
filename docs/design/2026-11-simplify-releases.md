# Simplify releases, the public mirror and local dev (2026-11-07)

Ben asked for three things: private `main` mirrored to public `main` without ceremony, a simpler
SDK and CLI release, and a way to change the CLI and SDK locally without blocking the apps.
This page is the proposal. Pull requests:

| PR | What | Live once |
| --- | --- | --- |
| 1 (#996) | The version is committed; `pnpm release` replaces `publish:rc`; the SDK check ignores a linked SDK; this page | merged |
| 2 (#997) | `public-mirror.yml`: a leak check, then private `main` → public `main` | Ben sets up the mirror app (below) |
| 3 (#998) | `release.yml` on the public repository publishes npm and the Gateway when the version changes | Ben sets up npm trusted publishing (below) |

## Ben's day to day

```sh
# Experiment: any branch in any private-* repository. Nothing leaves it.

# Ship: merge the pull request into private main. That is all.
#   The mirror runs a leak check, then pushes main to the public repository (PR 2),
#   whose own workflows run (an app's Release, the platform's Release).

# Release the SDK, the CLI and the Gateway (one version):
pnpm release patch                          # or minor, or 0.4.0: a "Release x.y.z" commit on release/x.y.z
git push -u origin release/0.3.1 && gh pr create --fill
# merge it. With PR 3 live, that is the whole release. Until then, from main:
git switch main && git pull && pnpm release publish   # npm (web auth), then prints the Gateway tag command

# Move an app to the new version (or merge the app's Dependabot pull request):
pnpm pack-for-app ../open-crm --npm 0.3.1

# Try unreleased CLI or SDK code in an app (local only):
cd ../open-crm && pnpm link ../private-every-app/packages/cli ../private-every-app/packages/sdk
git restore pnpm-workspace.yaml pnpm-lock.yaml && pnpm install    # back to the pinned release
```

## How it works today

| Part | What it is | Needed? |
| --- | --- | --- |
| Repo pairs | `private-X` → `X` (every-app, open-seo, open-crm, open-analytics, open-mail) share history. Ben pushes public `main` by hand as a fast-forward | **Needed.** By hand is the problem: public every-app is 2 commits behind, no clone here has the `public` remote the scripts name, `gateway-v0.3.0-rc.12` was never tagged |
| Version | The repository says `0.3.0` with `"private": true`. `publish:rc` stamps the real version into 4 files, builds, publishes, then puts back 3 of them; `PUBLISHED_VERSION` needs its own commit afterwards | **Accidental.** It cost a PR per release (#949, #981, #992) and broke main twice (#975, #976 after rc.13) |
| dist-tags | Each rc goes to `next`, then `latest` moves to it too | **Accidental.** Both always point at the same version |
| rc numbering | 15 rcs of 0.3.0. GitHub prereleases, so `/releases/latest` has no stable Gateway to fall back on | **Accidental.** It's pre-1.0 anyway: plain 0.x.y says the same |
| Two versions in the CLI | `PUBLISHED_VERSION` vs the CLI's own; the SDK check compares against one or the other depending on whether a checkout is in use; the Gateway's package.json is "the CLI's, prerelease aside" | **Accidental.** It exists only because the version isn't committed |
| Gateway release | `gateway-v<version>` tag pushed by hand to public; `gateway-release.yml` builds the tarball | **Needed** (published CLIs download it). Tagging by hand is the accident |
| Apps | Each pins an exact version; `pack-for-app --npm` re-pins; pins today run from rc.3 to rc.14 | **Needed.** Re-pinning ten repos by hand is the accident |
| App `release.yml` | Runs on private repos too, publishing releases nobody can download | Harmless noise |
| `pnpm link` | Writes a `link:` override into the app's `pnpm-workspace.yaml` and lockfile | **Needed** (no pnpm option avoids it). Must never be committed |
| `create` from a checkout | Writes `link:` specifiers into the new app's committed `package.json` | **Contradicts** AGENTS.md's "never commit a link" |
| `.github/RELEASE.md` | Opens with "Publishing is paused" | **False** since 2026-10-25 |
| Pre-release check | Staging Gateway `demo` (docs/runbooks/pre-release-check.md) | Keep as an optional check before a big release, not a step of every release |

## 1. Sync: one workflow, the same in every private repository

**`.github/workflows/public-mirror.yml` (PR 2).** On each push to a private repository's
`main` it:

1. reads the public repository's `main` (`private-X` → `X`, or the repository variable `PUBLIC_REPO`);
2. refuses unless the push is a fast-forward (no force, ever);
3. runs gitleaks over only the commits that aren't public yet (`.gitleaks.toml`: the default
   rules, plus two narrow allowlists for made-up values in tests);
4. pushes `main` to the public repository with a GitHub App token. A push made with an app token
   runs the public repository's workflows; a push made with `GITHUB_TOKEN` wouldn't.

On pull requests it runs only the leak check, so a leak is caught before it reaches `main`.
Branches, PRs and tags never leave. Without the app it is a leak check and nothing more, so
merging PR 2 is safe before the setup.

- **Why an app, not deploy keys:** one app covers every pair (5 now, more later), its tokens are
  short-lived, and the org is on GitHub Team, so one org-level secret reaches every private repository.
- **Why not `git push public main`:** that is today's process. It depends on remembering, and it
  has drifted.
- **Outside pull requests on a public repository:** don't merge them there, or the mirror stops
  with a message. Fetch the PR into the private repository instead (`git fetch
  https://github.com/every-app/every-app pull/18/head:pr-18 && git push origin pr-18`), merge it
  there, and close the public one. The mirror publishes it.
- **Deleted:** pushing by hand, the `public` remote in docs and scripts, and "by hand, a fast-forward" in the runbooks.
- **Per-repo fixes the mirror needs** (Ben, in each repo): `private-open-mail` renames its default
  branch `everyapp` → `main` (or lists `everyapp` under `push.branches`); `video-skills` has
  unrelated histories, so either reset its public `main` once or leave it out.

## 2. Releases: the version is committed, and a release is a commit that changes it

- **One version** for `@every-app/sdk`, `everyapp` and the Gateway. It lives in the three
  package.json files and `SDK_VERSION`, and a test fails if any of them disagree. `pnpm release
  <patch|minor|major|x.y.z>` writes all four in one commit on `release/<version>`.
- **Publishing publishes what's committed.** `pnpm release publish` (PR 1) runs from `main`: it
  builds, checks the built CLI's `--version`, runs the public-apps check, and publishes whatever
  isn't on npm yet under `latest`. It rewrites no files, so nothing has to be put back. Running it
  again finishes a half-done publish. `--dry-run` stops before npm.
- **Then CI publishes (PR 3).** `release.yml` on the public repository replaces
  `gateway-release.yml`. On each push to `main`, if the committed version isn't released, it creates
  the `gateway-v<version>` release at that commit and publishes both packages to npm with trusted
  publishing (no npm token anywhere; provenance because the repository is public). Every step
  skips what's already out, so it's safe to run again. Merging the release PR becomes the whole
  release: the mirror pushes, and the public repository publishes.
- **Plain semver from now on.** The next release is `0.3.0` (`pnpm release patch` from rc.15). After
  that, `patch` for anything and `minor` for a breaking change. No more rcs, and no `next`
  dist-tag. Apps keep exact pins.
- **Not changesets.** Two packages released in lockstep by one person, with a CHANGELOG written by
  hand: changesets would add a file per change and a bot PR, and solve nothing we have.
- **Apps re-pin through Dependabot.** In each app repository, `.github/dependabot.yml` opens one PR
  that moves both pins together:

  ```yaml
  version: 2
  updates:
    - package-ecosystem: npm
      directory: /
      schedule: { interval: daily }
      allow: [{ dependency-name: everyapp }, { dependency-name: "@every-app/sdk" }]
      groups: { everyapp: { patterns: [everyapp, "@every-app/*"] } }
  ```

  `pack-for-app --npm` stays for doing it by hand.
- **App releases only from the public repository.** In each app's `release.yml`, add
  `if: "!startsWith(github.event.repository.name, 'private-')"` to the job. The private copies stop
  publishing releases nobody can download.
- **Deleted:** `scripts/publish-rc.mjs`, the `PUBLISHED_VERSION` commit after each publish (it's now
  the CLI's own version), the pin-vs-CLI split in the SDK check, `.github/RELEASE.md`'s "paused"
  and "turning publishing back on", and with PR 3 the hand-pushed Gateway tag and `gateway-release.yml`.

## 3. Local dev: link per app, release often, no preview builds

- **The CLI.** In the checkout, `pnpm everyapp` already runs the code in front of you: its
  launcher rebuilds the SDK and the CLI when their sources changed. For an app, `pnpm link
  <checkout>/packages/cli` makes that app's `everyapp` the checkout's launcher. It rebuilds the same
  way and deploys the checkout's Gateway.
- **The SDK.** `pnpm link <checkout>/packages/sdk` in the app. With the CLI linked as well, every
  `everyapp dev` or `deploy` rebuilds a stale SDK first. Without it, run `pnpm -C packages/sdk build`
  after an edit.
- **Other apps aren't blocked.** A link touches one app only, and every other app keeps its pinned
  release. To push an app branch, restore `pnpm-workspace.yaml` and `pnpm-lock.yaml` first. If the
  link is committed by mistake, it can't install anywhere without the checkout beside the app
  (`--frozen-lockfile` fails), so CI goes red rather than shipping it.
- **When an app needs an SDK change on its `main`,** merge the SDK change and release. With PR 3
  that is one more merge, and npm has it a few minutes later. Then the app pins it (Dependabot). A
  cheap release replaces preview builds:
  - pkg.pr.new doesn't serve private repositories (its issue #240 was closed as not planned).
  - Publishing `-dev.<sha>` builds of private branches to npm would leak exactly the experiments
    the private repositories exist for.
- **`SDK_VERSION_MISMATCH`** (PR 1) compares the app's SDK with this CLI's version only, and says
  nothing for a linked SDK (one that resolves outside `node_modules`), since that SDK is whatever the
  checkout holds. `GATEWAY_OUTDATED` already compares database schemas, not versions, so linking
  doesn't affect it.
- **Recommended, not done here:** `everyapp create` from a checkout should pin npm like everywhere
  else and link only with a flag (`--link`), so no new app starts with a `link:` in its committed
  `package.json` (#827 chose linking; Ben's call).

## Waiting on Ben

1. **Merge PR 1.** Then `next` is dead: `npm dist-tag rm everyapp next && npm dist-tag rm @every-app/sdk next`.
2. **The mirror app (PR 2).** In GitHub, org settings → Developer settings → GitHub Apps → New:
   - name `every-app-mirror`, no webhook;
   - repository permissions Contents read and write, Workflows read and write;
   - install it on the public repositories only (every-app, open-seo, open-crm, open-analytics, open-mail);
   - org variable `MIRROR_APP_ID` and org secret `MIRROR_APP_PRIVATE_KEY` (the app's private key),
     both visible to the private-* repositories;
   - if a public `main` is protected, let the app bypass the protection.

   Then merge PR 2 and copy `public-mirror.yml` and `.gitleaks.toml` into each private app repository.
3. **npm trusted publishing (PR 3).** On npmjs.com, for both `everyapp` and `@every-app/sdk`:
   Settings → Trusted publishing → GitHub Actions, with organization `every-app`, repository
   `every-app`, workflow `release.yml`, environment `npm`, and "npm publish" ticked. Optionally,
   create the `npm` environment on the public repository with Ben as required reviewer, so each
   publish waits for one click. Then merge PR 3.
4. **First release on the new scheme:** `pnpm release patch` (→ `0.3.0`), then merge. Until PR 3 is
   live, also run `pnpm release publish` and push the printed Gateway tag.
5. **Per app repository:** Dependabot file, the `private-` guard on `release.yml`, and open-mail's branch rename.

## Open questions

- **Release approval:** should the `npm` environment require Ben's click per publish? This page
  leans yes for now, since it's cheap and stops an accidental version bump from shipping.
- **`create` from a checkout:** pin npm (recommended above), or keep linking?
