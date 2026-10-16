# Forks of catalog apps, and how code outside this repository gets the SDK and CLI

Round-2 gap report, 2026-10-15. Code references are to `origin/main` at
`72170b10` (#294, the merged CLI redesign) unless marked `e1d9d3c6` (this
worktree). Web sources were fetched on 2026-10-15; the page's own date is given
where it shows one. Anything not sourced is marked UNVERIFIED and listed in §6.

---

## 1. The question

The founder wants it "super easy and secure to run either customizations/forks
of a repo or pure internal apps" (`BRIEF.md:20-22`). The synthesis puts forks
on the dispatch tier (README §1 diagram, D2) and mentions "fork PRs" (D9, H24),
but it never says what a fork is. There is also a hard blocker: the catalog
apps depend on `@every-app/sdk: workspace:*`, and nothing has been published
since 2026-10-13. This report answers:

- **(a)** What is a fork in the hosted product? A copy in the org's own repo,
  or an app in our monorepo? A new app id with fresh resources and no grants
  until someone approves them?
- **(b)** How does a fork get the SDK and the CLI? Publish to npm again, vendor
  the SDK in a template repo, or keep forks inside the monorepo? And how does
  that fit the versioning and SDK/gateway compatibility rules, and the
  "checkout is the truth" rule for self-host?
- **(c)** What does `everyapp fork <catalog-app>` do, and what happens on
  GitHub (creating the repo, syncing upstream)?
- **(d)** How is a fork flagged in the registry, and how do grants (D8) and
  plans (D3) treat it?

---

## 2. Findings

### 2.1 The blocker is wider than forks: no outside organization can build any app today

- Both publishable packages are marked private: `packages/sdk/package.json:3`
  and `packages/cli/package.json:3` (`"private": true`, added by #276).
- Every catalog app and the starter take the SDK and the CLI from the
  workspace:
  - `apps/todo-app/package.json:26,62`
  - `apps/chef/package.json:23,53`
  - `apps/workout-tracker/package.json:25,55`
  - `templates/simple-todo/package.json:22,49`
- `everyapp app create` copies `templates/simple-todo` from the checkout the
  CLI runs from (`packages/cli/src/commands/app/create/index.ts:5-12,72`;
  `packages/cli/src/lib/app/starter.ts:35-38`). Outside the checkout it rewrites
  each `workspace:` dependency into a relative `link:` path back into that
  checkout (`packages/cli/src/commands/app/create/steps/updateConfiguration.ts:11-48`).
  The result builds only on a machine with our checkout at that exact path.
  The root README documents this (`README.md:144-164`,
  `"@every-app/sdk": "link:../private-every-app/packages/sdk"`), and RepoLens
  is built that way (`~/workspaces/repolens/package.json:24,60`).
- The CLI refuses to run outside a checkout. `checkoutRoot()` throws
  `CHECKOUT_MISSING` (`packages/cli/src/lib/checkout.ts:13-29`). `app deploy`
  needs a checkout to rebuild the Gateway for a rebind
  (`packages/cli/src/commands/app/deploy/deployApp.ts:148-150`;
  `packages/cli/src/commands/gateway/shared.ts:76`).
- Both repositories are private. The monorepo is
  `every-app/private-every-app`, and the old public repo `every-app/every-app`
  is now private too, last pushed 2026-08-02 (`gh repo view`, 2026-10-15).
  Pre-#276, `create` used to clone that repo for the template (deleted
  `cloneTemplate.ts`, `git show db80b17b`). That path is dead in any case.
- **Consequences:**
  - An outside org cannot run `create`, cannot build, and cannot run the
    planned `every-app/deploy` GitHub Action (H24 v1 runs `everyapp deploy`
    in the org's own CI).
  - Our own v2 Sandbox builder can't resolve `workspace:*` or `link:` either,
    since its container has "no internet except the npm registry"
    (`raw/build-and-deploy-from-github.md:36-37`).
  - So the blocker covers every org app, not only forks. It blocks D9 v1
    outright, and the "first outside org" list in README §5 (~40 d) doesn't
    include it.
- **What npm has now** (`npm view`, 2026-10-15):
  - `@every-app/sdk`: latest is 0.2.0 (2026-07-31).
  - `everyapp`: latest is 0.2.2 (2026-08-02).
  - Version 0.3.0, the version in the repository, was never published.
  - Both packages have one maintainer, a personal account (`bensenescu`).
  - The README says why 0.2.x is unusable: "Don't use `npx everyapp`: that
    runs the old 0.2 CLI from npm, which can't deploy this Gateway"
    (`README.md:60`).
  - It also predates the hardening PRs #267-#271 (all merged 2026-10-13). So
    npm's `latest` is both incompatible and missing those security fixes.
- **OpenSEO and RepoLens:**
  - OpenSEO pins `@every-app/sdk ^0.1.14` from npm
    (`open-seo/package.json:84`; `raw/build-and-deploy-from-github.md:143`).
  - RepoLens links the checkout by path. Neither can build in CI against
    today's SDK.

### 2.2 What pausing removed (`.github/RELEASE.md:15-54`, `git show db80b17b`)

- **Publishing itself:**
  - `"private": true` on both packages.
  - The SDK's `prepack`/`prepublishOnly`.
  - The CLI's `prepack`, which also ran `scripts/bundle-gateway.js` (the
    Gateway release tarball) and `scripts/bundle-templates.js` (the starter).
  - There was no CI publish workflow. Publishing was a manual
    `pnpm --filter … publish` from a laptop (`git show db80b17b^:.github/RELEASE.md:29-32`),
    and `.github/workflows/` holds only `cf-dry-run.yml` and `pr-checks.yml`.
