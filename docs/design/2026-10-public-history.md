# Publishing the whole history (2026-10-25)

Ben's ruling (2026-10-25): the whole commit history goes public unless something in
it is a security issue; secrets get rolled if they aren't already; Ben's and
Carter's addresses are fine, customer addresses are not. This page is the scan of
that history and the two ways to publish. Nothing has been pushed.

## What would be published

- Only `main`: 728 commits, 2025-11-13 → today. Side branches, PR refs and
  checkpoint refs stay private (they are never pushed).
- `every-app/every-app`'s `main` (1e71f113, 2026-08-02) is **already an ancestor**
  of our `main`: its 259 commits are our first 259. Publishing is a
  fast-forward of 469 commits, no force-push.
- All 47 old tags there (`gateway-v0.0.1` … `gateway-v0.1.13`, `gateway-latest`)
  point at commits inside our `main`. They advertise releases that no longer work.
- The public repo also has 5 stale branches, 5 old PRs and 1 issue (all Ben's),
  and no Actions secrets.

## How it was scanned

Fresh `--single-branch` clone of origin `main` (scratch in `/tmp/ea-public-history`):

- `gitleaks git --redact -v .`: 66 findings.
- `trufflehog git file://. --only-verified`: 0 verified.
- `trufflehog git file://.` (unverified): 20 findings.
- Own greps over `git log -p` of every commit: `sk-ant/sk-proj/sk-or`, `ghp_/gho_/github_pat_`,
  `npm_`, `xox?-`, `sk_live/rk_live`, `re_`, `phc_/phx_`, `AKIA`, `AIza`,
  `cfut_/cfat_/cfkt_`, PEM blocks, `GOCSPX-`, `whsec_`, JWTs, `Basic` auth,
  `password = "…"`, Slack/Discord webhooks, Google client ids, GitHub app ids;
  files ever added named `.env*`, `.dev.vars*`, `accounts*.json`, `secrets.env`,
  `*.pem`, `*.key`, `.npmrc`, `1k`.
- Screenshots (289 images in history) spot-checked: the UI-review and briefing
  shots are the seeded local Gateway (`Acme Corp`, `@example.com`, `xxxx`-padded
  tokens); the 2025 ones are the workout tracker.

## Secrets

| Hit                                                                                                            | Commits                                    | Real?                                                                   | Status                                   |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------- |
| `1k`: test account `loop-1` Cloudflare token (`cfat_…`), account id, zone                                      | added #488 6ed7fa47, removed #496 af92cadb | Real                                                                    | **Rolled by Ben (dead).** Nothing to do. |
| `BETTER_AUTH_SECRET`, `SECRET`, `TOKEN`, `api-token:0123…` in ~50 test files                                   | many                                       | Test fixtures                                                           | Fine                                     |
| `DEV_PRIVATE_KEY_PEM` in `packages/sdk/src/dev/keypair.ts`                                                     | 895816c9                                   | Public by design (dev-only, gated by `EVERYAPP_DEV` and the dev issuer) | Fine                                     |
| `sk-ant-api03-fake…`, `GOCSPX-fake…`, `whsec_Zm9yLXRoZS10ZXN0…`, `loop-pw-9f8e…`, `418270391547-fakeclientid…` | tests, setup-skill scenarios               | Fakes                                                                   | Fine                                     |
| Postgres URIs, `NpmToken`, `GCP`, `URI` (trufflehog)                                                           | docs and tests                             | Placeholders (`user:pass@host`), Microsoft's public tenant id           | Fine                                     |
| `CloudflareApiToken` in `cli/src/lib/cloudflare-auth.ts`                                                       | f2f8c079 (initial commit)                  | Wrangler-style OAuth reader, no token                                   | Fine                                     |
| `.env.example`, `.dev.vars.example`                                                                            | various                                    | Empty values                                                            | Fine                                     |

**Roll list: empty.** The only real credential ever on `main` is the `1k` token,
already rolled.

## Other sensitive content

| What                                                                                                                                                        | Where                                               | Security issue?         | Note                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ben's and Carter's addresses (`bensenescu@gmail.com`, `ben@openseo.so`, `carter@openseo.so`, `ben@hi.openseo.so`, `ben@everyapp.dev`), commit author emails | TODO, research, commits                             | No                      | Ben ruled fine                                                                                                                                                                     |
| Customer / third-party addresses                                                                                                                            | none found                                          | —                       | Every other address is a fixture (`@acme.com`, `@example.com`, `@x.co`…), a vendor's support address (`support@monid.ai`, `support@dataforseo.com`), or `i@izs.me` in the lockfile |
| Street address (34 Harding Street, Cambridge)                                                                                                               | `docs/research/` and TODO, removed in #433 f21f674f | No                      | Already printed in OpenSEO's public Terms. Ben's call if it reads as a home address                                                                                                |
| Ben's Cloudflare account id `23bc28f0…` ("Bensenescu@gmail.com's Account")                                                                                  | research, TODO, guards in code                      | No                      | Not a secret (in every dashboard URL); it is also in the current tree as `FORBIDDEN_ACCOUNT_IDS`                                                                                   |
| Test account `loop-1` id `3a47e2e9…`, zone `agentonboard.dev`, team `everyapp-loop1`                                                                        | `1k`, loop docs                                     | No                      | Token rolled                                                                                                                                                                       |
| D1 and KV ids (13 each) of the old Workers                                                                                                                  | TODO.md revisions                                   | No                      | Ids need a token to use; the Workers were deleted 2026-10-24                                                                                                                       |
| Access app/policy ids                                                                                                                                       | only truncated (`66f98c9e…`)                        | No                      | —                                                                                                                                                                                  |
| `enforce_twofactor: false` on the account behind everyapp.team                                                                                              | launch doc, TODO                                    | **Posture, not a leak** | Turn on two-factor enforcement for the account (Ben's own login likely has 2FA already). Worth doing before the history says it                                                    |
| Private repo names (`private-every-app`, `open-seo-everyapp`, `*-everyapp` ports, `private-open-crm`…)                                                      | TODO, docs, runbooks                                | No                      | Readers see names of repos they cannot open                                                                                                                                        |
| Local paths (`/Users/bensenescu/…` ×198, `/tmp/ea-*`)                                                                                                       | TODO, logs                                          | No                      | Cosmetic                                                                                                                                                                           |
| `thecomeup.cc`, `*.bensenescu.workers.dev`, `every-graham`/`every-julia`/`every-winery` Worker names                                                        | TODO, logs                                          | No                      | Workers deleted 2026-10-24                                                                                                                                                         |
| Dated logs (`docs/overnight/`, `docs/launch-2026-10-27.md`, `docs/simplify-2026-10-24.md`), Autumn sandbox org name, research syntheses                     | history (some still in tree)                        | No                      | Candid internal planning, plus the Sunday checklist against everyapp.team                                                                                                          |
| Threat-model register with open gaps (#722, scan findings 3 and 4)                                                                                          | tree                                                | No more than option B   | Both options publish the current threat model                                                                                                                                      |
| Commit subjects end in private PR numbers `(#433)`                                                                                                          | every squash commit                                 | No                      | GitHub autolinks them to `every-app/every-app`'s own `#433`, which is a 404 or a different PR. Cosmetic                                                                            |

**The cost, plainly:** history publishes every revision of TODO.md (candid notes,
"held for Ben" items, the decisions as they were argued), every dated log, the
deleted research folder (pricing research, hosted-platform plans, the Autumn
sandbox, the street address), and the threat model's earlier, less-fixed states
with dates. None of it is exploitable. Whether that candour is the point is Ben's
call; his ruling says it is.

## Tonight (2026-10-26)

Re-scanned at `main` f0cc2660 (#805), then the seven commits after it through
607ef43b (no leaks): 789 commits, gitleaks 66 and trufflehog 20 unverified (the
same findings as above, nothing new), 0 verified. `every-app/every-app` `main`
(1e71f113) is still an ancestor: the push is a fast-forward (540 commits at 607ef43b). The
app repos are unchanged since their scan (`private-open-crm` a1c76d34,
`private-open-analytics` d4baf103, `private-open-mail` `everyapp` 6ed2e87c).

The public repo also has **48 GitHub releases** (`gateway-v0.0.1` …
`gateway-v0.1.13`, `gateway-latest`), and v0.1.13 is marked Latest. Deleting
only the tags would leave those releases up as drafts. `gh release delete --cleanup-tag`
removes each release with its tag. Ben runs every step:

0. Cloudflare dashboard: enforce two-factor on the account behind everyapp.team.
1. The app repos: the commands in [2026-10-app-repos-public-history.md](2026-10-app-repos-public-history.md#push-commands-ben-runs-these).
2. The platform: Option A below, from a clean clone.
3. The rc.6 Gateway release, after step 2's push, tagged at the commit step 2
   pushed (`main`'s head then). rc.6 on npm is published from the same head, so
   the Gateway release, the npm packages and the public repo are one commit:

```sh
git tag gateway-v0.3.0-rc.6 main   # in step 2's clone; check `git rev-parse main` = the pushed head
git push git@github.com:every-app/every-app.git gateway-v0.3.0-rc.6
gh run watch -R every-app/every-app $(gh run list -R every-app/every-app --workflow gateway-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
curl -sIL -o /dev/null -w '%{http_code}\n' https://github.com/every-app/every-app/releases/download/gateway-v0.3.0-rc.6/every-app-gateway-release.tar.gz   # 200
```

rc.6 is a prerelease, so `/releases/latest` answers 404 until a stable tag
exists; the CLI asks for its own version's tag first.

## Option A: publish full history (recommended)

The roll list is empty, so A. From a clean clone of origin `main`:

```sh
git clone --single-branch --branch main git@github.com:every-app/private-every-app.git ea-public && cd ea-public
gitleaks git --redact . && trufflehog git file://. --only-verified --fail   # re-run on the exact commit
PUB=git@github.com:every-app/every-app.git
git fetch $PUB main && git merge-base --is-ancestor FETCH_HEAD main && echo fast-forward
git push $PUB main:main                     # fast-forward; --force only if the check above fails
gh release list -R every-app/every-app --limit 100 --json tagName --jq '.[].tagName' | xargs -n1 gh release delete -R every-app/every-app --cleanup-tag -y   # 48 old releases and their tags
git ls-remote --tags $PUB | awk '{print $2}' | grep -v '\^{}' | sed 's#refs/tags/##' | xargs git push $PUB --delete   # any tag left without a release
for b in 2510_change_repo_name 2510_update_landing_page 2510_update_tanstack_db codex/v2-public-full-sync codex/v2-public-starter-sync; do git push $PUB --delete "$b"; done
gh repo edit every-app/every-app --visibility public --accept-visibility-change-consequences
gh api -X PUT repos/every-app/every-app/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors   # only accepted once public
gh api -X PUT repos/every-app/every-app/private-vulnerability-reporting
curl -sI https://github.com/every-app/every-app | head -1   # 200 anonymously
```

Before the flip: turn on two-factor enforcement on the Cloudflare account. The
push runs the three workflows on `main` there (no secrets used, read-only token).

From then on, keep publishing `main` the same way (a fast-forward push after each
merge, or make `every-app/every-app` the origin). Never push side branches,
`--all` or `--mirror`.

## Option B: the one-commit copy

As built: `pnpm public-copy --push git@github.com:every-app/every-app.git`
([runbook](../runbooks/public-copy.md)), which force-replaces `main` with one
scrubbed commit; then the same tag deletion, flip, reporting and approval steps.
Hides history, TODO revisions and logs; costs a scrub on every publish and the
history Ben wants people to see.

## What changes after Ben decides

If A:

- `scripts/public-copy.mjs` becomes a guard, not a copier: run on every PR (the
  existing "Public copy dry run" job) and fail on a secret shape, a forbidden file
  name (`1k`, `accounts.json`, `.dev.vars`, `*.pem`…) or a `private.txt` name in
  added lines. Drop the scrub/rewrite, `--todo`, `--design`, `--logs` and `--push`
  modes. Optionally a gitleaks pre-push hook.
- Rewrite `docs/runbooks/public-copy.md` as "publishing `main`".
- Update `docs/launch-2026-10-27.md` A1 (the hand copy, "B9: one commit, never a
  push"), A11 ("never push this history"), B9 (copy as one commit), and the
  "Do not push the private repository … do not rewrite its history" bullet.
- TODO.md "Public copy (2026-10-24)": close "Does TODO.md travel?", the design and
  logs questions, the token roll (done), the old public history (tags deleted);
  rewrite the "Decided by default" lines about the copy's commit author and dates.

If B: nothing changes; run the runbook.
