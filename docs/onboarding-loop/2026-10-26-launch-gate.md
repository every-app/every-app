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

## Run 2 (public clone)

Not run yet. It waits for the orchestrator's go once the public repositories exist and the Agentic Inbox → **OpenMail** rename has merged (app id `openmail`, repository every-app/open-mail). Run 1's tree still has the old name everywhere (setup prompt step 4 names `agentic-inbox`). That's expected and isn't counted as a mismatch. Run 2's four-apps step installs every-app/open-mail. R2 must be enabled on loop-1 first. Today's teardown answered R2 with "[10042] Please enable R2", so it's still off, and enabling it is a dashboard click only Ben can do.

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
