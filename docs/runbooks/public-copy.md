# The public copy

The public repository, `every-app/every-app`, gets the launch tree as **one
fresh commit**, never this repository's history (docs/launch-2026-10-27.md,
A1 and B9). The history carries a research folder with a home address, old
versions of TODO.md, worktree paths, and a Cloudflare token for an
onboarding-loop test account that was committed as `1k` in #488 and removed
in #496. A copy of the tree carries none of that; a flip of this repository
to public, or a push of its history, would carry all of it, and history can't
be scrubbed after the fact.

`scripts/public-copy.mjs` builds the copy. `scripts/public-copy/policy.mjs` is
the policy: what is left out, what is rewritten, what fails the build. The
names that must never travel are in `scripts/public-copy/private.txt`, which
the copy itself leaves out.

## The one command

From this checkout, on any branch:

```sh
pnpm public-copy
```

That is a dry run of `origin/main` (fetched first): it builds the copy in a
temporary directory, runs every check, prints the report below with the tree
hash the copy would have, and removes the directory. Nothing is written or
pushed. When every check says `ok`:

```sh
pnpm public-copy --write
```

writes the repository to `../every-app-public` (beside this checkout; `--out
<dir>` for elsewhere). Open it, `git log` shows one commit, `git ls-files`
shows the tree. Then, by hand, with the target remote as the argument:

```sh
pnpm public-copy --push git@github.com:every-app/every-app.git
```

`--push` builds and writes the copy again (so what is pushed is what was just
checked), asks you to type `push`, then pushes the one commit to that remote's
`main` with `--force`: whatever the remote has on `main` is replaced. Only the
public repository's URL is accepted (https or ssh) unless `--any-remote` is
given as well, and a remote whose name says private is refused whatever the
flags. There is no flag that skips the typed word.

After the push, on GitHub: make `main` the default branch, flip the repository
public, delete the old tags from the 2026-08-01 copy (`git push <url>
--delete gateway-v0.1.13`, and the others `git ls-remote --tags <url>` lists),
turn on private vulnerability reporting (Settings → Code security; SECURITY.md
and the threat model promise it), set "Require approval for all external
contributors" under Actions, and add the `ANTHROPIC_API_KEY` secret the
security review workflow reads.

## What the report should say

```
Public copy of origin/main (2a660671dd4f, 2026-10-24T…)

Left out:
    1  the list of private names this script scrubs: the list itself stays home
    2  worktree tooling of the maintainers' checkout
    0  overnight build logs (launch doc B9)
    0  the unpublished internal docs (launch doc G)
    0  local overrides (*.local, settings.local.json)
    1  research synthesis, not a design (--design designs)
    2  dated operations logs of the maintainers' own account and gateway (--logs drop)
Scrubbed (22 private-name rules):
  TODO.md: 7× a link into the private repository's history, …
  docs/design/2026-10-teams.md: …
Citations of a document left out, now plain text:
  TODO.md: 8
  docs/hosted-vision.md: 2
  …
Checks:
  ok   no file on the deny list (1k, accounts.json, providers.env, .dev.vars, *.pem, …)
  ok   the private-names file does not travel
  ok   LICENSE is present and MIT
  ok   README gives the public clone URL and everyapp.com, and links no private repository
  ok   every text file reads as text (nothing hides in a binary-looking one)
  ok   no secret shapes or private names in the tree
  ok   every file of the copy is in its commit

Tree   <40 hex>  (1234 files)
Commit <40 hex>
Dry run: nothing written. Add --write to keep the repository.
```

