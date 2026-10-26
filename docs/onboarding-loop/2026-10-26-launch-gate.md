# Launch gate, 2026-10-26 (launch doc item A7)

A fresh-account run of the documented self-host path on the onboarding loop's test account `loop-1` (its own Cloudflare user and account, Workers Paid, zone `<test-zone>`, Gateway at `apps.<test-zone>`). It ran twice:

- **Run 1:** private checkout, `checkout-present` prompt variant, origin/main at **6f73c77f508d2be2befd61b3c22d0241b78c1d90** (#743).
- **Run 2:** the public clone, `public` variant, four-apps step on. It runs once every-app/every-app and the app repositories are public.

Each run has the loop's control harness, the loop's Claude Code harness, and one manual lifecycle pass. The lifecycle pass covers the docs' steps the loop's verifier doesn't (dev, a second deploy, status, update, delete --purge, Access on and off). The last section lists every sentence in the docs that didn't match what the terminal did. That list is Monday's doc PR list.

## Run 1 (main 6f73c77f, checkout-present)

### Results

| step | how | result | evidence |
| --- | --- | --- | --- |
| preflight | loop | pass | token sees only loop-1; zone active; Workers Paid; workers.dev name set; llms.txt 200 |
| pre-run wipe | loop | pass | 0 resources before, 0 after |
| setup (Gateway deploy) | control | pass | `setup.gateway` ok 3 min after start; certificate included |
| owner claim | control | pass | claimed through the event log 1 s after the link |
| Access offer | control + lifecycle | pass (expected skip) | `ACCESS_SETUP_SKIPPED`: "This Cloudflare login has no email address (an API token)". Correct for a token login, which is how the loop runs. See doc note 1 |
| four-apps install step | control | not run | the control script stops after deploy and has no step 4; Claude Code row below |
| create | control (`create hello`), lifecycle (`create ../my-app`) | pass | 33 s / 15 s. The lifecycle create warned "Couldn't make the first git commit" (no git identity in the container). See doc note 2 |
| dev smoke | lifecycle | pass | `pnpm dev`: `http://my-app.localhost:8787/` 200, `<title>My App</title>`; `/health` 200 `{"ok":true,"user":"dev@everyapp.localhost"}` |
| deploy | control, lifecycle | pass | hello live in 3 min; my-app live in 2 m 34 s (the first deploy of a new app rebuilt and re-added the Gateway). Anonymous `/` and `/health` answered 401 |
| deploy again | lifecycle | pass | 44 s; the Gateway was left alone |
| verifier (G1 G2 G3 O1 A1 A2 A3 S1 T1) | loop | pass, all 9 rows | X1 skipped (no `--with-access`) |
| status | lifecycle | pass | "2 apps live, nothing to fix"; `Release 0.3.0 · matches this checkout` |
| update no-op | lifecycle | pass | "Gateway is up to date with commit 6f73c77 ✓", exit 0 |
| access on | lifecycle | pass | team `<team>.cloudflareaccess.com`; both Access apps created; the Gateway's `/` and an app's `/` answered 302 to Access; `/health` 200; status `on · in step with this Gateway` |
| access off | lifecycle | pass | `--json` without `--yes` answered `CONFIRMATION_REQUIRED` with `data.authorize: true` (as documented); with `--yes` it deleted both applications and kept the team, the IdPs and the policy |
| delete --purge | lifecycle | pass | removed from the Gateway in 40 s, Worker and D1 deleted in 7 s; status no longer lists it |
| teardown (runbook) | `pnpm loop teardown --account loop-1` | pass | 10 found before, "removed 8, kept 0", 0 after, 0 DNS records at or under `apps.<test-zone>` |
| control verdict | loop | **pass** | app-live, 778 s, 3 everyapp commands, 0 interventions (record `2026-10-26T07:19-script-none-1d10c4`) |
| four-apps install step | Claude Code | expected fail-soft | asked step 4's question, then `install` answered `NO_RELEASE` for open-seo, open-crm, open-analytics and agentic-inbox. The agent said which ones, didn't build from source, and went on |
| Claude Code verdict | loop | **pass-with-intervention (no_done)**: the loop's fault, fixed in #800 | app-live, all 9 verifier rows, 439 s, 8 everyapp commands, $0.48 (record `2026-10-26T07:51-claude-opus55-bdaffd`). The one nudge came because the agent ended its turn on step 4's question exactly as the prompt asks, and the scripted user had no answer for it |

### The Claude Code run, turn by turn

1. Installed, asked "Which domain should I use?", and got the scripted answer (expected hand-off).
2. Ran setup in the background and relayed the owner link (claimed by the loop 0 s later). Ran `create hello` and the deploy, then reported the URL. It asked the person to confirm the owner account was theirs ("ben@… claimed the Gateway 7 seconds after I posted the link. If that wasn't you, say so"), which is good behaviour. It ended the turn on step 4's question. The loop answered with its universal reply and counted a nudge. #800 makes that question an expected hand-off ("Install all four."), and #788 does the same for #762's early-adopter question, which run 2's prompt has.
3. Ran the four installs (all `NO_RELEASE`, expected today), then `status --json` ("1 app live, nothing to fix"), then DONE. Its summary named the four missing releases and said Access was off because the login is an API token.

New warnings in this run: `LOCAL_DNS_STALE` (the container's resolver still remembered the wiped hostname; setup went on) and `ACCESS_SETUP_SKIPPED` (as in the control). Neither needs a doc change: errors.md documents both.

### What went wrong around the run (not the product)

- **Another lane was using loop-1 without the lock.** Shortcuts L4 (`mcp:04cae247`) ran live tests on loop-1 while the control run was going. Its `update` at 07:34Z came right after the control run's post-run wipe. With no Gateway left, it installed a new one. My lifecycle setup then found that Gateway "up to date with commit 6f73c77", unclaimed, and minted a new owner link ("The link shown before no longer works"), which I claimed. L4's `rebindcheck` app shows up in the lifecycle pass's status tables. Nothing in the results above depends on it, and the runbook teardown removed it. L4 and the shortcuts coordinator have been asked to keep off loop-1 until the gate is done, and to take the loop's lock (`~/.config/everyapp/onboarding-loop/locks/<accountId>.json`) before any live test.
- **Product finding from that collision (code, L4 reported it too):** `everyapp update` on an account with no Gateway installs a fresh one without asking. "Update" never says it's installing. It should stop with `GATEWAY_NOT_FOUND` and point to `setup`.

## Run 2 (the gate): published rc.7 and the public repository

Run 2 is the launch gate (run 1 became advisory). It ran on loop-1 in three parts. Part A is the no-checkout path from npm at 0.3.0-rc.7. Part B is the contributor path from a fresh clone of https://github.com/every-app/every-app. Part B also ran the loop's Claude Code and control harnesses with the verbatim public prompt. Hosts were pinned through the zone's authoritative nameserver. Right after a wipe the container's own resolver keeps the Gateway host cached as missing (setup warns `LOCAL_DNS_STALE`), and an owner claim through it fails with HTTP 000.

### Part A: npm, no checkout (V = 0.3.0-rc.7)

The first attempt on rc.6 failed at setup. The published CLI had its version baked in at build time as `0.3.0`, so setup asked for `gateway-v0.3.0`, got `GATEWAY_RELEASE_LATEST`, then `RELEASE_NOT_FOUND`. #820 now reads the version at run time, and `pnpm publish:rc` checks `--version` before publishing. rc.7 then passed:

| step | result | evidence |
| --- | --- | --- |
| no checkout above the directory | pass | no pnpm-workspace.yaml up the tree |
| `npm i -g everyapp@0.3.0-rc.7`, `--version` | pass | `everyapp 0.3.0-rc.7` |
| `update` with no Gateway (#803) | pass | `GATEWAY_NOT_FOUND` pointing at setup; nothing created |
| `create demo` | pass | pins `^0.3.0-rc.6` (`PUBLISHED_VERSION` not bumped for rc.7; the caret admits rc.7) |
| `deploy` with no Gateway (#794) | pass | `GATEWAY_NOT_FOUND` pointing at setup, no install offer, no Gateway D1 created |
| setup | pass | "Downloading the Gateway release gateway-v0.3.0-rc.7…", then "Using Gateway 0.3.0-rc.7 from every-app/every-app release gateway-v0.3.0-rc.7"; no `GATEWAY_RELEASE_LATEST`; owner claimed |
| status | pass | release origin `{github, every-app/every-app, gateway-v0.3.0-rc.7}` |
| deploy outside a checkout (#764) | pass | "Using the live Gateway 0.3.0-rc.7…", rebind upload, no `gateway.upgrade`, release sha256 unchanged |
| signed in through the Gateway (#755) | pass | `/` 200, `/health` 200 as the owner; anonymous 401 |
| WebSocket through the relay (#759) | pass | connected; app→client and client→app→client echo; close 1000 |
| `pnpm dev` + tools over `/mcp` (#755) | pass | tools/list, create_todo, list_todos all 200, todo round-tripped; no org mismatch |
| `deploy --gateway https://nope.apps.<zone>` (#794) | pass | no install offer; the code is `GATEWAY_URL_MISMATCH`, not `GATEWAY_NOT_FOUND` |
| an older CLI refuses (#764 `CLI_TOO_OLD`) | inconclusive | rc.5 also has `0.3.0` baked in, which ranks above rc.7, so it deployed; the release sha was unchanged. Retest with the next correctly built rc |
| install open-seo, open-crm, open-analytics, open-mail | pass | all four live from their public releases, "needs setup" (keys unset); open-seo after its v0.1.18 release appeared |
| update | pass | "up-to-date", rc.7 by sha |
| delete outside a checkout (#764) | pass | release sha unchanged from setup to the end |

### Part B: the contributor path from the public clone

| step | result | evidence |
| --- | --- | --- |
| clone, `pnpm install`, `pnpm everyapp setup` | pass | owner claimed; `Release 0.3.0 · matches this checkout`; status Next now says `create ../my-app` (run 1 mismatch 3 fixed) |
| `create ../my-app`, `pnpm dev`, tools over `/mcp` | pass | all 200 |
| `pnpm run deploy` in ../my-app, on fc35694d (before #827) | **fail** | "The live Gateway 0.3.0 (from this checkout) can't be fetched again: it was built from a checkout, and this everyapp isn't running from one". Since #747, ../my-app ran the npm everyapp, which can't rebuild a checkout-built Gateway (#764). The suggested `pnpm everyapp update` loops. Fixed by #827 |
| the same on df0fed7e (#827) | pass | create prints "Linked to this checkout: @every-app/sdk and everyapp from /work/every-app ✓"; deploy live; signed-in `/` and `/health` 200; deploy again ok |
| four installs from the clone | pass | open-seo, open-crm, open-analytics, open-mail all live, "needs setup" |
| status, update no-op | pass | |
| delete --purge | pass on retry | first try: bare `✗ fetch failed` (`CF_UNKNOWN`, `retryable: false`) during the Gateway upload, after the app was already off the registry; status then said the live Gateway was out of date. The retry finished the purge and `setup` brought the Gateway back in step |
| teardown | pass | 0 left, 0 DNS records |
| Claude Code loop, public prompt (df0fed7e) | fail-onboarding (false_done) by the loop's rules; a pass on the fixed rules (#835) | app-live; G1–A3 and T1 pass; S1 failed only on the four `APP_NEEDS_SETUP` warnings, which is where the prompt stops. The one nudge came from a domain question in markdown bold ("**Which domain should I use?**") that the matcher missed. Both fixed in #835. The early-adopter and four-apps questions were answered as expected hand-offs. The agent used `create ../hello`, deployed it, and installed all four apps. 793 s, $0.71 (record `2026-10-26T11:24-claude-opus55-dacece`) |
| control loop, public prompt (df0fed7e) | **pass** | app-live, all verifier rows, 321 s, 0 interventions (record `2026-10-26T13:01-script-none-afe986`). The first start stalled in its 30-min gap wait while the Mac slept, and was restarted |

### Findings from run 2

Code:
1. The rc.6 package had its version baked in at build time (fixed: #820 + `pnpm publish:rc`).
2. `create ../my-app` from a checkout ran the npm CLI against a checkout-built Gateway (fixed: #827).
3. `PUBLISHED_VERSION` in `packages/cli/src/lib/app/publishedVersions.ts` was still rc.6 at rc.7. Bump it in the publish script.
4. A transient undici `fetch failed` surfaces as `CF_UNKNOWN`, `retryable: false`: in setup's owner wait ("fetch failed Envelope Error", after ~9 min) and in delete's Gateway upload (which leaves the delete half done). Retry once and name the rerun.
5. status's SETTING table lists `OPENROUTER_API_KEY` twice for crm and openmail ("! not set" and "not set (optional)"), and Next suggests `secret set WORKERS_AI_API_TOKEN` while the block says OpenRouter comes first.
6. `CLI_TOO_OLD` couldn't be exercised: every published CLI before rc.7 reports 0.3.0.

Docs:
- `create-an-app.mdx` should say what create prints now ("Linked to this checkout" from a clone; published pins from npm). Check the "It links to your every-app folder" sentence against #827.
- npx-path.md expected `GATEWAY_NOT_FOUND` for a wrong `--gateway`. It's `GATEWAY_URL_MISMATCH`. Fix whichever doc names it.

- `AGENTS.md` (and so `CLAUDE.md`) says "never `npx everyapp` (publishing is paused)". The public prompt now installs from npm, and an agent inside a clone obeyed AGENTS.md instead. It also called the npm package "behind (0.3.0-rc.7 vs 0.3.0 here)", because the repository's package.json names 0.3.0 while rc.7 is the release. This PR rewrites the AGENTS.md line: `pnpm everyapp` inside the checkout, npm for people without one.
- The loop's `public` variant still pre-clones the checkout into /work, so it can't test the prompt's npm start from an empty directory. Part A's script covers that path.

## The docs against the terminal

Each item: the page, the sentence, what happened, and whose fix it is.

1. **`landing-page/content/docs/gateway.mdx`, Create your owner account:** "In a script, or when an agent runs setup for you, Access goes on without a question when it can (your account has a Zero Trust team and your Cloudflare login is an owner or admin of the Gateway)". With the API token the same page offers ("If you'd rather not grant that, run setup with an API token instead"), Access never goes on: a token has no email, and setup says `ACCESS_SETUP_SKIPPED` "This Cloudflare login has no email address (an API token), so nobody is known to get past Access." It then names `pnpm everyapp access on`, which worked. Docs: add "with an API token it never does; run `pnpm everyapp access on` after setup". The same paragraph's token permission list (Workers Scripts, D1, KV, Zone Read, DNS Read) is enough for setup but not for `access on`. Name the Access permissions there, or link the Access page's list.
2. **`create-an-app.mdx`, Create it:** "This copies the starter app … into a `my-app` folder beside `every-app`, as a git repository of its own." On a machine where git has no `user.email` (a fresh Linux box, a container), create prints "! Couldn't make the first git commit … Fix: set git's user.name and user.email, then commit in ../my-app" and leaves a repository with no commits. Docs: add `git config --global user.name/user.email` to "Install the tools" in gateway.mdx. Code (optional): commit with a fallback identity, or say it once in the Next block.
3. **`create-an-app.mdx` vs setup's and status's Next blocks:** the page leads with `pnpm everyapp create ../my-app` and calls `create my-app` (inside `apps/`) the alternative for many apps. Setup's `done.next` and status's `Next:` both print `pnpm everyapp create my-app`. Code: print `create ../my-app` there too, or the docs take back the default.
4. **`status.mdx`, What it shows (both examples):** `Release     0.2.0 · matches this checkout`. The terminal printed `0.3.0`. The first example's Access line reads `on · everyone signs in through Cloudflare Access first`; the terminal printed `on · in step with this Gateway · everyone signs in through Cloudflare Access first`, which is the line the page's own bullet below calls normal. Docs.
5. **`update.mdx`, Remove everything:** step 2 says `access off`, and step 3 lists three things to delete (the Worker, the D1 database, the KV namespace). `access off` keeps the Zero Trust team, its identity providers and the Access policy "Every App gateway members" (its own message says so), and the teardown found that policy left behind. Docs: step 3 should add the policy under Zero Trust → Access → Policies, and say the team stays.
6. **`create-an-app.mdx`, Put it online:** the sample `Who can open  Private to you, owners and admins` reads `Private to owners and admins` when the deployer is an API token (`deployerAccess: false`, `events.ts`). That's right for a person and only differs for a token. No change needed; recorded so nobody files it.
7. **`gateway.mdx`, Wait a few minutes:** "This step usually takes 5 to 10 minutes; the whole setup about 15". On loop-1 the Gateway was live in 3 min and the owner link came at once. Not wrong, just slow. No change.

Nothing else in gateway.mdx, create-an-app.mdx (dev, deploy), status.mdx, update.mdx (update, delete --purge) or access.mdx (on, off, `--yes` under `--json`) disagreed with the terminal.
