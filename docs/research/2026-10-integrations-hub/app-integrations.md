# Integrations for apps: a design

Date: 2026-10-14 · Builds on this folder's [`README.md`](./README.md) (§5) and [`raw/build-patterns.md`](./raw/build-patterns.md) (§4, §6, §9), mapped onto the code on `main` after #267–#278.

**Since this was written (2026-10-18).** Read the design below with these changes:

- **Phase 0 is built, under other names.** An app lists what it uses as `capabilities: { <id>: { access, why } }` in `everyapp.config.ts`, with no `as` or `background` (#303). It calls through the binding with `integrationFetch()` and `integrationStatus()`, and work no person started names its organization with `for: { background: true, organizationId }` (#310). Built so far: API keys the gateway holds (DataForSEO, Context.dev; #303), social networks' OAuth clients for their token endpoints (#326) and email (#325, #329). The contract is [`docs/capabilities.md`](../../capabilities.md).
- **Organization accounts and admin approval aren't built yet.** Their design moved on in [`docs/design/2026-10-google-integration.md`](../../design/2026-10-google-integration.md) and [`docs/design/2026-10-redesign-review.md`](../../design/2026-10-redesign-review.md) (#2): an API-key read is approved at deploy, and OAuth or GitHub App requests wait for an admin. TODO.md tracks both.
- **Changed from this design** in those newer designs, none of it built yet: the operator's provider clients are Worker secrets, not D1 rows. Tokens are sealed with envelope encryption under a key ring (`INTEGRATIONS_KEKS`), not a key derived from `BETTER_AUTH_SECRET`. Grants are keyed by the app's row id, not its slug (`app_capability_grants`). A single-use connect link replaces the signed setup state. The migrations are one baseline (#286), so new tables regenerate it.
- **GitHub:** the proof of concept (#281, branch `poc/github-integration`) closed unmerged on 2026-10-18; its pieces are ported by hand (the Google design's §8). A private GitHub App per organization collides on name on a hosted gateway and needs a webhook secret each, so the hosted research (`docs/research/2026-10-hosted-platform/README.md`, D9) defaults to one GitHub App for hosted and keeps the manifest-flow app for self-host. RepoLens still uses its own `GITHUB_TOKEN`.

**The feature.** The gateway holds each integration once (GitHub, Google, Slack, …). An app asks for the integrations it needs when it's installed, an admin (or each person) approves, and the app uses them through the gateway. No app registers its own OAuth app or stores a provider's secrets.

## Summary

1. **One registration per install, held by the gateway.** An admin sets up each provider once, through guided setup: one click for GitHub (App manifest flow), a prefilled Slack app, a checklist for Google's *Internal* client. The gateway stores the client secrets and every connected account's tokens, encrypted, in its own D1.
2. **Apps ask in `everyapp.config.ts`.** An entry looks like `github: { as: "org", access: "read" }`. A deploy records the request. An admin approves it once per app; for "each person's own account" requests, each person also approves the first time.
3. **Apps call through the gateway.** `integrationFetch(...)` gives any SDK (Octokit, googleapis, Slack's) a `fetch` that goes over the existing `AppGateway` service binding. The gateway checks the app's approval, the user and the URL, injects the token, and logs the call. The app never sees the token.
4. **GitHub can do better than a proxy.** A GitHub App can mint a 1-hour token cut down to the repos and permissions this one app was approved for. GitHub enforces those limits itself.
5. **Agents get the same integrations** through `/mcp`, under the same approvals. An agent's read-only consent still applies when its tool call runs app code that uses an integration.
6. **Start with GitHub, and move RepoLens off its own `GITHUB_TOKEN`.** That covers the whole path: provider setup, an org account, an app request, approval, the proxy and the narrowed token. Google and Slack come next, with per-person accounts.

```
 Admin ──(1) set up GitHub once──────────────►┌──────────── Gateway ────────────────┐
                                              │ provider clients  (encrypted)       │
 Deploy ─(2) "RepoLens wants GitHub, read"───►│ app requests ──► admin approves     │
                                              │ accounts: org + each person's       │
 Person ─(3) "Connect your Google account"───►│                                     │
                                              │ AppGateway binding:                 │
 App ────(4) integrationFetch("github") ─────►│  check app, grant, user, URL, r/w   │──► api.github.com
                                              │  inject token · refresh · log       │
 Agent ──(5) tools/call via /mcp ────────────►│ ToolBus: same accounts, same grants │──► vendor MCP / API
                                              └─────────────────────────────────────┘
```

## What's already built that this reuses

| Piece on `main` | Where | Becomes |
|---|---|---|
| `AppGateway` entrypoint: the app is identified by service-binding `props`, then checked against the registry (registered, active, same org and Worker) | `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts` | The caller check for every integration call |
| The AI proxy: the manifest's `providers` and `ai` say what an app may use, the operator's `AI_PROXY_EXTRA_ROUTES` sets the ceiling, and the gateway injects its key | same file, `ai-proxy.ts`, `packages/perimeter/src/manifest/manifest.ts` | The pattern to generalize: declare, approve within a ceiling, inject |
| SDK `createGatewayFetch({ env, request })`: a `fetch` over the binding that forwards the user's identity header | `packages/sdk/src/server/gatewayFetch.ts` | `integrationFetch()` works the same way |
| Identity JWT claims `chan` (web or mcp), `act`, `scopes` (`mcp:write`) and `tc` (tool call) | `packages/sdk/src/internal/protocol.ts` | User attribution, read-only carry-through for agents, the audit link |
| App lifecycle (register → pending → deployed → binding → active), private by default, Admin → Apps | `AppRegistrationService.ts`, `routes/admin/apps.tsx` | Where requests are recorded and approved |
| MCP consent, `mcp_connections`, `mcp_tool_calls`, the hourly maintenance cron | `server/mcp-auth/*`, `routes/settings/connections.tsx` | Consent UI patterns, the audit table, cleanup |

**Naming:** "Connections" already means AI clients (`/settings/connections`, `mcp_connections`). Third-party accounts should be **Integrations**, with each authorized account an **account**.

## The model

| Object | What it is | Who creates it |
|---|---|---|
| **Provider** | Gateway code (a "provider pack"): how GitHub authenticates, its API hosts, its permissions split into read and write, how its tokens refresh | Us, shipped in the gateway |
| **Provider client** | This install's OAuth app, GitHub App or Slack app, with its secrets encrypted | An admin, once, through guided setup |
| **Account** | One authorized third-party account: the org's (e.g. the GitHub App installed on the org) or one person's (their Google account). Tokens encrypted, with a status | An admin for org accounts; each person for their own |
| **App grant** | App X may use provider P, as the org or as each person, read or write, optionally narrowed (repos, channels) | Requested by the app's manifest, approved by an admin, and by each person for their own account |

## Asking: the manifest

```ts
// everyapp.config.ts
integrations: {
  github: { as: "org", access: "read", permissions: ["contents", "metadata"], why: "Shows repo traffic" },
  google: { as: "user", access: "read", scopes: ["gmail.readonly"], why: "Finds invoices in your email" },
  slack:  { as: "org", access: "write", why: "Posts the weekly digest" },
},
```

- **`as: "org"`** uses an org account and needs an admin's approval. **`as: "user"`** uses each person's own account and needs their approval as well.
- **`access`** is `read` or `write`. Provider-specific lists (`permissions`, `scopes`) are optional; the provider's read or write set is the default.
- **`why`** is shown on the approval screens.
- **`background: true`** lets the app use the integration with no person behind the request (crons, webhooks). Only org accounts allow it.
- Validated like `providers` and `ai` today: an unknown provider or a malformed entry fails the deploy.

## Granting and using: the flows

**A. An admin sets up a provider (once).** Admin → Integrations → "Set up GitHub". The gateway posts a GitHub App manifest; the admin clicks Create; GitHub hands back the app id, private key, client secret and webhook secret within the hour. The admin installs the app on the org, on all repos or chosen ones. That installation is the org's GitHub account. Slack works the same way through its prefilled manifest link. Google gets a checklist with copy buttons for an *Internal* client, which skips Google's verification.

**B. A deploy records what the app asks for.** The CLI already sends the manifest. The gateway compares `integrations` with the app's approved grants:
- anything new or broader becomes a **pending request**;
- anything narrower applies at once.

The deploy still succeeds and prints "RepoLens wants GitHub (org, read). Approve at https://everyapp.team/admin/apps/repolens". Until then, its calls fail with `integration_not_approved`. When the person deploying is an admin, the CLI can offer to approve on the spot.

**C. An admin approves.** Admin → Apps → RepoLens → Integrations shows each request: provider, org or each person, read or write, why. The admin picks the org account if there are several, can narrow it (only these repos), then approves or denies. Raising the request later asks again.

**D. A person connects their own account** (`as: "user"`). The app calls; the gateway answers 428 `integration_needs_account` with a connect link. The app shows "Connect Google". The link opens a gateway page, "Invoices wants to read your Gmail", and refuses anyone but the signed-in person it was made for. Google's consent screen uses the install's client, then the person returns to the app. A second app that wants the same account gets a one-click "Allow Todo to use your Google account?".

**E. The app calls.**

```ts
import { integrationFetch } from "@every-app/sdk/server";
const octokit = new Octokit({ request: { fetch: integrationFetch({ env, request, provider: "github" }) } });
```

The fetch rewrites `https://api.github.com/...` to the binding (`/api/integrations/github/...`) and forwards the person's identity header, as `createGatewayFetch` does for AI. The gateway checks, in order:
1. the caller app (props and registry, as today);
2. the grant is approved and covers this provider, org or person, read or write;
3. for `as: "user"`, the 120-second identity JWT names a person with an account who allowed this app;
4. the URL is `https:` on one of the provider's API hosts, and redirects aren't followed;
5. the method fits the grant (`GET`/`HEAD` for read, plus the provider's known read-only POSTs);
6. if the identity came from an agent (`chan: "mcp"`) without `mcp:write`, writes are refused.

It then drops the app's `Authorization` and cookies, injects the token (refreshing it under a per-account lock first if it's about to expire), strips `set-cookie`, and logs the call.

**F. GitHub's narrowed token.** `integrationToken({ env, request, provider: "github" })` returns a token GitHub limits to this app's approved repos (up to 500) and permissions, valid 1 hour ([GitHub docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)). It's for SDKs or git operations that can't take a `fetch`. Google, Slack and most others can't narrow a token, so they stay proxy-only, and handing over their raw token is an audited escape hatch an admin turns on per app.

**G. Agents.** ToolBus shows integration tools (vendor MCP servers or our curated ones) next to app tools. The consent screen picks apps and integrations. Read-only rules hold everywhere, and destructive tools stay hidden until approvals exist.

**H. Revoking.** An admin revokes an app's grant, a person disconnects an account, or a member leaves: the next call fails, since every call checks the grant. Removing an account also revokes it at the provider.

**Local dev.** `everyapp dev` has no real accounts. The dev gateway uses a token from `.dev.vars` (e.g. `EVERYAPP_DEV_GITHUB_TOKEN`) for the app's declared integrations, with the same checks, the way `OPENAI_API_KEY` works for AI today.

## Security

- **Apps never hold client secrets or long-lived tokens.** The exceptions are GitHub's 1-hour narrowed token and the per-app escape hatch.
- **A token can only reach its provider's API hosts.** An app can't send it anywhere else. A malicious app can still misuse what it was granted, so grants should be narrow: GitHub's repo narrowing helps, and so does reading `why` before approving.
- **App identity is as strong as deploy access.** `props` can only be set by someone who can deploy Workers in the account. Anyone with deploy credentials can already change the gateway, which is a known limit until a gateway-owned deployer exists.
- **People are proven by the gateway-signed identity JWT on the current request.** An app can't act for someone who isn't using it, except through `background` grants on org accounts.
- **Storage.** Envelope encryption: a key-encryption key in a Worker secret and per-org data keys in D1. No API returns a token, and a Durable Object per account serializes refresh. GitHub, Slack and Linear rotate refresh tokens, and GitHub's are single-use.
- **Audit.** Every write and every token handout gets a row. Reads are counted, not logged one by one. Payloads are never logged.
- **Agents with Gmail plus Slack can leak data.** One agent can read private data and send it out. New accounts start read-only for agents, and outbound sends need approval once approvals ship.

## Data model

New tables, in the next migration after `0032`:
- `integration_clients`: provider, mode (`github_app`, `oauth`, `cimd`, `api_key`), client id, encrypted secrets;
- `integration_accounts`: org, provider, owner (org or a person), external id and label, granted scopes, encrypted tokens, status;
- `app_integration_grants`: app, provider, as, access, narrowing, status (`pending`, `approved`, `denied`), requested and approved by and when;
- `integration_user_consents`: a person allowed app X to use their account;
- `integration_connect_links`: single-use, 10 minutes, bound to one person;
- `integration_events`: the audit trail.

[`raw/build-patterns.md`](./raw/build-patterns.md) §9.4 has the full SQL under earlier names: `provider_clients`, `connections` and `connection_grants`.

## Build order

| Phase | What | Size with agents |
|---|---|---|
| 1. GitHub end to end | Provider packs; tables and encryption; refresh lock; Admin → Integrations; GitHub App setup through the manifest flow; manifest `integrations`; pending requests at deploy plus Admin → Apps approval; `/api/integrations/*` proxy; SDK `integrationFetch` and `integrationToken`; audit. **RepoLens drops `GITHUB_TOKEN`.** | 1.5–2 weeks |
| 2. Per-person accounts | Connect links and consent; Google (Internal client checklist; Gmail, Calendar and Drive read); Slack (manifest; post messages) | 1–1.5 weeks |
| 3. Agents | Integration tools in ToolBus; consent picks integrations; vendor MCP servers through CIMD (Linear, Notion), after a 1–2 day spike on whether they accept a self-hosted gateway | 1–1.5 weeks |
| Later | Webhooks to apps (one ingest route → Queue → app); approvals for outbound sends; store apps bind to existing accounts on install; Microsoft 365; an opt-in hosted broker for low-risk providers | — |

## Decisions for you

1. **Start with GitHub, with RepoLens as the first user?** Recommended: it needs GitHub today and exercises every piece.
2. **Proxy first, with GitHub's narrowed token as the one exception?** Recommended.
3. **Who approves app requests:** always an admin in the UI, or also the admin deploying, from the CLI? Recommended: both. Store apps always ask in the UI.
4. **Per-person accounts in phase 1, or phase 2?** Recommended: phase 2. Org accounts cover GitHub and Slack first.
5. **Where provider secrets live:** encrypted in D1, so admins can rotate them in the UI, or as Worker secrets? Recommended: D1.
6. **Names:** "Integrations" for third-party accounts, keeping "Connections" for AI clients.

## Sources

- GitHub: [generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) and [the REST endpoints for GitHub Apps](https://docs.github.com/en/rest/apps/apps), opened 2026-10-14. A token takes `repositories` (up to 500) and `permissions`, and never gets more than the installation has.
- Provider requirements, setup automation, the egress options on Cloudflare, `ctx.props` authenticity, and the comparison with Composio, Nango, Pipedream and Microsoft: this folder's `raw/` reports, fetched 2026-10-12.
