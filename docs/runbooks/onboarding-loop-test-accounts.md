# Test Cloudflare accounts for the onboarding loop

The onboarding loop (docs/design/2026-10-onboarding-loop.md) installs Every App from nothing, over and over, and wipes everything it made between runs. It needs Cloudflare accounts that hold nothing else. This runbook creates them.

Two rules, decided 2026-10-23:

1. **A test account belongs to a separate Cloudflare user.** Not an extra account under your own login: a token minted by your user can see every account that user is a member of, and the teardown must have no path to a live account. Account `23bc28f0b638fbfc1c7f838573c17ee3` (openseo.so, everyapp.team) is never eligible, and the tooling refuses it by id.
2. **A token's value never goes through chat or into the repository.** You create it in the dashboard and put it where the loop reads it yourself (below).

One account is enough to run harnesses one after another. Two let two harnesses run at the same time, each against its own account. The steps are the same for each; do them once per account.

## 1. Create the user and the account (10 minutes)

1. Make a new email address you control, e.g. `everyapp-loop-1@<your domain>` (an alias or a group that lands in your inbox works; the login's email also receives Cloudflare's verification mails and the one-time PIN mails when `access on` is tested).
2. Open https://dash.cloudflare.com/sign-up in a private browser window (so you are not signed in as yourself), sign up with that address and a new password from your password manager, and verify the email.
3. Turn on two-factor authentication for the new user (My Profile → Authentication) and store the TOTP secret with the password. It is a bot account; nobody types its code by hand.
4. Note the **account id**: Compute (Workers) → Overview shows it on the right, or any dashboard URL `dash.cloudflare.com/<account id>/…`. Keep the id; the loop's allowlist takes it.

## 2. Workers Paid (2 minutes, but do it last, after step 7)

`everyapp setup` is meant to stop on a Free account before it creates anything, but whether it recognises a Free account is unverified (TODO.md, onboarding audit: a Free account may have no `workers_*` subscription row at all, and then setup only warns). A brand-new account is the one chance to find out, so leave it on Free until the token exists (step 5) and the check in step 7 passes. Then, still on Free:

1. Run `CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id> cf accounts subscriptions get` and keep the output (it holds no secrets): its Workers rows go into `packages/cli/src/lib/cf/plan.test.ts`.
2. Let the loop run `setup` once against the Free account. It must stop on `upgrade_workers_paid` (exit 2) with nothing created; `pnpm everyapp teardown --account-id <id> --dry-run` should list nothing. If it installs instead, that is the first finding.

Only then: Compute (Workers) → Plans → **Workers Paid** ($5 a month, then usage) → add a card. Teardown never cancels the subscription. Turn on billing usage notifications for the account (Notifications → Billing) so a runaway agent shows up as mail, not as next month's invoice; the token has no spending ceiling inside the account.

## 3. Buy a domain (5 minutes)

The Gateway needs an active zone in the account. Domain Registration → Register Domains: pick the cheapest name you will recognise in the loop's reports, e.g. `everyapp-loop1.com` (a .com is about $10 a year; some TLDs are cheaper). A domain bought here is an active zone at once, nameservers included. Teardown never deletes the zone, only records the CLI created in it.

## 4. The workers.dev subdomain: don't pick it yet