- **The CLI's use of the bundled Gateway:** `--release`, the bundled tarball,
  and the KV release cache. These are gone for good, not only paused. #294
  made the checkout "the one source of the Gateway", and RELEASE.md:33-36 says
  published versions "need a release identity again … design that when
  publishing resumes".
- **Standalone apps:**
  - SDK semver ranges and a per-app `pnpm-workspace.yaml` with `allowBuilds`.
  - `npx -y everyapp@latest` in app scripts.
  - The npm update check (`version-check.ts`, no longer in the tree).
- **One thing pausing did not remove but standalone copies need:** the root
  `pnpm-workspace.yaml:21-24` security overrides (`jose ^6.2.5`,
  `seroval ^1.6.7`, `tinypool ^2.1.2`). Its own comment says "Standalone clones
  of the apps don't see these" (`:19-20`).
- **No lockfiles:** the apps don't commit a lockfile (`pnpm-lock.yaml` is in
  `apps/todo-app/.gitignore:36` and the template's `.gitignore:37`). A copy
  therefore isn't reproducible, and H24's `pnpm install --frozen-lockfile`
  would fail on it.

### 2.3 The SDK and the Gateway share a wire protocol, and nothing enforces a version floor today

| Surface | Where | Changes planned in the PR series |
|---|---|---|
| Identity, public-marker and system headers; claim shapes; `aud` from `EVERYAPP_APP_ID` | `packages/sdk/src/internal/protocol.ts:20-36` (the Gateway imports the same module) | H2 makes `aud = workerName` and adds an `EVERYAPP_AUDIENCE` binding |
| Tools endpoint `/__everyapp/tools/{list,call}`, body `{"v":1}` | `packages/sdk/src/internal/tools.ts:6-17` (`TOOLS_PROTOCOL_VERSION = 1`) | H21 adds `chan: agent` |
| SDK version reported to the Gateway | `packages/sdk/src/server/tools.ts:39` (`SDK_VERSION = "0.3.0"`, hand-kept), stored in `app_tool_catalogs.sdk_version` (`apps/every-app-gateway/src/db/mcp.schema.ts:30`) | none |
| Gateway binding with props; AI proxy client | `packages/sdk/src/cloudflare/worker.ts:313-325`; `packages/sdk/src/server/gatewayFetch.ts:28-45` | H5/H14 move to `brokerFetch` and `/v1/<provider>/…` |
| Build-time inputs from the CLI | `worker.ts:277-278` reads `.everyapp/deploy.json` | H11 makes it "deploy inputs schema 2" |
| Declared floor | `apps/every-app-gateway/scripts/build-release.ts:29-31` (`MIN_CLI_VERSION`/`MIN_SDK_VERSION = "0.3.0"`) | Checked by nothing since `/api/deploy/whoami` went (`TODO.md:32`) |

In self-host, the Gateway, the CLI and the in-repo apps come from one checkout,
so they agree by construction. A fork built on its own schedule against an
npm SDK breaks that. The hosted Gateway keeps moving with `main`, and an
already-deployed fork Worker isn't rebuilt when it does. H2 alone would break
every fork deployed before it.

### 2.4 Catalog apps are otherwise self-contained, but none is forkable onto hosted as it stands

- **Self-contained:**
  - `apps/todo-app/{tsconfig.json,vite.config.ts,cloudflare.config.ts}` refer
    to nothing outside the app directory.
  - The only workspace dependencies are the SDK and the CLI (§2.1).
  - The beta pins they need are on npm: `@cloudflare/vite-plugin@2.0.0-beta.sha-91c870c02`
    and `cf@1.0.0-beta.14` (latest `1.0.0-beta.17`; `npm view`, 2026-10-15).
- **Not forkable onto hosted yet:**
  - All four manifests declare `kv: ["KV"]`, which hosted refuses (B1; H17
    drops it).
  - Todo declares `durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }]`
    (`apps/todo-app/everyapp.config.ts`), and D3 gives the Verified plan "no
    DOs".
  - Chef declares `providers: ["openai"]` (`apps/chef/everyapp.config.ts`),
    while D6 makes OpenRouter the only metered LLM upstream in hosted v1.
  - OpenSEO runs on the platform tier (D2). Its Workflows, crons and second
    Worker can't run as a dispatch fork (A1, B8).
  - So, as the defaults stand, the only catalog app forkable at launch is the
    workout tracker, after its KV is dropped.

### 2.5 GitHub mechanics (docs.github.com, fetched 2026-10-15)

- **Forks of a public repo stay public.** "Public repository forks are public
  … You cannot change the visibility of a fork by itself"
  ([About permissions and visibility of forks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-permissions-and-visibility-of-forks)).
  A GitHub fork of a public catalog source would publish the org's
  customizations.
- **Template repos break upstream merges.** "A repository created from a
  template starts with a single commit", and branches from a template "have
  unrelated histories", so you can't open pull requests or merge between them
  ([Creating a repository from a template](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template)).
  A template-generated fork has no merge base with upstream.
- **The template API needs a dangerous permission.**
  `POST /repos/{template_owner}/{template_repo}/generate` needs, for GitHub
  Apps, `Administration` (write), `Contents` (read) and "Repository creation"
  (write), with user-to-server or installation tokens
  ([Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps);
  [REST: create a repository using a template](https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template)).
  The same `Administration` (write) permission also grants
  `DELETE /repos/{owner}/{repo}` (same permissions page). If the platform
  GitHub App can create repos, it can also delete every repo it's installed
  on.
