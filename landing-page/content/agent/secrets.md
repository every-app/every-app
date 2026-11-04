---
title: Secrets, Gateway settings and capabilities
description: Where an app's keys live (a Gateway setting held once for every app, or the app's own secret), how everyapp configure and everyapp secret set put them there, and every Gateway setting by group.
---

## Where a value lives

| Place | What it is |
|---|---|
| A Gateway setting | A secret on the Gateway Worker, held once for every app: an AI provider's key, a capability's key or OAuth client, the email sender, the Access and sign-in settings. Apps never see these values; the Gateway uses them for the app (AI proxy, capability proxy). |
| The app's own secret or setting | A name the app's manifest lists under `secrets` or `settings`, set on the app's Worker and its helper Workers. Later deploys keep it. |

The deploy also puts `GATEWAY_URL` and `EVERY_APP_ORG_ID` on every app Worker; they aren't the app's to set.

Which to use: a provider in the catalog (or registered with `everyapp provider add`) goes under `providers` or `capabilities`, so the key stays on the Gateway and is shared. A key only this app uses goes under `secrets`. A value that isn't a credential and differs per install goes under `settings`. [manifest](/docs/agent/manifest#secrets)

## `everyapp configure <app>`

The one command that sets an app up. It reads what the app's deployed manifest declares, asks for each unmet setting, and sets each where it belongs (Gateway or app Worker) in one go. Changes are live at once; no deploy needed. Run from any directory with the app's id, or in the app's directory with no id.

At a terminal it shows, per unset setting, why the app needs it, where the key comes from and the setup guide, then a hidden prompt (a visible one for a plain setting). It asks which member of an unmet any-of group to set, and offers the optional ones (No by default). A ready app gets a menu to change one.

A value never goes on the command line (`VALUE_ON_COMMAND_LINE`). For an agent or a script:

```sh
everyapp configure crm                                     # a person at a terminal (best)
printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" | everyapp configure crm --json
everyapp configure crm --from-env --json                   # each unset name from $NAME
```

Stdin takes `NAME=value` lines (blank and `#` lines skipped, `export ` allowed). With neither stdin nor `--from-env`, `--json` stops with `SECRET_VALUE_REQUIRED`. Prefer handing the person the command, so keys never pass through the chat.

## `everyapp secret set NAME…`

Sets one or more names, each where it belongs, before reading any value:

1. A Gateway setting (any directory) goes to the Gateway Worker. So does any setting of a provider registered on this Gateway, a remote MCP app's `<ID>_MCP_TOKEN` among them.
2. Any other name must be one the app declares: the app in this directory, or `--app <id>` from anywhere. It goes to the app's Worker and its helpers.
3. Anything else is refused: `SECRET_NOT_DECLARED` (with `data.didYouMean` for a near miss), `SECRET_NOT_SETTABLE` (install-owned or dev-only settings), `SECRET_NAME_INVALID`, `SECRET_NAME_RESERVED`.

The value comes from exactly one source: `--from-env VAR`, a piped stdin, or a hidden prompt at a terminal (a visible, checked prompt for plain settings like `EMAIL_FROM`). One value can't set several names (`SECRET_SEVERAL_NAMES`). A plain setting that doesn't fit is `SETTING_VALUE_INVALID`. A failure part-way is `SECRETS_PARTIALLY_APPLIED`, whose `rerun` sets what's left.

`secret unset NAME…` routes the same way. `secret list [<app>]` prints names, never values: outside an app, the Gateway's settings and who set them; for an app, one row per declared setting with where it's held and whether it's set, then what's unmet.

## Gateway settings

### AI providers

