---
title: Cloudflare Access
description: Cloudflare Access in front of a self-hosted Gateway and its apps (on by default), everyapp access on|off|show, the policy that asks the Gateway who is a member, the paths let through, who gets in, MCP and native clients behind Access, OIDC sign-in, and recovery.
---

Cloudflare Access puts a second sign-in, at Cloudflare, in front of the Gateway and every app: Sign in with Cloudflare for members of the operator's Cloudflare account, a one-time PIN emailed to everyone else. It's on by default: `setup` turns it on once the owner exists, unless `--no-access`. The Gateway also checks Access's signed header itself on every request, so it is defense in depth, not the only gate. Free for 50 people. Self-hosted Gateways only (`ACCESS_HOSTED`). The guide an agent follows is `setup/access.md` in the everyapp skill.

The Gateway's member list is the one list behind every check. Access's policy asks the Gateway who may pass (members and invitees), so inviting someone needs no change in Access, and removing or deactivating someone takes effect in the Gateway at once and in Access at their next Access sign-in.

## `everyapp access on`

One fixed recipe, safe to run again any time. It changes only what differs and leaves alone what it didn't set up.

1. Refuses until the Gateway has an owner (`ACCESS_NOBODY_ALLOWED`) and until the live Gateway can answer Access's membership question (`GATEWAY_OUTDATED`: run `everyapp update`).
2. Finds or creates the Zero Trust team. A new team needs a name (`--team`, asked at a terminal; `ACCESS_TEAM_REQUIRED` otherwise); the sign-in page is `<team>.cloudflareaccess.com` for good.
3. Makes sure people can sign in: Sign in with Cloudflare (restricted to the account's members) and the one-time PIN.
4. Keeps one allow policy, `Every App gateway members`, whose one rule is an `external_evaluation` rule: after a sign-in, Access POSTs a signed token to `https://<gateway>/access-evaluation/evaluate`, and the Gateway answers, signed with the key it publishes at `/access-evaluation/keys`, whether that email is a member who isn't deactivated or has a pending invitation. An email list from an earlier version is replaced.
5. Keeps two Access applications on it: **Every App gateway** on the Gateway's host and **Every App apps** on `*.<app base domain>`. They're separate so an app host's Access token can never sign anyone in to the Gateway. Hostname destinations (never "Protect this Worker", which breaks WebSockets), a `720h` session, HttpOnly and binding cookies.
6. Writes the Gateway settings `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_AUD` and `CLOUDFLARE_ACCESS_APPS_AUD` every run, which picks up an application recreated by hand.

It needs a login with Access: Apps and Policies and Access: Organizations, Identity Providers, and Groups (edit) (`ACCESS_PERMISSION_MISSING`).

While Access is on, `deploy` and `delete` run this recipe themselves when they changed an app's public routes, and `update` runs it every time. If that fails (a login that can't edit Zero Trust), the command still succeeds and warns `ACCESS_UPDATE_FAILED`: run `everyapp access on`. Run it again yourself after that warning, after a browser install that changed public routes, and after changing Access by hand. Never for an invitation.

`everyapp access off` removes the three settings, then the two applications (asks; `--yes`); the team and the policy stay, and an unattended `setup` won't turn it back on. `everyapp access show` reports the team, whether the policy asks the Gateway, the sign-in methods, the applications and which settings the Worker has, without changing anything. `everyapp status` shows Access on or off.

Because the policy is External Evaluation, checked at Access sign-in rather than on every request, a removed member's Access session lasts until it expires (`720h`) while the Gateway refuses them at once; revoke it in Zero Trust → My Team → Users to end it sooner.

## Paths let through Access

Only machine endpoints that check their own credentials:

- On the Gateway's host: `/mcp`, `/mcp/*`, `/oauth/token`, `/oauth/register`, `/.well-known/*` (OAuth discovery), `/health`, `/linked-dev/*` (linked dev), `/access-evaluation/*` (Access's own membership call), `/oauth-clients/*` (remote MCP servers' OAuth reads the Gateway's client document) and `/api/auth/callback/apple`.
- On an app's host: its manifest's `public` routes, and its bearer routes (`public` entries with `bearer: true`) with `/.well-known/oauth-protected-resource` (`PROTECTED_RESOURCE_METADATA_PATH`; [native](/docs/agent/native)). An app host serves no MCP.