- **Upstream sync for a real GitHub fork** is `POST /repos/{owner}/{repo}/merge-upstream`,
  which needs `Contents` (write) (same permissions page).
- **A user can create the empty repo instead.** GitHub pre-fills the new-repo
  form from `https://github.com/new?name=…&owner=…&visibility=private&description=…`
  and silently drops parameters the user isn't allowed to set
  ([Creating a new repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)).
- **Git bundles carry history without a hosted repo.** Git can clone and
  fetch from a bundle file, and "A bundle from a recipient repository's point
  of view is just like a regular repository" ([git-bundle](https://git-scm.com/docs/git-bundle)).
  So a private source with full history can be delivered without any GitHub
  repo.

### 2.6 npm mechanics

- **Trusted publishing (OIDC):**
  - It publishes from GitHub Actions, GitLab CI/CD or CircleCI cloud runners
    without a long-lived token.
  - It needs npm CLI ≥ 11.5.1, Node ≥ 22.14.0, and `id-token: write`.
  - A new trusted-publisher configuration must publish successfully within 2
    days.
  - Provenance is automatic only "when publishing from a public repository".
    "Provenance generation is not supported for private repositories, even
    when publishing public packages."
  - Source: [npm Docs: Trusted publishing](https://docs.npmjs.com/trusted-publishers),
    last edited 2026-10-06.
- **Token changes:**
  - Classic npm tokens were revoked. The deadline was 2025-11-19, and
    reports put the effective date at 2025-12-09.
  - Granular tokens with write access are capped at 90 days
    ([GitHub changelog 2025-11-05](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/);
    [2025-09-29](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)).
  - The old laptop-publish flow therefore needs either a rotating token or
    OIDC.
- **Versions are permanent.** "Once `package@version` has been used, you can
  never use it again". Unpublishing after 72 hours needs no dependents, fewer
  than 300 weekly downloads and a single owner
  ([npm unpublish policy](https://docs.npmjs.com/policies/unpublish)).
- **pnpm rewrites workspace dependencies only when packing.** On `pnpm pack`
  and `pnpm publish` it replaces `workspace:*` with the target's version
  ([pnpm workspaces](https://pnpm.io/workspaces)). In-repo apps can keep
  `workspace:*` while published packages carry real versions.
- **GitHub Packages** needs "an access token to publish, install, and delete
  private, internal, and public packages"
  ([Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)).
  Every developer, every CI job and our Sandbox builder would need a token
  just to install the SDK.
- **pkg.pr.new** publishes per-commit preview tarballs at
  `https://pkg.pr.new/${owner}/${repo}/${package}@{commit}`, needs its GitHub
  App, and works "only in workflows". Its README doesn't say whether private
  repositories are supported ([stackblitz-labs/pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new)).

### 2.7 Comparables and what earlier reports already settled

- **Deploy to Cloudflare buttons** (last updated 2026-10-12):
  - "Cloudflare clones your source repository into the user's GitHub/GitLab
    account": a new repository, not a fork.
  - Source repos "must be public".
  - A subdirectory works only if the app is "fully isolated within that
    subdirectory, including any dependencies". Cloudflare "does not fully
    support monorepos"
    ([Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)).
  - That last rule is our `workspace:*` problem.
- **Cloudflare OS blueprints** carry code but not "SQLite data, conversation
  history, credentials, or connected resources", and updates arrive by an
  agent-run merge (`raw/comparables.md:79`).
- **Val Town remixes** take the remixer's own env (`raw/comparables.md:404-410`).
- **P11** already proposes `everyapp fork <catalog-app>` → a new app row with
  `forked_from` and an empty grant set (`raw/comparables.md:404-418`).
- **Deploy-pipeline Q6:** a fork is "a new app id with fresh resources; data
  import is later" (`raw/deploy-pipeline.md:529-532`).
- **Build report:**
  - G13 offers "resume SDK publishing … or let forks build from the monorepo
    root" (`raw/build-and-deploy-from-github.md:647`).
  - Q6: "forks get an 'upstream release available' notice, later a PR", and
    catalog upgrades never auto-deploy to them (`:720-726`).
- **Autumn:** org apps, "untrusted or forked", get a 2,000-credit monthly cap
  (`raw/autumn-billing-platform.md:700-704`).
- **Comparables Q4:** "Catalog apps and forks always ask in the UI"
  (`raw/comparables.md:523-526`). D8 has since narrowed that: an admin
  deploying their own org app approves inline.

---

## 3. Recommendation

### 3.1 What a fork is (a)

**A fork is an org app whose code starts as a copy of one catalog release and
lives in the org's own git repository.** It isn't an app in our monorepo, and
it doesn't replace the catalog install.

| Property | Fork |
|---|---|
| Code | The org's own repo (their GitHub, or just a local git repo in v1), seeded from the catalog app's **source mirror** at a release tag, with that mirror's history. A real merge base makes upstream updates ordinary merges. |
| Registry | New `apps` row: `source = 'fork'`, `forked_from_release_id` → the catalog release row, `tier = 'dispatch'` always, new app id (catalog ids are reserved per org for catalog installs, so a later install never collides), WfP tag `kind-fork`. |
| Resources and data | Fresh: its own D1 (`every-<orgKey>-<forkId>`), its own DO namespaces, nothing copied. v2 adds **eject in place**, which turns an existing catalog install into a fork while keeping its row, Worker name, D1 and DOs (§3.3). |
| Grants | None until approved. `forked_from` never confers trust: no implicit catalog grants, no `trust:"catalog"` props, no platform tier, no background grants. |
| Plan | Custom code under D3 (not on Free; counts toward Verified's app cap; per-plan dispatch limits, not the catalog's 30 s/10,000). |
| Upgrades | Catalog fan-out never deploys into a fork. v1 shows a notice; v2 opens a PR. |

Forking another org's app, or any public Every App repo (for example
`every-app/open-seo` once it carries a manifest), comes later. The same
`app_sources.upstream_repo`/`upstream_ref` handle it without a registry
lineage row.

Naming collision to avoid: in D9 and H24, "fork PRs" means pull requests from
GitHub forks of an org's repo, not catalog forks. Rename those to "outside
contributor PRs" in the README.

### 3.2 How forks (and every org app) get the SDK and CLI (b)

| Option | Laptop | Org's GitHub Actions | Our v2 Sandbox (npm-only egress) | Updates | Self-host rule kept | Verdict |
|---|---|---|---|---|---|---|
| **A. npm: `@every-app/sdk` + `everyapp`** | yes | yes | yes | `pnpm up`, Renovate/Dependabot, advisories | yes, if the published CLI carries no Gateway release | **Recommend** |
| B. Vendored tarballs in each repo (`file:vendor/every-app-sdk-0.4.0.tgz`) | yes | yes | yes | A custom `everyapp sdk update`; no advisories | yes | Fallback only if the founder won't publish |
| C. Forks inside our monorepo | only us | no (private repo) | needs the monorepo per build | n/a | yes | Fine for our own dogfood forks; impossible for outside orgs |
| D. Each org gets a copy of the whole monorepo (G13's "build from the root") | yes | yes | builds the platform each time | merge our monorepo | yes | Ships them the Gateway source; heavy (580 MB of `node_modules` per app, build report §1.1) |
| E. GitHub Packages | token | token | token injection | ok | yes | Install-time token for public packages (§2.6) |
| F. Tarballs on `everyapp.com` (R2) or pkg.pr.new | yes | yes | needs egress to our host | exact URLs only, no ranges | yes | No semver; private-repo support unknown for pkg.pr.new |

**Recommended v1 (publishing scoped to app developers):**

- **What gets published:**
  - `@every-app/sdk` and the `everyapp` CLI go to npm at **0.4.0**, from a
    GitHub Actions workflow on a `v*` tag, using npm trusted publishing
    (`pnpm pack`, then `npm publish <tgz>` with npm ≥ 11.5.1; see U2).
  - No provenance while the repository is private (§2.6).
  - Mark every `<0.4.0` version deprecated with "can't deploy the current
    Gateway; upgrade".
- **What the published CLI covers:**
  - It carries **no Gateway release**. `setup`, `gateway …` and self-host
    `deploy`/`delete` keep requiring a checkout; `CHECKOUT_MISSING` says "self-host
    runs from a checkout of the repository".
  - Commands that work anywhere: `create`, `fork`, `dev`, `login`,
    `deploy`/`secret`/`status` against hosted, `d1 migrate --local`, and
    `bundle`.
  - The release-identity problem from RELEASE.md:33-36 and cli-redesign §6
    therefore stays deferred. The published CLI never deploys a Gateway.
- **Starter template:** `create` in the published CLI uses a starter bundled
  into the package, as before #276. The bundle step rewrites `workspace:*` to
  `^0.4.0` and writes a standalone `pnpm-workspace.yaml` with the root's
  `allowBuilds` and security overrides.
- **Launcher:** `bin/everyapp.js` stops rebuilding from source when there is
  no `src/` next to it (the published layout).
- **When to publish:** with H12 (the hosted deploy API), before the first
  outside org, not now. Until then our own forks live in `apps/` and deploy
  from the checkout (option C).

**Versioning and compatibility policy:**

1. **One version for both packages (lockstep).** The CLI bundles the SDK's
   `dev`/`internal` code for the local Gateway (`packages/cli/package.json`
   `noExternal`), and the app carries its own SDK copy. Both must speak the
   same protocol. Generate `SDK_VERSION` (`server/tools.ts:39`) from
   `package.json`, or test that they're equal.
2. **Semver.** While in 0.x, a minor bump is breaking (npm's caret:
   `^0.4.0` means `<0.5.0`). Mirrors and the starter pin `^0.4.0`.
   `@every-app/sdk/internal` and `/dev` are platform-internal and outside the
   semver promise; say so in the package README.
3. **One integer `PROTOCOL`** in `@every-app/sdk/internal/protocol.ts` covers
   the headers and claims, `/__everyapp/*` paths, the tools body (fold
   `TOOLS_PROTOCOL_VERSION` into it), the binding surface and the
   `bundle.json` schema. Bump it on any breaking change to those.
4. **Deploy-time floor.**
   - `everyapp bundle` stamps `{sdkVersion, protocol}` into `bundle.json`.
   - The hosted deployer refuses `protocol < MIN_PROTOCOL` with `SDK_TOO_OLD`
     and the rerun `pnpm up @every-app/sdk everyapp`.
   - Self-host `deploy` compares the app's installed SDK with the checkout's
     `MIN_SDK_VERSION`. This closes `TODO.md:32` too.
5. **Runtime promise, only once an outside org exists:**
   - The hosted Gateway serves protocols N-1 and N.
   - Raising the floor requires zero active Workers below it (query the
     stamped `app_versions`). Catalog installs move by fan-out. Forks get a
     30-day notice, then a 503 page that says which SDK to rebuild with.
   - Transitions use dual-valued claims where possible. For example, H2 can
     mint `aud: [workerName, appId]` for one window
     (UNVERIFIED that the SDK's jose check accepts it; see U8).
   - Before the first outside org: no promise, per the founder's
     no-backwards-compatibility rule.
6. **Release order:** publish the SDK and CLI before deploying a hosted
   Gateway that needs them. This generalizes RELEASE.md:50-52's "SDK first".

**How this fits "the checkout is the truth":**

- Self-host doesn't change: Gateway, CLI and in-repo apps still come from one
  checkout.
- In-repo apps keep `workspace:*`. pnpm rewrites it only for the two packages
  it packs (§2.6).
- The published packages serve app code that lives outside the checkout. On
  self-host such code must clear the same `MIN_SDK_VERSION` floor.

### 3.3 `everyapp fork` and the GitHub side (c)

**Source mirrors (catalog CI, alongside H17's bundle publish).** For each
catalog release, CI does the following:

1. Copy `apps/<app>`.
2. Rewrite `workspace:*` to `^<lockstep version>`.
3. Write a standalone `pnpm-workspace.yaml` (the root's `allowBuilds` and
   `overrides`, `pnpm-workspace.yaml:7-24`).
4. Generate and commit `pnpm-lock.yaml` (un-ignore it in the mirror).
5. Add a `LICENSE` and a "This is a fork" README section, and drop
   KV/hosted-refused resources.
6. Commit to `every-app/app-<slug>` as "Todos 1.4.0 from
   private-every-app@<sha>", tag `v1.4.0`, and record `source_repo`,
   `source_tag` and `source_commit` on the catalog release.

The result is linear history, one commit per release. If D13(c) keeps sources
private, serve the same history as a git bundle from
`GET /api/v1/catalog/{slug}/source.bundle` behind org auth (+1 d).

**v1: `everyapp fork <catalog-app> <new-app-id>`** (the CLI only, no GitHub
App):

```
$ everyapp fork todo acme-todo
✓ Todos 1.4.0 cloned into ./acme-todo (remote "upstream": every-app/app-todo, tag v1.4.0)
✓ Registered acme-todo in Acme as a fork of Todos 1.4.0 (pending): https://acme-todo-acmex7k2p.<content domain>
? Approve what Todos 1.4.0 uses for acme-todo (D1, one Durable Object; no metered providers)? Yes
Next: cd acme-todo && pnpm dev
      gh repo create <github-org>/acme-todo --private --source . --push
      pnpm run deploy
```

1. **Check the caller.** It needs the hosted login (H12) and a role that may
   deploy org apps (admin or owner). The plan must allow custom code (D3),
   else `PLAN_REQUIRED {billingUrl}`.
2. **Look up the catalog app.** `GET /api/v1/catalog/todo` returns
   `{forkable, sourceRepo, tag, releaseId, capabilities}`. `forkable` is
   computed at publish: the manifest must pass the dispatch-tier validator,
   so it's false for OpenSEO.
3. **Clone.** `git clone --origin upstream --branch v1.4.0 <sourceRepo>
   acme-todo`, then `git switch -c main`.
4. **Rename.** Reuse `updateEveryappManifestId` and `updatePackageJson`
   (`updateConfiguration.ts:18-98`) and commit "Fork Todos 1.4.0 as
   acme-todo".
5. **Register.** `POST /api/v1/orgs/{org}/apps {appId, forkOf: {catalogAppId,
   releaseId}}` creates the row (`source='fork'`, `forked_from_release_id`,
   `tier='dispatch'`, `status='pending'`). Registering before any deploy
   reserves the slug and keeps lineage server-side, so a manifest can never
   claim it.
6. **Admin prompt (D8 inline approval).** "Approve as upstream" writes grants
   equal to the upstream release's capability set, under the org-app default
   caps. Anything beyond that set stays pending.
7. **Finish like `create`.** Install, `cf workers types`, local migrations
   (`create/index.ts:112-153`).

**Upstream updates in v1.** `everyapp status` inside a fork prints "Todos 1.5.0
is available: `git fetch upstream --tags && git merge v1.5.0`", plus the
capability diff. The control plane shows "Fork of Todos 1.4.0, 1 release
behind". Nothing auto-deploys.

**Self-host variant.** In a checkout, `pnpm everyapp fork todo my-todo` copies
`apps/todo-app` to `apps/my-todo` using `create`'s code with a different
source directory. It records no lineage (0.25 d, optional).

**v2: GitHub-native (after H24 v2's platform GitHub App and Sandbox
builder):**

- **Fork to GitHub from the dashboard** (Catalog → Todos → Fork):
  1. The user creates an empty private repo through a pre-filled link
     (`https://github.com/new?owner=<gh-org>&name=acme-todo&visibility=private`)
     and adds it to the platform App's installation.
  2. The `AppBuilder` sandbox clones the mirror at the tag and pushes to the
     empty repo, with the installation token injected by an outbound handler
     (`Contents: write`).
  3. It writes an `app_sources` row, and the first build and deploy follow
     (H24 v2).
- **The App never asks for `Administration: write`.** Creating repos for the
  user would also let it delete every repo it can see (§2.5).
- **Why not GitHub forks:** a fork of a public mirror is public (§2.5).
- **Why not the template API:** single-commit history, so no merge base; and
  it needs `Administration: write`.
- **Upstream PRs.** For each catalog release, for every fork with an
  `app_sources` row:
  - Push the release commit to `everyapp/upstream-v1.5.0` in the fork's repo
    and open a PR into the production branch (`Pull requests: write`).
  - The fork's history contains the mirror's, so the PR shows only upstream
    changes and GitHub flags conflicts.
  - The PR body carries the release notes and the capability diff ("requests
    `openrouter`; stays pending after merge until an admin approves").
  - An agent-assisted conflict merge, the Cloudflare OS blueprint pattern,
    can come later.
- **Eject in place.**
  - Convert a catalog install into a fork that keeps its app row, Worker name,
    D1 and DO namespaces, so the data stays.
  - The deployer checks that the fork bundle's migrations extend the
    installed release's applied `d1_migrations`.
  - Fan-out upgrades stop.
  - The implicit catalog grants become explicit grants approved by the
    ejecting admin.

### 3.4 Registry, grants and plans (d)

**Registry (extends H7):**

- `apps.source` takes `'org' | 'catalog' | 'fork'`.
- Add `apps.forked_from_release_id` (nullable, references the catalog release
  row: `catalog_releases` in H17, an `app_versions` row with `catalog_app_id`
  in `raw/schema-tenancy.md:471-490`).
- `catalog_app_id` stays install-only. The schema report's partial unique
  `(organization_id, catalog_app_id)` would otherwise forbid a fork next to
  its install.
- Catalog ids are reserved per org in `@every-app/perimeter/registry`.
- WfP tag `kind-fork`.
- `app_versions` stores `sdk_version` and `protocol` from `bundle.json`.

**Grants (D8):**

- A fork is an org app. Its first deploy's `syncAppRequests` records every
  capability as pending (403 `grant_pending {approveUrl}`), unless an admin
  approved "as upstream" at fork time.
- Members may request but not approve.
- Previews get no grants (README defaults).
- Forks don't inherit Every App-set prices for catalog meters. They pay
  provider pass-through times the markup, like any org app (D4).

**Plans (D3, D4):**

- Not on Free.
- Counts toward Verified's custom-app cap.
- Per-plan dispatch limits.
- Default-deny egress with an admin-approved allowlist.
- D4's 2,000-credit monthly cap per org app.
- Its own Autumn entity, so its spend never mixes with the catalog install's.

**Conflict to decide:** todo has a Durable Object and Verified forbids DOs.
Either Verified allows one DO class, guarded by the C6 wall-clock poller with
auto-suspend, or forking the flagship demo requires Paid. Chef can't be forked
(or installed) on hosted until it moves to `capabilities.openrouter` (D6).

**Security fixes upstream:**

- SDK-level fixes are enforceable through the protocol floor (§3.2).
- App-level fixes reach forks only as a flagged release: a dashboard banner,
  an email, and in v2 a PR marked `security`.
- Ops can list forks by `forked_from_release_id` and last deploy date, but
  can't tell whether a fork has merged the fix. Disabling a fork stays a human
  call (D10).

### 3.5 PRs, sizes, and the cost of changing later

| # (provisional) | Title | Contains | Depends on | Size |
|---|---|---|---|---|
| H27 | **Publish the SDK and the app-developer CLI** | Drop `private`. Restore the SDK `prepack`. CLI `prepack` = build + bundled starter (rewritten deps, standalone workspace file with overrides); no Gateway bundle. Launcher runs `dist/` when there's no `src/`. Self-host commands keep `CHECKOUT_MISSING` with new words. `.github/workflows/publish.yml` (tag `v*`, `id-token: write`, npm ≥ 11.5.1, `pnpm pack` then `npm publish`). Lockstep version 0.4.0 and the generated `SDK_VERSION`. Deprecate `<0.4.0`. Restore the npm update check for the published CLI. RELEASE.md rewritten. Root README "An app in its own repository" uses `^0.4.0`. | H12 (timing only) | 2 |
| H28 | **Protocol version and SDK floor** | `PROTOCOL` in `internal/protocol.ts`. `bundle.json` stamps `sdkVersion`/`protocol`. The hosted deployer refuses below the floor (`SDK_TOO_OLD`). Self-host `deploy` checks `MIN_SDK_VERSION` (closes `TODO.md:32`). `app_versions.sdk_version`/`protocol`. A test that pins the protocol module's exports to `PROTOCOL`. | H11 | 1 |
| H29 | **Catalog source mirrors** | The CI step above; `every-app/app-<slug>` repos (or the bundle endpoint); `source_repo`/`source_tag`/`source_commit` on releases; `forkable` computed at publish. | H17, D13 | 1.5 |
| H30 | **`everyapp fork` and `forked_from`** | CLI command (shares `create`'s steps). `GET /api/v1/catalog/{slug}`. `POST …/apps` with `forkOf`. `source='fork'` and `forked_from_release_id`. Catalog ids reserved per org. "Approve as upstream". Upstream notice in `status` and the control plane. `kind-fork` tag. Self-host copy variant. | H7, H12, H14, H29 | 2 |
| H31 | **Fork to GitHub and upstream PRs** (v2) | Pre-filled repo link. Install-selection check. `AppBuilder` push job. `app_sources.upstream_repo`/`upstream_ref`. A Queue job per release that opens `everyapp/upstream-v<x>` PRs with the capability diff. Security-flagged releases. | H24 v2, H30 | 4 |
| H32 | **Eject in place** (v2) | Convert an install to a fork, keeping the row, Worker, D1 and DOs. Migration-prefix check. Fan-out exclusion. Implicit grants become explicit. | H17, H30 | 2 |

- **Sizes:**
  - v1 = H27-H30, about **6.5 d**.
  - v2 = H31-H32, about **6 d**.
  - The first outside org needs **H27 and H28** even if nobody forks (+3 d
    to README §5's ~40 d), because `create` and the GitHub Action can't work
    without them.
- **Cost of changing later:**
  - **The fork model.** Lineage columns plus a new app id make eject in place
    purely additive (cheap). Moving forks into our monorepo later is
    impossible for outside orgs.
  - **Publishing.** Once outside orgs build on `^0.4`, every breaking protocol
    change pays for the N-1 window or a forced-upgrade campaign, and npm
    versions can never be reused (§2.6). Switching to vendored tarballs later
    means editing every fork's `package.json` (moderate). Not publishing means
    no outside org can build any app.
  - **Mirror visibility.** Public mirrors are irreversible: copies exist the
    moment they're public. Starting private (git bundle) and opening up later
    is cheap.

---

## 4. Exact README.md edits

1. **§3, Tier B: add B9 after B8.**
   > **B9. Nothing outside this repository can build an app, and forks have no mechanics.** Verdict: `verified` in code (`packages/{sdk,cli}/package.json:3` private; catalog apps and the starter on `workspace:*`; `create` links the checkout by path, `updateConfiguration.ts:11-48`; `checkoutRoot()` throws outside a checkout). npm's `latest` is 0.2.x, which can't deploy this Gateway and predates #267-#271. This blocks every org app (laptop, GitHub Action, v2 Sandbox builder), not only forks. Smallest change: publish `@every-app/sdk` and an app-developer `everyapp` (no Gateway release in it, so self-host stays checkout-only) at 0.4.0 via npm trusted publishing; a `PROTOCOL` integer with a deploy-time SDK floor; a fork = a new org app seeded from a per-app source mirror with history, `source='fork'`, `forked_from_release_id`, zero grants. Size: 3 d (publish + floor), 3.5 d (mirrors + `everyapp fork`). See `raw/r2-forks-and-sdk-publishing.md`.
2. **§4: add D13 after D12.** Use the text in §5 below.
3. **§4 D3: append.**
   > Forks of catalog apps are custom code. Note the conflict: todo declares a Durable Object (`UserSyncDO`), so under this default a todo fork needs Paid. Alternative: Verified allows one DO class, guarded by the C6 wall-clock poller.
4. **§4 D8: append.**
   > A fork of a catalog app is an org app: it gets no implicit grants. At `everyapp fork`, an admin may "approve as upstream" (grants equal to the forked release's capability set, under org-app caps); anything new stays pending.
5. **§4 D9: append.**
   > v1 needs `@every-app/sdk` and `everyapp` on npm (D13): without them no org repo, laptop or Action outside our checkout can build. Rename "fork PRs" to "outside-contributor PRs" here and in H24, so they aren't confused with catalog forks.
6. **§4 "Defaults we will take": add bullets.**
   > - `apps.source` ∈ `org | catalog | fork`; forks carry `forked_from_release_id`, always `tier='dispatch'`, WfP tag `kind-fork`; catalog ids reserved per org for installs.
   > - Catalog fan-out never deploys into forks; forks get a notice (v1) or an upstream PR (v2).
   > - SDK and CLI share one version; one `PROTOCOL` integer; `bundle.json` stamps both; the hosted deployer refuses bundles below the floor.
   > - The published CLI carries no Gateway release; `setup`/`gateway *`/self-host `deploy` stay checkout-only.
7. **§5 H7 "Contains": change**
   `` `apps` gains `tier='platform'`, `source`, `catalog_app_id`, `` **to**
   `` `apps` gains `tier='platform'`, `source` (`org|catalog|fork`), `catalog_app_id` (installs only), `forked_from_release_id`, ``
8. **§5 H11 "Contains": change**
   `` `bundle.json` (evaluated manifest, versions, source) `` **to**
   `` `bundle.json` (evaluated manifest, `sdkVersion`, `protocol`, source) ``
9. **§5 H17 "Contains": append**
   > `forkable` computed at publish (dispatch validator); `source_repo`/`source_tag`/`source_commit` per release (H29).
10. **§5 H24.**
    - "Depends on": change `H12 (v1)` to `H12, H27 (v1)`.
    - "Contains": change `single platform GitHub App (write permissions, events, …)` to `single platform GitHub App (Contents, Pull requests, Checks and Deployments write; never Administration, which can delete repos; events, …)`.
    - Replace "fork PRs run `--dry-run`" and "fork approval gate" with "outside-contributor PRs …".
11. **§5: add rows H27-H32** from §3.5 of this report, renumbered if other round-2 reports also add rows.
12. **§5 "Totals": append**
    > Forks and publishing add about 6.5 d (v1: H27-H30) and 6 d (v2: H31-H32).
13. **§5 "The first outside org": change**
    "H16 (egress and limits) and the takedown in H10: roughly 40 d" **to**
    "H16 (egress and limits), H27-H28 (SDK and CLI on npm with a version floor) and the takedown in H10: roughly 43 d".
14. **§6: add rows R24-R27** (the live checks in §6 below: U1/U2, U3, U4/U5, U8).
15. **§1 diagram, line 122: change**
    `producers: `everyapp deploy` (CLI) ·` **to**
    `producers: `everyapp deploy` (CLI, SDK + CLI from npm) ·`

Outside README.md, under the repo's rule of tracking open decisions in
`TODO.md`: narrow `TODO.md:74` "Publish again" to "Publish `@every-app/sdk` and
the app-developer `everyapp` with H12 (D13); the public repository sync is no
longer a prerequisite (source mirrors replace it)".

---

## 5. New founder decision

**D13. Forks and publishing: what is a fork, where does its code live, and do
we publish the SDK and CLI again?**

- **Why it matters:**
  - Nothing outside our private checkout can build an Every App app, so no
    outside org can run `create`, a GitHub Action or our future builder.
  - A fork also needs a source to copy, a way to take upstream fixes, and
    rules for data, grants and plans.
- **Options:**
  - (a) Forks live in the org's own repo, seeded from a per-app source mirror
    with history, and get the SDK and CLI from npm.
  - (b) As (a), but the source arrives as a private git bundle and the SDK as
    a tarball vendored in each repo.
  - (c) Forks live in our monorepo: works only for us.
  - (d) Each org gets a copy of the monorepo.
- **Default: (a).**
  - **Fork:** new app id, fresh resources, no data; eject in place keeps data
    in v2.
  - **Grants:** zero, with an admin "approve as upstream" shortcut.
  - **Plans:** forks are custom code under D3.
  - **Upgrades:** catalog upgrades never deploy into forks (notice in v1, PR
    in v2).
  - **Mirrors:** `every-app/app-<slug>` public and MIT for todo, chef,
    workout and the starter. OpenSEO is already public and MIT.
  - **Publishing:** `@every-app/sdk` and `everyapp` on npm at 0.4.0 in
    lockstep, via trusted publishing, timed with H12 rather than now; 0.2.x
    deprecated; protocol floor enforced at deploy.
  - **Self-host:** stays checkout-only; the published CLI carries no Gateway
    release.
- **Cost to change:**
  - Fork-model details are additive.
  - Publishing commits us to a protocol-compatibility window once outside
    orgs build, and versions are permanent.
  - Public mirrors can't be un-published.
  - Not publishing blocks every outside org app.

Sub-questions:

- **D13(c): public or private catalog sources?** Default: public mirrors.
  Choose private (git bundle served behind org auth, +1 d) if catalog app
  code should stay closed. That can be opened later.
- **D13(d): can a Verified org run one Durable Object class** (so todo is
  forkable without Paid)? Default: yes, one class, guarded by the C6 usage
  poller with auto-suspend at about 10× the plan.

---

## 6. UNVERIFIED items and the live check that settles each

| # | Unverified | Live check | If it goes the wrong way |
|---|---|---|---|
| U1 | Trusted publishing works from the private `every-app/private-every-app` for public packages (docs imply yes, without provenance) | Add a trusted publisher to both packages for `.github/workflows/publish.yml`; publish `0.4.0-rc.0` under dist-tag `next` within the 2-day window | A granular write token (≤ 90 days) in a repo secret, rotated; or publish from a public mirror of `packages/` |
| U2 | `pnpm publish` itself does OIDC trusted publishing (not checked); the plan avoids relying on it | Same run: `pnpm pack`, then `npm publish <tgz>` with npm ≥ 11.5.1; also try `pnpm publish` | Keep pack-then-npm |
| U3 | A standalone copy of a catalog app builds and runs `everyapp dev` with packed packages (configs read; not built) | `pnpm -C packages/sdk build && pnpm -C packages/sdk pack`; pack the CLI; copy `apps/todo-app` to `/tmp`, replace `workspace:*` with `file:` tarballs, add the overrides, then `pnpm install && pnpm run build && pnpm dev` | Fix the hidden coupling before H27 (+0.5 d) |
| U4 | A platform GitHub App installed on "selected repositories" can push to an empty repo the user creates and adds; on "all repositories" new repos are covered automatically | Use the PR #281 POC app on a test org | Ask for the "all repositories" install, or fall back to the v1 CLI path |
| U5 | The pre-filled `github.com/new?owner=<org>&visibility=private` link lands on the org owner for users who may create repos there (docs say invalid parameters are dropped silently) | Try it as an org member without repo-creation rights | Tell the user to pick the owner manually |
| U6 | The npm account `bensenescu` controls the `@every-app` scope and can add trusted publishers and a second maintainer | `npm access list packages @every-app`; npm org settings | Move both packages to an npm org with two owners first |
| U7 | pkg.pr.new supports private repos (README silent) | Not needed for the default | n/a |
| U8 | The SDK's jose verification accepts an array `aud` containing the expected audience (dual-audience transition) | Unit test: mint `aud: [workerName, appId]` with `protocol.ts` minters; verify with `everyApp()` | Transitions need a two-key window or a forced upgrade |
| U9 | Workers for Platforms accepts `kind-fork` among a script's 8 tags with the `org-*`/`app-*`/`plan-*` tags | Upload a test script with four tags in H0 | Encode fork-ness in `kind-*` values only (already the plan) |
| U10 | `cf` 1.0 beta Build Output stays stable enough for forks built weeks apart (R19) | Pin `cf` in mirrors; the deployer checks `buildOutputVersion` from `bundle.json` | Add Build Output version to the protocol floor |

Sources (fetched 2026-10-15):

- GitHub Docs:
  - [About permissions and visibility of forks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-permissions-and-visibility-of-forks)
  - [Creating a repository from a template](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template)
  - [Creating a new repository (URL parameters)](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)
  - [REST: create a repository using a template](https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template)
  - [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
  - [Working with the npm registry (GitHub Packages)](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
- npm Docs:
  - [Trusted publishing](https://docs.npmjs.com/trusted-publishers) (edited 2026-10-06)
  - [Unpublish policy](https://docs.npmjs.com/policies/unpublish)
- GitHub changelog:
  - [2025-11-05 classic token creation disabled](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/)
  - [2025-09-29 npm auth changes](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)
- [pnpm workspaces: publishing workspace packages](https://pnpm.io/workspaces)
- [git-bundle](https://git-scm.com/docs/git-bundle)
- [Cloudflare: Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) (updated 2026-10-12)
- [stackblitz-labs/pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new)
- npm registry (`npm view @every-app/sdk`, `npm view everyapp`, `npm view cf`, `npm view @cloudflare/vite-plugin@2.0.0-beta.sha-91c870c02`), 2026-10-15
- `gh repo view every-app/every-app`, 2026-10-15