`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `WORKERS_AI_API_TOKEN` (with the account), and the other AI providers in the catalog. `AI_GATEWAY_API_KEY` and `AI_GATEWAY_ID` put Cloudflare AI Gateway in front (`everyapp ai gateway on`). OpenAI paths beyond inference need no Gateway setting: the app's manifest grants them with `ai.routes`. Which provider an app gets is [ai](/docs/agent/ai). Guides: `setup/openrouter.md`, `setup/openai.md`, `setup/workers-ai.md`.

### API-key providers and OAuth clients

Every catalog provider's settings, like `DATAFORSEO_API_KEY`, `CONTEXT_API_KEY`, `STRIPE_API_KEY`, and the OAuth clients `GOOGLE_WORKSPACE_CLIENT_ID`/`GOOGLE_WORKSPACE_CLIENT_SECRET`, `MICROSOFT_365_CLIENT_ID`/`MICROSOFT_365_CLIENT_SECRET` and `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`. The full list, with hosts and how each key is sent, is the catalog on [providers](/docs/agent/providers). `everyapp provider add <id>` asks for a provider's settings.

### Email

`EMAIL_FROM` (an address, or `Name <address>`) and `EMAIL_FROM_NAME` are the sender for invitations, password resets and apps' mail. `RESEND_API_KEY` uses Resend; `EMAIL_REST_API_TOKEN` uses Cloudflare Email Sending's REST API; `EMAIL_PROVIDER` (`cloudflare` or `resend`) picks when both are set. [email](/docs/agent/email)

### MCP

`MCP_OAUTH_ENABLED` (default on) and `MCP_DCR_ENABLED` (dynamic client registration, default on) switch the OAuth server AI clients connect with. `MCP_ALLOWED_ORIGINS` adds browser origins allowed to call `/mcp`. `MCP_AUDIT_RETENTION_DAYS` keeps tool-call records (default 90). [mcp](/docs/agent/mcp)

### MCP apps

The built-in DataForSEO MCP app reads `DATAFORSEO_API_KEY`. A remote MCP app added by URL with a static key reads `<ID>_MCP_TOKEN`, a setting of its own provider row `<id>-mcp`, sent only to the server's host; set it with `everyapp secret set <ID>_MCP_TOKEN` (or when `mcp add` asks). An OAuth server's client is `<ID>_MCP_CLIENT_ID` (and `<ID>_MCP_CLIENT_SECRET`), set by `mcp add`; each member connects their own account. `--provider <id>` uses that provider's settings. [mcp](/docs/agent/mcp#mcp-apps)

### Cloudflare Access and sign-in

`everyapp access on` writes `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_AUD` and `CLOUDFLARE_ACCESS_APPS_AUD`; don't set them by hand. `CLOUDFLARE_ACCESS_IDP_IDS` limits which Access identity providers count. `CLOUDFLARE_ACCESS_OIDC_ISSUER`, `CLOUDFLARE_ACCESS_OIDC_CLIENT_ID`, `CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET` and `CLOUDFLARE_ACCESS_OIDC_LABEL` make Access a sign-in button. `EMAIL_PASSWORD_SIGN_IN` `false` turns passwords off once another sign-in works. [access](/docs/agent/access)

The six sign-in providers' settings are `<ID>_SIGNIN_<FIELD>` (`GOOGLE_SIGNIN_CLIENT_ID`, `MICROSOFT_SIGNIN_TENANT`, `OIDC_SIGNIN_ISSUER`, …), set with `everyapp signin add <id>`. [signin](/docs/agent/signin)

### Installs, hosting and events

- `CF_DEPLOY_TOKEN` and `BROWSER_APP_INSTALLS`: browser installs (`everyapp deploy-token add`). [deploy](/docs/agent/deploy#gateway-app-installs)
- `HOSTED_OPEN_SIGNUP`, `DISPATCH_NAMESPACE`, `THIRD_PARTY_DOMAIN`: a hosted Gateway only.
- `EVENTS_ALLOW_PRIVATE_TARGETS`: `true` lets webhooks target private addresses. [events](/docs/agent/events)

### Install-owned and dev-only

`setup` writes `GATEWAY_URL`, `APP_BASE_DOMAIN`, `BETTER_AUTH_SECRET`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `GATEWAY_DEPLOYMENT_MODE`, `CLOUDFLARE_ACCOUNT_ID`; `THIRD_PARTY_DEPLOYS` is the hosted launch gate. `secret set` refuses them. Rotating the identity keys is `docs/runbooks/key-rotation.md`. `MCP_ACCESS_TOKEN_TTL` and `DATAFORSEO_SANDBOX` work only in the Gateway's own `.dev.vars`.

## App secrets

Declare them in the manifest (`secrets: ["GITHUB_TOKEN"]`), deploy, then `everyapp configure <app>`. Until a required one is set the app shows Needs setup. The app reads it as `env.GITHUB_TOKEN`. A name can't be reserved (`GATEWAY_URL`, `CF_VERSION_METADATA`, `EVERYAPP_*`, `EVERY_APP_*`, `APP__*`), a Gateway setting, or a binding.

In development, put values in the app's `.dev.vars` (`GITHUB_TOKEN=…`, gitignored), including provider keys the Gateway would hold (`OPENROUTER_API_KEY`), since there's no Gateway locally. `everyapp dev --gateway <url>` uses a real Gateway's keys instead. [dev](/docs/agent/dev)

Values a deploy needs on the deploying machine (never stored on the Gateway) go in `.everyapp/secrets.env`, gitignored: `POSTGRES_DATABASE_URL` or `<BINDING>_ORIGIN_URL` for Hyperdrive, and `<BINDING>=` for a Secrets Store secret.