Access allows 25 paths per host; extra public routes stay behind Access (`ACCESS_TOO_MANY_PUBLIC_ROUTES`). Everything else, `/oauth/authorize` and the consent pages included, stays behind Access.

## What the Gateway does with Access's assertion

It verifies `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie) against the team's keys, issuer and AUD tags. On the Gateway's host it signs the person in as the verified email; elsewhere a session counts only with an assertion for the same email on that request, so a stolen Gateway cookie alone opens nothing on an app host. Behind Access, an account or session created without Access vouching for the same email is refused (`ACCESS_REQUIRED`, `ACCESS_EMAIL_MISMATCH`). Signing out goes through `/cdn-cgi/access/logout`. Apps never see Access: the perimeter strips every `cf-access-*` header.

## Who gets in

| Who | Result |
|---|---|
| A member who isn't deactivated | Signs in. |
| A deactivated member | Refused (`ACCESS_ACCOUNT_DEACTIVATED`). |
| Someone with a pending invitation | Joins with the invited role. |
| Everyone else | Refused (`ACCESS_NOT_INVITED`); Access refuses them first. |
| Anyone before the owner claimed the Gateway | Refused (`ACCESS_NOT_SET_UP`). |

An existing password account links to Access on its owner's first Access sign-in. After the owner has, `everyapp secret set EMAIL_PASSWORD_SIGN_IN` (`false`) turns passwords off. Behind Access a browser can only be signed in as the email Access asserts, so invite people by the address they sign in to Access with.

To remove someone, deactivate them in Manage workspace → Users (or `everyapp workspace deactivate`): it signs them out everywhere and revokes their tokens and AI connections.

## MCP and API clients

With the paths above, AI clients connect as on any Gateway ([mcp](/docs/agent/mcp)); the person passes Access's login once in the browser at `/oauth/authorize`. An Access assertion is never a credential on `/mcp`. The CLI's admin commands call `/mcp` like any client (their sign-in opens `/oauth/authorize` behind Access). A personal token works on every bypassed path; elsewhere on an app host it also needs an Access service token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) from a Service Auth policy on that application.

## Other settings

`CLOUDFLARE_ACCESS_IDP_IDS` (optional) limits which Access identity providers' tokens count. Every Access setting is a Worker secret on the Gateway, never something the admin UI changes.

## OIDC sign-in instead

Access can also be just a sign-in button ("Continue with Company SSO") through an Access for SaaS application: set `CLOUDFLARE_ACCESS_OIDC_ISSUER`, `CLOUDFLARE_ACCESS_OIDC_CLIENT_ID`, `CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET` and `CLOUDFLARE_ACCESS_OIDC_LABEL`. The redirect URL is `https://<gateway>/api/auth/callback/cloudflare-access`. `access on` doesn't build this; the runbook `docs/runbooks/cloudflare-access.md` has the steps. Sign-in providers are the other buttons: [signin](/docs/agent/signin).

## Recovery

- Locked out: `everyapp secret unset CLOUDFLARE_ACCESS_AUD` turns the Gateway's Access check off at once (Access still guards the hostnames), or `everyapp access off`.
- Passwords off and Access down: `everyapp secret set EMAIL_PASSWORD_SIGN_IN` with `true`.
- `ACCESS_REQUIRED` on a page, or apps sending people back to sign in: an application was recreated (a new AUD tag). Run `everyapp access on`, which writes the settings again.
- Nobody gets past Access ("You don't have access" after the PIN): the policy asks the Gateway, so it must answer. Check `/health`, that the person is a member or invited, and the Worker's logs for `access.evaluated` or `access.evaluation_refused`; `everyapp access show` says whether the policy still asks the Gateway, `access on` puts it back.
- An app's webhook or public page gets Access's login: its public routes changed without Access being updated (`ACCESS_UPDATE_FAILED`, or a browser install). Run `everyapp access on`.
- AI clients get an HTML login page: a path isn't let through. `everyapp access on` puts the bypasses back.
- WebSockets answer 403: the application is attached to the Worker; use hostname destinations (as `access on` does).
