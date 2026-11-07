---
name: everyapp
description: Create, run, deploy and manage private web apps on Cloudflare with everyapp (EveryApp). Use before running any everyapp command, to set up the Gateway or an integration (an AI key, email, Google, sign-in), deploy or install an app, set a secret, query an app's database, manage people and MCP apps, or answer any "how do I" question about EveryApp.
---

# everyapp

EveryApp puts a person's private web apps on their own Cloudflare account,
behind one Gateway that signs people in, holds every key and serves the apps'
tools at `https://<gateway>/mcp`. The command is `everyapp`: `pnpm everyapp`
in an app (its package.json pins the CLI) and in an EveryApp checkout;
`npm install -g everyapp` anywhere else.

This skill is short on purpose. The detail lives in the agent docs, which
change without a CLI upgrade: read the page for the job before you act, and
answer with the exact command, flag or field it gives, naming the page.

- Every page, one line each: https://everyapp.com/llms.txt
- A page as Markdown: `https://everyapp.com/docs/agent/<page>.md`
- No network: `pnpm everyapp docs <page>` (the copy bundled with the CLI;
  `pnpm everyapp docs` lists them)

## Rules that don't change

- **Pass `--json`** and follow the protocol: one event per line, `done` is
  success, exit 2 means a person must act (show the last `action_required`,
  then run its `data.rerun`), exit 1 is an error. With `data.authorize`, ask
  before using the rerun.
- **A failed command:** look its code up on the errors page before anything
  else. **Never guess a flag:** the cli page has them all.
- **Values never pass through the chat.** A key, token or client secret goes
  in only by the person typing it at a hidden prompt in their own terminal
  (`everyapp configure <app>`, `everyapp secret set NAME`), by a pipe from a
  command that produced it, or by `--from-env`. Never ask for one, print
  one, repeat one, invent one, or put one on a command line.
- **Ask first** before any flag that deletes or takes over (`--purge`,
  `--force-dns`, `--allow-delete-*`, `--yes`, `--enable-email-routing`,
  `--no-access`), before `db restore`, and never run `teardown` on a
  person's account.
- **Only a person can** approve the Cloudflare login, open the owner link,
  pick the account or a workers.dev name, pay, buy a domain, or confirm at a
  terminal. Stop, tell them in one or two lines what to do, and resume with
  `data.rerun` when they say it's done.
- **Deploy with `everyapp deploy`,** never `cf deploy` or `wrangler deploy`,
  and never change a Worker in the dashboard.
- **The Gateway signs people in.** An app never builds its own login and
  never reads who the user is from a header, cookie or parameter a client
  sent. Building or changing an app: read the build-every-app skill.
- **Never vendor the SDK or CLI into an app:** pin a published version.

## Where to read, by job

| Job | Page |
| --- | --- |
| Set EveryApp up for a person; what only they can do; safety rules | https://everyapp.com/docs/agent/setup.md |
| Set up one integration step by step (AI key, email, Google, Slack, sign-in, remote MCP, Access) | https://everyapp.com/docs/agent/setup/guides.md, then the one guide it names |
| A `Guide:` line in `status`, `configure` or `secret list` output | the URL it prints (offline: `pnpm everyapp docs setup/<name>`) |
| What is online, what to fix, Needs setup | https://everyapp.com/docs/agent/status.md |
| Which command for which job; what to suggest next | https://everyapp.com/docs/agent/gateway.md |
| Every command and flag | https://everyapp.com/docs/agent/cli.md |
| The `--json` protocol, actions, reruns | https://everyapp.com/docs/agent/json.md |
| An error code | https://everyapp.com/docs/agent/errors.md (anchor: the code, lowercased) |
| Something's wrong, no code | https://everyapp.com/docs/agent/troubleshooting.md |
| The open apps and their installs | https://everyapp.com/docs/agent/apps.md |
| `everyapp.config.ts`: capabilities, features, public and bearer routes | https://everyapp.com/docs/agent/manifest.md |
| Secrets vs settings vs capabilities; `configure` | https://everyapp.com/docs/agent/secrets.md |
| Deploys, releases, installs, delete, the database | https://everyapp.com/docs/agent/deploy.md |
| `everyapp dev`; local vs production | https://everyapp.com/docs/agent/dev.md |
| API and OAuth providers | https://everyapp.com/docs/agent/providers.md |
| The default model; AI Gateway | https://everyapp.com/docs/agent/ai.md |
| Email senders and inbound | https://everyapp.com/docs/agent/email.md |
| The MCP address, OAuth, tokens, MCP apps | https://everyapp.com/docs/agent/mcp.md |
| An app's AI tools; tools missing; 401 or 403 on `/mcp` | https://everyapp.com/docs/agent/tools.md |
| People, groups, app access, caps, usage | https://everyapp.com/docs/agent/workspace.md |
| Webhooks, email alerts, the audit log | https://everyapp.com/docs/agent/events.md |
| Cloudflare Access; sign-in providers | https://everyapp.com/docs/agent/access.md, https://everyapp.com/docs/agent/signin.md |
| Reviewing an app's changes before a pull request | https://everyapp.com/docs/agent/security-review.md |
| What the Gateway promises (security) | https://everyapp.com/docs/agent/repo/threat-model.md |
