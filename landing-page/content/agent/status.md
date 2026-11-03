---
title: "everyapp status: the report and its fixes"
description: Run everyapp status --json to learn what is left to do on a Gateway and its apps, and apply each fix until none is left.
---

`everyapp status` says where a Gateway stands and what to run next. Run it after setup, after every deploy or install, and whenever the person asks "is it working?" or "why does it say Needs setup?". It reads the Gateway's database and Cloudflare under the person's login, changes nothing and never calls the Gateway over HTTPS.

## The loop

1. Run `everyapp status --json`. Add `--account-id` or `--gateway` when the login sees several.
2. For each entry of `done.data.fixes`, in order:
   - When `run` is a command, run it (with `--json` for everyapp commands).
   - When `run` is `null`, do what `fix` says.
   - `settling` resolves by itself (a certificate, a first visit). Wait, then check again.
   - `info` is good to know, like an update to take or leave.
3. Run it again. Stop when no `error` or `warning` is left. Then tell the person what is live (`apps[]` with `status: "active"`) and offer `data.next`.

With no Gateway in any account it ends with `action_required` `install_gateway`: offer `everyapp setup`.

## The report

- **Gateway**, **Cloudflare**, **Owner** (`none yet`: nobody opened the owner link, so nobody can sign in).
- **Access**: on (all three Access settings on the Gateway Worker; `access show` asks Zero Trust) or off.
- **Release**: matches this CLI, newer available (`GATEWAY_OUTDATED`), behind, or changed outside everyapp.
- **TLS**: certificates ready or pending.
- **Apps**: one row per app. It shows `live`, `live on first visit`, `waiting for certificate`, `needs setup` (a required setting is unset and the app doesn't open), `never deployed`, `not bound`, `Worker missing` or `switched off`. Rows also show the app's public routes and who last deployed it. MCP apps aren't listed: use `everyapp mcp list`.
- **Email** and **Settings** tables, for apps that declare them.
- One block per problem, with `Run:` or `Fix:`. Then **Next:**, at most four suggestions (an AI key, Access, people to invite, an AI client to connect, a first app, email).

For an app that needs setup, the block names each unmet setting, what it is for, where the key comes from and the setup guide (`node_modules/everyapp/skills/everyapp/setup/<file>`, or for an app's own secret `docs/setup/<file>` in the app). Read the guide, then have the person run `everyapp configure <app>`.

## Fixes

| Code | Run |
|---|---|
| `GATEWAY_NOT_INSTALLED`, `GATEWAY_NOT_UPLOADED`, `NO_OWNER`, `GATEWAY_CHANGED`, `BINDINGS_DIFFER` | `everyapp setup`: it resumes, repairs, or prints a new owner link. |
| `CHECKOUT_BEHIND` | In a checkout: `git pull`, then `pnpm install`. |
| `GATEWAY_OUTDATED` | `everyapp update`. As an error (the Gateway's database is behind) the other commands refuse until then; as info (a newer release) it can wait. |
| `APP_NEEDS_SETUP` | `everyapp configure <app>`. |
| `APP_NOT_UPLOADED`, `APP_WORKER_MISSING` | `everyapp deploy` in the app's directory, or `everyapp delete <app>`. |
| `APP_NOT_BOUND` | `everyapp delete <app>`, then deploy again. |
| `APP_BINDING`, `CERT_PENDING`, `DEPLOY_RUNNING` | Nothing. Check again in a minute. |
| `EMAIL_ROUTE_PENDING`, `EMAIL_ROUTE_MISSING` | `everyapp deploy` in the app's directory. |
| `EMAIL_INBOUND_UNDECLARED` | Declare `email: { inbound: true }` and deploy, or `everyapp email unset inbound`. |
| `SETTINGS_UNKNOWN`, `EMAIL_ROUTES_UNKNOWN`, `CERTIFICATES_UNKNOWN`, `ACCESS_UNKNOWN` | Cloudflare didn't answer. Check again; if it repeats, the message says why (often a token permission). |

Each code is on [errors](/docs/agent/errors#what-status-reports).

## What it doesn't check

It never sends a request to the Gateway or an app, so `live` means the registry and Cloudflare agree, not that a request succeeded. To prove an app answers, fetch its address: a redirect to sign in is the expected answer, or Access's login page behind Access. `GET https://<gateway>/health` answers `{"status":"ok"}` without a sign-in.
