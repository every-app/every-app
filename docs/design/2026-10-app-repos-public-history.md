# Publishing the app repos' history (2026-10-26)

The app repos that go public with the platform tonight, each with full history,
scanned the way [the platform's history](2026-10-public-history.md) was. Same
ruling (Ben, 2026-10-25): history goes public unless something in it is a
security issue; any secret gets rolled; Ben's and Carter's addresses are fine,
customer addresses are not. Nothing has been pushed, created or flipped.

**Roll list: empty.** No real credential is in any of the four histories.

| Public repo                      | From                                    | Commits published                            | Verdict  |
| -------------------------------- | --------------------------------------- | -------------------------------------------- | -------- |
| `every-app/open-crm` (new)       | `private-open-crm` `main` @ a1c76d3     | 499, all ours                                | **Pass** |
| `every-app/open-analytics` (new) | `private-open-analytics` `main` @ d4baf103 | 1254: 1219 upstream InsightFlare, 35 ours | **Pass** |
| `every-app/open-mail` (new)      | `private-open-mail` `everyapp` @ 6ed2e87 | 94: 11 upstream agentic-inbox, 83 ours      | **Pass** |
| `every-app/open-seo` (public)    | `private-open-seo` PR #1067 `t3/everyapp-mode` @ 922ea7f1 | 63 not on open-seo `main` (307c9ec6) | **Pass** |

Skipped as asked: `private-open-seo-everyapp` (old port venue; its PRs #1–#17
reach open-seo only through #1067's merges, so they were scanned there), RepoLens,
Mission Control.

## How it was scanned

Fresh `gh repo clone every-app/<name> -- --no-single-branch` of each, every remote
branch checked out locally so the scanners see all refs (CRM, analytics and mail
have 5 branches each; side branches are scanned but are never pushed).

- `gitleaks git --redact -v .` (all refs).
- `trufflehog git file://. --only-verified` and one unverified pass (all refs).
- Own greps over the added lines of `git log -p` of every commit: Cloudflare
  (`cfut_/cfat_/cfkt_`, 40-char values on `CLOUDFLARE_API_TOKEN`-like names),
  `sk-` (incl. `sk-ant`, `sk-or-v1`), `ghp_/gho_/github_pat_`, `npm_`,
  OpenRouter/DataForSEO assignments, Resend `re_`, PostHog `phc_/phx_`,
  Stripe `sk_/rk_/pk_live|test`, `whsec_`, PEM private keys, `AKIA`, `AIza`,
  `GOCSPX-`, Slack/Discord tokens and webhooks, JWTs, DB URLs with passwords, any
  `*SECRET|TOKEN|API_KEY|PASSWORD = "…16+ chars"`.
- Files ever added named `.env*`, `.dev.vars*`, `secrets.env`, `accounts*.json`,
  `1k`, `*.pem`, `*.key`, `.npmrc`, `.everyapp/`, `.wrangler/`, `.alchemy/`.
- Every vendored tarball (`vendor/every-app-sdk-0.3.0.tgz`, `vendor/everyapp-0.3.0.tgz`)
  at every revision was unpacked and its PEM blocks compared byte-for-byte.
- open-seo: only `307c9ec6..t3/everyapp-mode` (plus the 3 commits private `main`
  has ahead of public `main`, all inside that range), merge commits read with
  `--cc` so conflict resolutions are covered.
- Upstream commits (InsightFlare, agentic-inbox) are already public in their own
  repos; scanner hits in them would not be new exposure, and there were none.

| Repo           | gitleaks                           | trufflehog verified | trufflehog unverified                              |
| -------------- | ---------------------------------- | ------------------- | -------------------------------------------------- |
| open-crm       | 0 (458 commits)                    | 0                   | 3: dev PEM in the vendored tarballs                |
| open-analytics | 24 (1264), all `dataKey="…"` / `key === "…"` chart props | 0 | 11: dev PEM ×3, `user:pass@example.com`, the RFC UUID `550e8400-…` ×7 in OpenAPI docs |
| open-mail      | 0 (89)                             | 0                   | 3: dev PEM                                         |
| open-seo #1067 | 0 (48 non-merge)                   | 0                   | 4: dev PEM ×3, `user:pass@example.com`             |

## Secrets

| Hit | Repos | Real? | Status |
| --- | ----- | ----- | ------ |
| `-----BEGIN PRIVATE KEY-----` in `vendor/*.tgz` (`dist/dev/keypair.js`, CLI chunks) | all four (crm 027170a7, analytics d843ffcc, mail 712deb1a, seo 4485bf8e; tarballs later dropped for npm pins) | The platform's `DEV_PRIVATE_KEY_PEM` (`packages/sdk/src/dev/keypair.ts`), identical bytes | Public by design, already cleared in the platform scan. Fine |
| `test/fixtures/identity.pem` | open-mail 2da2b4a | A **public** key for the offline deploy check | Fine |
| `xoxb-bot-secret`, `xoxp-user-secret`, `xoxb-test-token`, `test-erasure-secret`, `TOKEN_ENCRYPTION_KEY: "test-token-encryption-key-0123456789"` | open-crm tests, `vite.config.ts` test env | Fixtures | Fine |
| ~150 `SECRET: "…-test-secret"`, `e2e-*-password`, `e2e-cloudflare-token`, `ifk_live_prefix.secret` | open-analytics tests/e2e | Fixtures | Fine |
| `MAIN_SECRET=dev-only-main-secret-0123456789abcdef` | open-analytics `.dev.vars.example` | Dev key, named as such | Fine |
| `DATAFORSEO_API_KEY: "dataforseo-key…"`, `OPENROUTER_API_KEY: "openrouter-key…"`, `"encoded-credentials"` | open-seo `alchemy.run.test.ts`, `provider-access.test.ts` | Fixtures | Fine |
| `STORAGE_SECRET_KEY=replace-with-a-long-random-secret`, empty `*_API_KEY=` | open-seo `deploy/*.env*.example`, all `.dev.vars.example` | Placeholders | Fine |
| `postgres://<user>:<password>@` | open-crm, open-seo docs | Placeholders | Fine |
| `.npmrc` | open-crm | `node-options=--max-old-space-size=4096` only | Fine |

No `.dev.vars`, `.env`, `secrets.env`, `accounts.json`, `1k` or `.everyapp/` was
ever committed in any of them.

## Other sensitive content

| What | Where | Security issue? | Note |
| ---- | ----- | --------------- | ---- |
| Ben's and Carter's addresses (`bensenescu@gmail.com`, `csmithonthetrack@gmail.com`, noreply ids) | commit authors | No | Ben ruled fine |
| Upstream authors' addresses (RavelloH, `tgauvin@cloudflare.com`, two InsightFlare contributors) | upstream commits | No | Already public in RavelloH/InsightFlare and cloudflare/agentic-inbox |
| Customer / third-party addresses | none found | — | All others are fixtures (`.test`, `.example`, `contoso/globex/initech/wayne/hooli…`, `ana@a.test`), `support@openseo.so`, `system@openseo.so` |
| `pmarchetti@fernhill.com` / "Paula Marchetti" | open-crm `identity.test.ts`, `skills/identity-matching.md` | No | The CRM's fixture persona (company Fernhill, mostly `fernhill.test`). Only weak point: two spots use the real-looking `.com` domain; an imaginary person, not a customer |
| `agentic-inbox.everyapp.team` / `openmail.everyapp.team` "with mail on `hi.openseo.so`" | open-mail docs (8ca3700, removed in 05ef46a) | No | Says where the live inbox runs; no mailbox names, no message contents. Fixture mail is `alice@example.org` → `dev@example.com` |
| Message contents | open-mail `test/fixtures/inbound.eml`, `workers-ai-llama-step*.sse` | No | Synthetic ("order 1042"), a Workers AI weather tool-call stream |
| `openseo.everyapp.team`, Worker `every-bensenescu-openseo`, the `*-everyapp` Worker names, "set CONTEXT_API_KEY on everyapp.team before Monday" | open-seo #1067 docs and TODO | No | everyapp.team internals: names, not credentials |
| Private repo names (`private-every-app` ×20–25 per repo, `every-app/private-open-analytics`, `open-seo-everyapp`, `private-open-seo-everyapp` in merge subjects) | all four | No | Readers see links they cannot open; open-analytics names `every-app/private-open-analytics` 9× |
| `bensenescu/open-seo` links | open-seo | No | Old public location, redirects |
| Cloudflare account / zone / KV ids | none | — | crm's 32-zero placeholder only |
| D1 id `37bee90a-…` | open-seo `alchemy.run.ts` | No | Already on public open-seo `main` (`wrangler.audit.jsonc`) |
| UUIDs in open-crm `drizzle/sqlite/meta/*_snapshot.json`, open-mail send ids | — | No | Drizzle snapshot ids and a local transcript |
| Local paths (`/Users/…`, `/tmp/ea-*`) | none | — | — |
| Screenshots | none | — | Only favicons and launcher icons were ever added |
| Tags (`v0.1.0-2026102x-<sha>` per release) | crm 6, analytics 12, mail 8 | No | Not pushed by `main:main`; the public Release workflow cuts its own on the first push |

**The cost, plainly:** the CRM's TODO.md history (decisions "held for Ben",
cold-start measurements), the mail and open-seo docs naming the live
everyapp.team installs and Worker names, and links to private repos. None of it
is exploitable.

## Push commands (Ben runs these)

Each repo's `release.yml` runs on the first push to `main` and publishes a
release with the default `GITHUB_TOKEN` (no repository secrets used). Re-run
`gitleaks git --redact . && trufflehog git file://. --only-verified --fail` if the
branch has moved past the commit in the table.

```sh
# open-crm
git clone --single-branch --branch main git@github.com:every-app/private-open-crm.git open-crm && cd open-crm
gh repo create every-app/open-crm --public
git push git@github.com:every-app/open-crm.git main:main

# open-analytics
git clone --single-branch --branch main git@github.com:every-app/private-open-analytics.git open-analytics && cd open-analytics
gh repo create every-app/open-analytics --public
git push git@github.com:every-app/open-analytics.git main:main

# open-mail (from the everyapp branch)
git clone --single-branch --branch everyapp git@github.com:every-app/private-open-mail.git open-mail && cd open-mail
gh repo create every-app/open-mail --public
git push git@github.com:every-app/open-mail.git everyapp:main
```

open-seo needs no new repo: merge every-app/private-open-seo#1067, then publish
private `main` to `every-app/open-seo` the usual way. A merge commit publishes all
63 commits above; a squash publishes only the tree. Either is clean.