The tree hash is the copy's identity. The same source commit gives the same
tree hash and the same commit hash every run: the commit is dated as the
source commit, authored as `Every App <noreply@everyapp.com>` (never the
source commit's author), and its message holds nothing of the source but the
commit's id, so running the script twice, or on another machine, is the same
copy. A `FAIL` line names the file and the line; the
script exits 1 and writes nothing. `--json` prints the same report as JSON.

The "0" lines are expected: the overnight logs and the internal docs were
deleted from the tree before the script existed, and no `*.local` file is
tracked. They stay in the policy so a future one never travels.

## What is left out, and why

| Left out                                               | Why                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/public-copy/private.txt`                      | The list of private names the script scrubs. Publishing the list would publish the names.                                                           |
| `.worktreeinclude` (root and gateway)                  | Tooling of the maintainers' worktrees.                                                                                                              |
| `docs/overnight/**`, `landing-page/content/internal/**` | Overnight build logs and the unpublished internal docs (launch doc B9, G). Nothing tracked today; the rules stay.                                   |
| `*.local`, `settings.local.json`                       | Local overrides.                                                                                                                                    |
| `docs/design/*research*.md`                            | Research syntheses are notes, not designs (`--design designs`, the default). `--design all` keeps them; `--design none` drops all of `docs/design`. |
| `docs/launch-2026-10-27.md`, `docs/simplify-2026-10-24.md` | Dated operations logs: the state of everyapp.team, the maintainers' account (its Access team, its two-factor posture, the old Workers still answering), what was deleted and why. Candid is fine (B9); a target map of the maintainers' account is not. `--logs keep` keeps them, scrubbed. |

Everything else travels: the code, the user and agent docs, the runbooks,
the threat model and its invariants, the five designs, the ADRs, the
workflows, the onboarding loop, and TODO.md (scrubbed, below). `git archive`
exports the commit's tracked files only, so nothing ignored or untracked
(`.dev.vars`, `.env`, `node_modules`, a stray file in a worktree) can travel.

A citation of a document left out, in any Markdown file of the copy, becomes
plain text: a Markdown link to it keeps only its link text, and its path in
backticks loses the backticks. The docs drift test
(`packages/cli/src/docs/repoDocs.test.ts`, every cited path exists) keeps
passing in the copy, and a reader isn't sent to a file that isn't there. The
report lists each file it touched.

## What is rewritten

The scrub rules apply to the planning documents only: `TODO.md`, `docs/**/*.md`
and `adr/**/*.md`. Code and the public docs under `landing-page/content` must
already be clean; the deny check (below) fails the build when they aren't,
which is how a teammate's name was found in an agent docs page on 2026-10-24.

- The private repository names and links (`private.txt`): a link into the
  private repository's history becomes its text plus "(removed from the tree;
  the maintainers' history has it at `<sha>`)"; the private repository's name
  becomes "the maintainers' private repository"; the scratch copies of the
  ported apps become "the OpenSEO port", "the agentic-inbox port" and so on;
  paths on the maintainer's machine become "a local checkout"; a teammate's
  first name becomes "a teammate".
- E-mail addresses become "an e-mail address", except role addresses
  (`support@`, `hello@`, `security@`, `info@`, `noreply@`), the examples
  (`example.com`, `acme.com`, `.example`, `.test`, `.localhost`) and GitHub's
  no-reply addresses.

`--todo replace` ships `scripts/public-copy/TODO.public.md`, a one-page public
TODO, instead of the scrubbed TODO.md. The default is the scrubbed file,
because B9 says candid is fine and only the names and ids are not ours to
publish. Whether that stays the default is Ben's call (TODO.md, "Public copy
(2026-10-24)").

## What fails the build

- A file whose name only ever holds credentials: `1k`, `accounts.json`,
  `providers.env`, `.dev.vars*`, `.env*` (not `.example`), `*.pem`, `*.key`,
  `id_rsa`, `secrets.env`, `.npmrc`, `.netrc`, `credentials.json`. This check
  runs on everything the commit holds, before any exclusion, so such a file
  never leaves quietly under a `*.local` name either.
- A secret shape in any text file: a Cloudflare account token (`cfat_…`) or a
  40-character token beside the word token, an Anthropic, OpenAI or OpenRouter
  key, a GitHub, Slack or AWS key, a private key block (except the documented
  dev keypair in `packages/sdk/src/dev/keypair.ts`), a `BETTER_AUTH_SECRET`
  with a value, a setup link token, a signed token outside the tests. An
  obvious stand-in (a run of one character, the alphabet, the digits, the
  words fake, test, sample, example) is excused; the private names never are.
- A link into a private GitHub repository, a T3 thread link, the maintainer's
  home directory, or any of the private names, anywhere in the copy.
- No LICENSE, or a README that doesn't give the public clone URL and
  everyapp.com, or links a private repository.
- A file that should be text (Markdown, JSON, TypeScript, …) but reads as
  binary, or a file of the copy that its commit doesn't hold.

`pnpm public-copy --self-test` builds a small tree with one file per
deny-listed name and one string per secret shape, with values no allowlist
excuses, and proves every one is refused and a clean file passes. The CI job
runs it before the dry run. The private names are not part of it (the public
repository has no list of them), so it proves the generic checks, not the
list; the dry run of this repository proves the list.

`--scan` adds a gitleaks pass over the copy with
`scripts/public-copy/gitleaks.toml` (the default rules plus the shapes above),
and needs a `gitleaks` binary on `PATH` or in `$GITLEAKS`
(https://github.com/gitleaks/gitleaks/releases; it is not a dependency of
this repository). The same job runs on every pull request as "Public copy dry
run" (`.github/workflows/pr-checks.yml`): a new secret shape, a private name
outside the scrubbed documents or a deny-listed file fails the PR before any
copy is made. In the public repository the private-name file is absent, so
that CI runs the generic checks only.

## Verify the copy builds from nothing

Once, before the push, from a clean machine or a temporary directory, with
Node 22.18+ and pnpm:

```sh
git clone ../every-app-public /tmp/every-app-check && cd /tmp/every-app-check
pnpm install --frozen-lockfile
pnpm types:check
pnpm -C packages/cli test
pnpm -C packages/cli exec vitest run src/docs
pnpm -C apps/every-app-gateway build:release
EVERYAPP_CF_DRY_RUN=1 pnpm -C packages/cli exec vitest run src/lib/cfDryRun.test.ts
```

Every step passed on 2026-10-24 for the copy of main at that night's commit
(the install took 13 seconds with a warm store; the CLI suite is about 1,100
tests). The copy has no `link:` or `../` dependency: the starter and the
workspace packages use `workspace:*`, and `pnpm-lock.yaml`'s importers all
point inside the tree.

## Scan this repository's history

The copy carries no history, but what the history holds decides what must be
rolled. With the same gitleaks binary, and trufflehog if you have it:

```sh
gitleaks git . --log-opts="--all" --config scripts/public-copy/gitleaks.toml --no-banner --redact=70 \
  --report-format json --report-path /tmp/gitleaks-history.json
trufflehog git file://"$PWD" --json --results=verified,unknown,unverified > /tmp/trufflehog-history.jsonl
```

What they found on 2026-10-24, and what to expect again:

- `1k` in commits 6ed7fa47, 1696bda9 and 424f92dd: the `cfat_` token of the
  loop's first test account, with that account's id and zone. Both scanners
  flag it. Trufflehog could not verify it, which proves nothing: account-owned
  tokens don't verify at the user endpoint it tries. Roll it (sign in as the
  test user, Manage Account → Account API Tokens → Roll). The copy has no `1k`
  and refuses one.
- `docs/research/**` (deleted in #433): high-entropy strings in pasted
  changelogs and a research JSON. Not secrets.
- The tests' fakes (`test-secret-…`, `0123456789…`, `est_AAAA…`, `sk-ant-api03-abcdef…`)
  and the documented dev keypair. Not secrets.
- Nothing verified, nothing else.

## Doing it again

The script is idempotent. Run it after every merge to `main` you want public:
`--write` replaces an earlier copy at `--out` (it refuses a directory it
didn't write: one commit, the script's marker, no remotes), `--push` replaces
`main` on the remote. The public repository
has no history to keep, so a replaced `main` loses nothing; forks and clones
made in between will have to re-clone, which is one more reason to publish
the launch commit once and move to ordinary pushes of the public repository
after launch.