Whether a fresh account's first Worker upload needs a `workers.dev` name is unverified (TODO.md, onboarding audit: cf demands one for Workers that define Workflows, and the Gateway defines none). Leave it unset so the first loop run records what really happens. If `setup` stops on `register_workers_subdomain` (exit 2), the loop's scripted user registers the name itself with `PUT /accounts/{id}/workers/subdomain` (the token's Workers Scripts: Edit covers it; the name is `everyapp-loop<n>`), answers the agent, and records `workers_subdomain: first-run` with cf's exact error text; by hand, pick it once in the dashboard (Compute (Workers) → Workers & Pages → the "Set up a subdomain" prompt) and run again. Either way the report says which happened. Teardown never removes it, so only the first run per account exercises this hand-off.

## 5. Create the API token (5 minutes)

Prefer an **account-owned token**, which belongs to the account and to no person: in the test account, Manage Account → **Account API Tokens** → **Create Token** → Custom token → "Get started" (its value starts with `cfat_`; the loop and `cf` verify it at the account endpoint). A user token from My Profile → API Tokens works too, with the same permissions.

Permissions (the least that lets `setup`, `create` then `deploy`, `access on`, `email set` and the teardown run; derived from the cf commands the CLI calls):

| Scope   | Permission                                               | Access | Needed by                                                                       |
| ------- | -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| Account | Account Settings                                         | Read   | `cf auth whoami` listing the account; `accounts get`                            |
| Account | Billing                                                  | Read   | the Workers Paid check (`accounts subscriptions get`)                           |
| Account | Workers Scripts                                          | Edit   | the Gateway and app Workers, their secrets, versions, Custom Domains, Workflows; also `PUT /accounts/{id}/workers/subdomain` (Workers Scripts Write covers it, verified in the API reference) |
| Account | D1                                                       | Edit   | the Gateway's database and each app's                                           |
| Account | Workers KV Storage                                       | Edit   | the OAuth KV namespace and each app's                                           |
| Account | Workers R2 Storage                                       | Edit   | app buckets (and listing them for teardown)                                     |
| Account | Hyperdrive                                               | Edit   | Postgres apps; teardown lists and deletes configs                               |
| Account | Vectorize                                                | Edit   | apps' Vectorize indexes (`resources.vectorize`); teardown lists and deletes them; the live test `packages/cli/test/provisioners/vectorize.live.test.ts` passed with loop-1's token on 2026-10-24 |
| Account | Access: Apps and Policies                                | Edit   | `access on` / `access off`, teardown                                            |
| Account | Access: Organizations, Identity Providers, and Groups    | Edit   | the Zero Trust team and the one-time PIN provider                               |
| Account | Email Routing Addresses                                  | Edit   | `email set --inbound`                                                           |
| Zone    | Zone                                                     | Read   | finding the zone for `--domain`                                                 |
| Zone    | DNS                                                      | Edit   | DNS checks before install; Custom Domains write records; teardown removes them  |
| Zone    | Workers Routes                                           | Edit   | Workers Custom Domains on the zone                                              |
| Zone    | SSL and Certificates                                     | Edit   | waiting for and deleting hostname certificate packs                             |
| Zone    | Email Routing Rules                                      | Edit   | `email set --inbound`, teardown                                                 |
| Zone    | Zone Settings                                            | Read   | zone status                                                                     |

Resources: **Account Resources → Include → the test account only**. **Zone Resources → Include → All zones from an account → the test account**. No client IP filter. TTL: an end date 30 days out during launch week (transcripts that may contain the token go to the harnesses' model vendors; see section 8 for rotation), 90 days once the loop is routine. Continue to summary → Create Token → copy it once.

The template deliberately has no user-scope permission (no API Tokens, Memberships or User Details), so the token can neither see another account nor roll itself: rotation is by hand (section 8). On the first real token, confirm `CLOUDFLARE_API_TOKEN=<token> cf auth whoami` prints `tokenValid: true`, `authSource: "CLOUDFLARE_API_TOKEN environment variable"` and exactly one account; the loop's preflight and the teardown both require that exact shape.

If a run fails with `CLOUDFLARE_TOKEN_REJECTED` or a cf `auth` error naming a resource, the table above is missing a permission: add it to the token in the dashboard (Edit) and note the row here. The loop's preflight treats `CLOUDFLARE_TOKEN_REJECTED` (or `tokenValid: false`) as a fixture error: it refuses to start the run, prints which account's token it was, and nothing is created or deleted.

## 6. Give the token to the loop, never to the agent

The loop reads each account from a file outside the repository, `~/.config/everyapp/onboarding-loop/accounts.json`, mode 600. Write it yourself in a terminal (the agent never sees the values):

```sh
mkdir -p ~/.config/everyapp/onboarding-loop && chmod 700 ~/.config/everyapp/onboarding-loop
cat > ~/.config/everyapp/onboarding-loop/accounts.json <<'EOF'
{
  "accounts": [
    {
      "name": "loop-1",
      "accountId": "<the account id from step 1>",
      "zone": "everyapp-loop1.com",
      "email": "everyapp-loop-1@<your domain>",
      "token": "<the token from step 5>"
    }
  ]
}
EOF
chmod 600 ~/.config/everyapp/onboarding-loop/accounts.json
```

Only if the loop moves off this Mac onto Modal sandboxes (the design doc's fallback substrate) do the same values go into Modal secrets instead, created from your terminal, one per account plus one for the provider keys below:

```sh
uvx modal secret create everyapp-loop-1 CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id> EVERYAPP_LOOP_ZONE=everyapp-loop1.com
uvx modal secret create everyapp-loop-providers ANTHROPIC_API_KEY=<key> CODEX_API_KEY=<key> OPENCODE_API_KEY=<key> CURSOR_API_KEY=<key>
```

The **teardown allowlist** is separate from this file and holds no secrets: set `EVERYAPP_TEST_ACCOUNTS=<account id>,<account id>` in the environment of the teardown command, or write the ids one per line to `~/.config/everyapp/test-accounts`. By hand you set it yourself, deliberately, each time. The loop (`pnpm loop`) derives it from accounts.json and sets it, with the token, in the environment of the one child process that runs `everyapp teardown`, never in its own; it refuses to start if `EVERYAPP_TEST_ACCOUNTS`, `CLOUDFLARE_API_TOKEN` or `EVERYAPP_GATEWAY_URL` is already set in the shell it was launched from. The teardown refuses any account id not on the list, refuses `23bc28f0b638fbfc1c7f838573c17ee3` even if it is listed, and refuses a token that can see any account outside the list, is not a `CLOUDFLARE_API_TOKEN` environment token, or is not valid.

The **second confirmation** is the account id: typed at the terminal when a person runs the loop, or, for an unattended run, read from a file you write once by hand, `~/.config/everyapp/onboarding-loop/confirm-<account id>` (mode 600) whose whole content is the line `delete everything in <account id>`. The loop forwards it as `--confirm <id>`. No file, no unattended teardown, no run. `pnpm loop accounts` prints each account's name, zone and owner email from accounts.json, and which provider keys are set (never an id or a token); the id is the one you noted in step 1.

**Provider keys** go in `~/.config/everyapp/onboarding-loop/providers.env` (mode 600; `KEY=value` lines), one per harness, each created for the loop and nothing else, each with a spend cap where the console has one:

| Variable             | Harness             | Where it comes from                                                                                                    |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`  | Claude Code, Hermes | a dedicated Anthropic Console workspace with a monthly spend limit (Hermes uses it with `--provider anthropic`; no OpenRouter) |
| `CODEX_API_KEY`      | Codex CLI           | a dedicated OpenAI platform project with a hard budget (a ChatGPT subscription does not work for `codex exec`)          |
| `OPENCODE_API_KEY`   | OpenCode            | OpenCode Zen (opencode.ai/zen), prepaid; the balance is the cap                                                         |
| `CURSOR_API_KEY`     | Cursor agent CLI    | a **separate Cursor account** made for the loop, on Premium (user keys are not offered below it): a user key also reaches the Cloud Agents API and every repository that account connects, so never your own |

Gemini CLI and Grok Build are parked (the first was replaced by Antigravity CLI, the second is subscription-gated), so no `GEMINI_API_KEY` or `XAI_API_KEY` is needed.

## 7. Check it (1 minute)

From the checkout, with the token in the environment of this one command:

```sh
CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id> pnpm everyapp status --json
```

A fresh account answers with an error saying no Gateway was found in that account (there is none yet). Any `auth` or `forbidden` error means a permission is missing (step 5).

## 8. Rotating a token

The loop cannot roll a token (that needs API Tokens: Write at user scope, which the template leaves out on purpose). When a run's report prints `ROTATE: cf_token loop-1`, the agent printed the token into a transcript that is now at a model vendor; the loop refuses that account until the token changes. Rotate by hand: sign in as the test user → My Profile → API Tokens → Roll (same id and permissions, new value) → paste the new value into accounts.json. The loop refuses a value by its hash (`~/.config/everyapp/onboarding-loop/runs/<run id>/rotate.json`), so the rolled token is accepted on its own; nothing to delete. Roll both tokens after launch week whatever the reports said. Provider keys rotate in their consoles the same way (`ROTATE: <variable>`); a rolled key goes into providers.env.

## 9. The Mac that runs the loop (10 minutes, once)

The loop runs each harness in a Docker container on this machine (Docker Desktop is installed and running; the `docker` binary is at `/Applications/Docker.app/Contents/Resources/bin/docker`, off PATH, and the script finds it there). Before the first run: Docker Desktop → Settings → Resources → Memory **16 GB** (the default 8 GB fits one run, not two); Settings → Software updates → turn automatic updates off (an update restarts the engine mid-run); leave "Start Docker Desktop when you sign in" as you like, the preflight stops with `docker info failed` when the engine is not answering: start Docker Desktop and run again. The script re-executes itself under `caffeinate -i` so the Mac does not sleep during a run.

## Running the teardown

From the checkout, with the token and the allowlist in the environment of the one command (the loop sets them from accounts.json; by hand you set them yourself, each time). Look first, then delete:

```sh
# What would go: reads only, exit 0, data.plan lists every kind.
EVERYAPP_TEST_ACCOUNTS=<id> CLOUDFLARE_API_TOKEN=<token> pnpm everyapp teardown --account-id <id> --dry-run --json

# At a terminal: shows the inventory, then asks you to type the account id.
EVERYAPP_TEST_ACCOUNTS=<id> CLOUDFLARE_API_TOKEN=<token> pnpm everyapp teardown --account-id <id>

# Without a terminal (the loop, a script): the id again as --confirm. There is no --yes.
EVERYAPP_TEST_ACCOUNTS=<id> CLOUDFLARE_API_TOKEN=<token> pnpm everyapp teardown --account-id <id> --confirm <id> --json
```

`--account-id` is required and never read from `CLOUDFLARE_ACCOUNT_ID`. Before it reads anything but `cf auth whoami`, the command refuses: `TEARDOWN_INVALID_ACCOUNT_ID` (not 32 hex characters), `TEARDOWN_ACCOUNT_FORBIDDEN` (the id above, whatever the lists say), `TEARDOWN_NOT_ALLOWLISTED` (the id isn't in `EVERYAPP_TEST_ACCOUNTS` or `~/.config/everyapp/test-accounts`), `TEARDOWN_NEEDS_TOKEN` (no `CLOUDFLARE_API_TOKEN`), `TEARDOWN_TOKEN_TOO_BROAD` (the token sees an account outside the list), `TEARDOWN_ACCOUNT_NOT_VISIBLE` (the token doesn't list the account) and `TEARDOWN_CONFIRM_MISMATCH` (`--confirm` names another id than `--account-id`); an allowlist entry that isn't an account id is a `TEARDOWN_ALLOWLIST_IGNORED` warning. Under `--json` without `--confirm` it stops after the inventory with `TEARDOWN_CONFIRMATION_REQUIRED`, whose `data.rerun` carries `--confirm <id>` and `data.authorize: true`. A kind that can't be listed (a permission the token lacks, say) is a `TEARDOWN_READ_FAILED` warning: the other kinds are still deleted and the kind is said kept. A service the account never enabled (Access or R2 answering 403 with their "not enabled" codes, as a fresh account does) is not that: the run says so as a skipped step and counts zero of the kind. A failure on one resource is a `TEARDOWN_DELETE_FAILED` warning; the resource is listed under `kept` with its place in the dashboard (an R2 bucket with objects in it, say: empty it, then run again). A certificate pack Cloudflare refuses but no longer lists (it removes a hostname's pack with its Custom Domain, and refuses a delete while doing so) is counted as removed, not kept. A run on an account with nothing left says so and exits 0.

Deletion order: the Access applications and policy; Email Routing rules to `every-*` Workers (the catch-all drops mail again; routing is turned off once no rule and no catch-all of anyone else's needs it, which removes its MX records); Workflows; Workers (apps, their helpers, the Gateway's last, each deleted with its references since the Gateway and the apps bind each other; Custom Domains go with them); the hostnames' certificate packs (never the zone's Universal pack); the apps' D1 databases; KV namespaces; R2 buckets; Hyperdrive configs; the Custom Domain records (A, AAAA, CNAME) left at exactly the published names; and last the Gateway's D1 database, the inventory's source, held back only while a DNS record was kept, so the next run finds the record by hostname again (a kept certificate pack never holds it: the next install must start from an empty account, and Cloudflare removes the pack with its Custom Domain anyway).

Seen on the first live wipe (2026-10-24, a test account with a Gateway and one app): deleting the Gateway Worker dropped its Custom Domain and left no DNS record at the gateway host; Cloudflare removed the hostname's certificate pack with the Custom Domain, so the pack's delete answered `[1406] Bad response certificate service` and the zone listed only its Universal pack a minute later; and `cf ssl certificate-packs list` hides every pack that isn't active unless passed `--status all`, which the teardown passes when it checks a refused pack (it looks once right after the refusal and, if the pack is still listed as it was, once more after a short wait). The fresh account answered 403 with the "not enabled" codes for Access and R2. Still to verify: what `cf email-routing rules catch-all get` answers on a zone where routing was never configured.

## What teardown leaves in place

The zone, the Workers Paid subscription, the workers.dev subdomain, the Zero Trust team (Cloudflare has no API to delete one; its applications and policy are removed, its identity providers stay) and the user itself. Anything whose name doesn't start with `every-` and that no app recorded in the Gateway's database is never touched. In DNS, only A, AAAA and CNAME records at the published names go (what a Workers Custom Domain creates; `everyapp` writes no other record): a zone's MX, TXT, CAA and the rest at those names are someone else's and are listed under `kept`, as are Email Routing's own records while routing stays on for a rule or catch-all that isn't Every App's. R2 buckets created in the EU or FedRAMP jurisdiction aren't listed (cf lists the default jurisdiction alone): delete those in the dashboard. Everything else that `everyapp` created is removed.

## Live facts

### loop-1 is no longer a never-enabled account (2026-10-25)

- Its Zero Trust team `everyapp-loop1.cloudflareaccess.com` exists since 2026-10-24T23:25Z (created by API for the Access live check; the API cannot delete a team, and `teardown` never tries).
- It carries two identity providers: the one-time PIN that `access on` added, and a `cloudflare` provider (`restrict_to_account_members: true`) that the public-surface thread's CLI lane added at about 2026-10-25T00:02Z to check that a Cloudflare provider can be created by API on a team the API created (dashboard-created teams get one automatically; API-created ones do not). `teardown` removes Access applications and policies, not identity providers, so every later `access on` on loop-1 finds both and lists both in `allowed_idps`.
- A check that needs a never-enabled account, or a team with the PIN only, needs the second test account.
- Token rule, applied to that lane's read of `accounts.json`: a process on this machine reading the file in-process and passing the value only through a child's environment is inside the file's threat model (anyone running as Ben can read it); the loop's rotate rule is about the value reaching a transcript, a stream or a file it does not own. Not rolled for that. Other threads touching loop-1 live should check `~/.config/everyapp/onboarding-loop/locks/` first so they never overlap a run.
