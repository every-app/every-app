# Security

What Every App protects, from whom, at which boundaries, and the test that
fails when a promise breaks. It is for someone hunting for a hole and for
someone reviewing a change to the perimeter, identity, Cloudflare Access,
OAuth, tokens or secrets. Every App is alpha software: read the known gaps
before relying on anything.

**The one rule: a person's credential stops at the Gateway.** Apps never see
a cookie or a bearer token. They see a two-minute signed statement of who the
person is, minted for that app's Worker alone, or a signed marker saying
"nobody". Anything an app needs that takes a credential the operator holds
(an AI provider, an API key, a person's OAuth token, email) goes back through
the Gateway, attributed to an organization.

## The system

- **The Gateway** is the one public Worker. It signs people in, holds
  sessions, organizations, roles, tokens and the app registry in D1, serves
  `/mcp` and the OAuth server, and holds every provider key as a Worker
  secret.
- **The perimeter** (`packages/perimeter/src/gateway.ts`) runs in the
  Gateway for every app host: it picks the registry row, strips `Cookie`,
  `Authorization`, `x-everyapp-*` and `cf-access-*` (`headers.ts`), checks
  the session, organization, app access and CSRF, and mints the identity JWT
  (RS256, `aud` = the app's Worker name).
- **App Workers** are private: no routes, no `workers.dev`, no preview URLs.
  The Gateway reaches them over a service binding; the SDK verifies the JWT
  (`packages/sdk/src/internal/identity.ts`). An app calls back through the
  `AppGateway` binding, whose props (organization, app, Worker name) the
  Gateway set at upload.
- **Cloudflare Access** is on by default in front of the Gateway and the app
  hosts, as a second, independent sign-in.
- **The operator** deploys with their own Cloudflare login through the CLI;
  the CLI never calls the Gateway to deploy. Its admin commands call the
  Gateway's `/mcp` tools as a person, with a token or OAuth grant, like any
  AI client.

| Shape | `GATEWAY_DEPLOYMENT_MODE` | Sign-up | Apps | Access |
|---|---|---|---|---|
| Self-hosted (what launched) | `self_hosted` | Invite-only; the setup link makes the first owner | Private Workers in the operator's account | On by default |
| Hosted (ours, later) | `hosted` | Open into personal organizations once claimed, or invite-only | Shared first-party Workers, and third-party Workers in a dispatch namespace behind a launch gate | Ignored |
| Local (`everyapp dev`) | — | One seeded user | The app under Vite behind a gateway-lite on 127.0.0.1 | A mock |

Any other value of `GATEWAY_DEPLOYMENT_MODE`, unset included, is `invalid`
and turns every capability off (`apps/every-app-gateway/src/server/platform-policy.ts`).

## Who is trusted with what

| Actor | May | Must not be able to |
|---|---|---|
| Visitor | Sign in with an invitation or setup link; use an app's declared public routes; start an OAuth flow | Reach a private route, the control plane, a tool or a provider; learn which apps and people exist |
| Member | Open the apps they are granted (directly or through a group); call those apps' tools with their token's scopes; manage their own tokens and connections | Act in another organization; open an app not granted to them; raise their role; read others' tokens |
| Admin, owner | Invite, remove and deactivate members; grant apps; set caps, the default model, events and providers; the owner-only actions are role changes and the last owner | Change Worker secrets; deploy (unless browser installs are on); act in another organization. An owner is not the operator |
| Operator | Everything: deploy, edit D1, set secrets, mint a setup link (`docs/adr/ADR-0003-self-host-authority.md`) | Nothing is withheld. Removing an operator happens in Cloudflare |
| An app's code | Serve verified identities; call the AI proxy and the capabilities its manifest lists, for its own organization; list its organization's members who can open it; send mail within budgets | Mint identities; act for another organization; learn a provider key; use the OAuth connection of a person who hasn't allowed it; reach another app's bindings; see a cookie or a bearer |
| An AI client over MCP | List and call the tools of the apps the person can open, within the connection's apps and scopes; read-only callers see no write tools | Use its token on an app route; call a tool with a scope it lacks |
| A third-party app (hosted) | Serve its organization through a per-host session | Reach the internet except through the egress allowlist; see the first-party session cookie |
| Cloudflare, dependencies | Trusted as given (runtime, D1, KV, Access, Email Sending; installed packages with the floors in `pnpm-workspace.yaml`) | Out of scope |

The operator is root by design: one credential (the Cloudflare login) rather
than a second Gateway token that could only confirm what the login already
has. Losing it is losing the account. Everything below assumes the operator
is honest.

## What Cloudflare Access adds, and what it doesn't

With the outer ring on (`everyapp access on`, two Access applications: one
for the Gateway's host, one for the app hosts):

- A visitor never reaches the Gateway's pages or an app's private routes:
  sign-in, reset, setup, consent, every server function and every app page
  sit behind Access's login first.
- A stolen session cookie is not enough: the Gateway honours a session only
  when the same request carries a verified Access assertion for the same
  person (`Cf-Access-Jwt-Assertion`, checked against the team's JWKS for
  signature, issuer, AUD, expiry and `type: "app"`).
- Access asks the Gateway who is a member (External Evaluation, at each
  Access sign-in), so someone deactivated or removed in the Gateway is
  refused at their next Access sign-in.

What Access does not cover, so the Gateway's own checks are the only line:

- The paths Access lets through (the list is `GATEWAY_BYPASS_PATHS` and
  `appDestination` in `packages/perimeter/src/install/access-plan.ts`). On
  the Gateway's host: `/mcp`, `/mcp/*`, `/oauth/token`, `/oauth/register`,
  `/linked-dev/*`, `/.well-known/*`, `/health`, Apple's sign-in POST
  (`/api/auth/callback/apple`), Access's own membership question
  (`/access-evaluation/*`) and the OAuth client metadata documents of
  remote MCP apps (`/oauth-clients/*`: public by design, a redirect URI
  back to the Gateway and no secret). On an app's host: its bearer routes and
  `/.well-known/oauth-protected-resource` when it has any, and its public
  routes; an app host serves no MCP. Personal access tokens and OAuth
  tokens go through these paths,
  so offboarding is Deactivate in Admin → Users, which revokes sessions,
  tokens and connections at once.
- An app's public routes: whatever an app declares `public` is on the
  internet.
- Deploy authority, which is the Cloudflare account's membership.
- The identity providers on the Zero Trust team: `access on` allows only the
  one-time PIN and Sign in with Cloudflare restricted to account members,
  because the Gateway treats Access's email as verified.

## Out of scope

A compromised Cloudflare account or credential; Cloudflare itself; an honest
operator's mistakes with secrets outside the CLI (a committed `.dev.vars`);
denial of service and cost beyond the caps; timing side channels except
where a comparison guards a secret; version disclosure (the build stamp);
supply chain beyond the version floors and the lockfile audit; the browser
and the machine; social engineering; an app's own logic bugs inside its
organization (scoping a query is the app's job); the local dev gateway.

## Boundaries and their invariants

Each row is one promise and the test that fails when it breaks. Tests run
per package (`pnpm -C <package> exec vitest run <file>`, the Gateway with
`--silent=true`).

| Boundary | Invariant | Pinned by |
|---|---|---|
| B1 Browser → app host | A route is public only if the deployed manifest declares it and its path canonicalizes unambiguously; everything else is private | `packages/perimeter/src/publicRoutes.test.ts` :: defaults to deny with no routes |
| B1 | `Cookie`, `Authorization`, `x-everyapp-*` and `cf-access-*` are stripped before any request reaches an app | `packages/perimeter/src/headers.test.ts` :: removes Cookie, Authorization and all x-everyapp-\* headers |
| B1 | A cookie-carrying non-GET to a private route passes only from the app's own origin | `packages/perimeter/src/csrf.test.ts` :: denies non-GET when Sec-Fetch-Site is cross-site or none |
| B1 | An app route admits only a credential holding `*`; an MCP-only token opens `/mcp` alone | `packages/perimeter/src/gateway.test.ts` :: refuse every app route but /mcp with 403 token_scope |
| B1 | The Gateway's own bearer tokens never reach an app, public routes included | `packages/perimeter/src/gateway.test.ts` :: never forwards a gateway OAuth token to the app, even on a public route |
| B1 | The SDK's tools endpoint answers 404 from outside under any spelling | `packages/perimeter/src/publicRoutes.test.ts` :: finds the tools contract under any spelling |
| B2 Browser → Gateway host | A cookie-carrying state change on the control plane is same-origin only | `apps/every-app-gateway/src/server.test.ts` :: rejects a cookie-carrying cross-site POST to any control-plane route |
| B2 | Sign-up needs an invitation on a self-hosted Gateway, before and after the claim | `apps/every-app-gateway/src/auth/auth.sqlite.test.ts` :: refuses sign-up without an invitation, before and after the claim |
| B2 | The setup link works once, and never after an owner exists | `apps/every-app-gateway/src/server/services/SetupService.test.ts` :: refuses a valid link once the gateway has an owner |
| B2 | The last owner can't be demoted, deactivated or deleted | `apps/every-app-gateway/src/server/user-management.sqlite.test.ts` :: keeps the last owner |
| B2 | Deactivation ends every session and token at once | `apps/every-app-gateway/src/server/user-management.sqlite.test.ts` :: ends sessions and rejects the user's PAT |
| B3 Gateway → app | The SDK accepts RS256 with the pinned kid only; never `alg: none` | `packages/sdk/src/internal/identity.test.ts` :: rejects alg:none |
| B3 | A token minted for one Worker is refused by every other Worker, the same app id in another organization included | `packages/perimeter/src/integration/e2e.test.ts` :: (f) a token minted for one Worker is refused by another Worker of the same app id |
| B3 | The dev key is accepted only under `EVERYAPP_DEV` with the dev issuer | `packages/sdk/src/internal/identity.test.ts` :: refuses the dev opt-in with any issuer but the dev one |
| B3 | A tool call runs on an identity minted for that call alone | `packages/sdk/src/server/toolsEndpoint.test.ts` :: only accepts an identity minted for this exact call |
| B4 App → Gateway | A caller is the registry row its binding props name (its Worker, in its organization, by the app's id or, after a rename, an id it had), or nothing | `apps/every-app-gateway/src/server/app-gateway-entrypoint.test.ts` :: accepts valid props that match an active registry row |
| B4 | A provider key never reaches an app | `apps/every-app-gateway/src/server/ai-proxy.test.ts` :: forwards request to OpenAI with gateway-managed key and strips internal headers |
| B4 | A capability call carries the Gateway's key and nothing the app sent | `apps/every-app-gateway/src/server/integration-proxy.test.ts` :: forwards a call with the gateway's key and nothing the app sent |
| B4 | A person's OAuth token is used only for that person, by apps that person allowed, on that provider's hosts. It never holds a scope no app asked for. An MCP app's own row (`<id>-mcp`) keeps what its server grants: the token goes to that server alone | `apps/every-app-gateway/src/server/oauth/spec-flow.sqlite.test.ts` :: refuses a token carrying scopes beyond what the app asked; `apps/every-app-gateway/src/server/oauth/spec-flow.sqlite.test.ts` :: refuses a call from an app the person hasn't allowed |
| B4 | A remote MCP app's key or OAuth client is a provider row (`<id>-mcp`) bound to the server's host; a key set for another spec of the row is sent nowhere | `apps/every-app-gateway/src/server/remote-mcp/remote-mcp.sqlite.test.ts` :: sends nothing with a key set for another spec of its row |
| B4 | An OAuth MCP server is called with each member's own connection, which they allowed the app to use | `apps/every-app-gateway/src/server/remote-mcp/remote-mcp.sqlite.test.ts` :: calls with each member's own connection |
| B4 | The Gateway's client metadata document (`/oauth-clients/<id>-mcp`, public) is a public client whose one redirect URI is its own callback, the same for any well-formed id and read from no row | `apps/every-app-gateway/src/server/remote-mcp/remote-mcp.sqlite.test.ts` :: serves the app's client metadata document |
| B4 | A host the Gateway holds a key for takes a remote app only with that provider or the app's own OAuth row; never an own static key | `apps/every-app-gateway/src/server/remote-mcp/remote-mcp.sqlite.test.ts` :: lets an app's own OAuth row reach a host the Gateway holds a key for |
| B5 AI client → `/mcp` | Write tools are hidden from read-only callers | `packages/toolbus/src/policy.test.ts` :: hides write tools from read-only callers |
| B5 | Consent is a same-origin form POST from the signed-in person, spent once | `apps/every-app-gateway/src/server/mcp-auth/gateway-mcp.e2e.sqlite.test.ts` :: refuses a decision from another site, another browser, or twice |
| B5 | A revoked connection stops on its next request and its next refresh | `apps/every-app-gateway/src/server/mcp-auth/gateway-mcp.e2e.sqlite.test.ts` :: stops a revoked connection at once, and its refresh |
| B5 | A single-app token sees no other app's tools | `apps/every-app-gateway/src/server/mcp-auth/gateway-mcp.e2e.sqlite.test.ts` :: reads only with mcp:read, sees only its app, and refuses other scopes |
| B6 Access ↔ Gateway | An assertion for another Access application is refused | `apps/every-app-gateway/src/auth/cloudflare-access/jwt.test.ts` :: refuses a token for another Access application (aud) |
| B6 | Behind the outer ring a session counts only with Access's word for the same person | `apps/every-app-gateway/src/auth/cloudflare-access/access-sign-in.sqlite.test.ts` :: counts a session only with Access's word for that person, wherever it is looked up |
| B7 Operator → Cloudflare | An app Worker deploys private: no `workers.dev`, preview URL, route or undeclared binding | `packages/cli/src/lib/app/policy.test.ts` :: refuses %s |
| B7 | A worker name registered to one app is never taken by another, tombstones included | `packages/perimeter/src/registry/registration.test.ts` :: rejects a worker name already registered to another app, tombstones included |
| B7 | A release can't carry a module from outside its bundle | `packages/cli/src/lib/gateway/release.test.ts` :: refuses a release whose Worker lists a module outside its bundle |
| B8 Hosted tier | No deploy API on a self-hosted Gateway, or without the launch gate | `apps/every-app-gateway/src/server/deploy/deploy-api.sqlite.test.ts` :: has no deploy API without the launch gate, or on a self-hosted gateway |
| B8 | The first-party session cookie is never honoured on a third-party host | `apps/every-app-gateway/src/server/third-party-hosts.sqlite.test.ts` :: never honours the gateway's cookie on a third-party host |
| B9 Gateway → subscriber | Every webhook delivery is signed with a timestamp | `apps/every-app-gateway/src/server/events/events.sqlite.test.ts` :: sends the exact headers and a signature the subscription's secret verifies |
| B9 | A webhook never targets the Gateway's own hosts, nor private hosts without the flag | `apps/every-app-gateway/src/server/events/events.sqlite.test.ts` :: allows http and private hosts only with the flag, and the gateway's own hosts never |
| B10 Sign-in providers | Only an email the provider verified signs anyone in, invited or not | `apps/every-app-gateway/src/auth/sign-in-providers/sign-in-providers.sqlite.test.ts` :: refuses an email the issuer hasn't verified, invited or not |
| B10 | An ID token must be for this client and from the configured issuer | `apps/every-app-gateway/src/auth/sign-in-providers/sign-in-providers.sqlite.test.ts` :: must be for this client |

### Hosted: three rules every self-host change keeps

From `docs/hosted-vision.md`, section 3:

1. **One mode switch, fail closed.** The only read of
   `GATEWAY_DEPLOYMENT_MODE` is `platformPolicy()`; a mode-dependent
   behaviour is a field on `PlatformPolicy`, never an `if` elsewhere.
   Pinned by `apps/every-app-gateway/src/server/platform-policy.test.ts` ::
   fails closed on a missing or mistyped mode.
2. **The install row records the mode.** `_everyapp_install.deployment_mode`
   is written once and kept (`writeInstall()` in
   `packages/cli/src/lib/gateway/install.ts`); a Gateway never switches mode
   in place.
3. **The identity audience is the Worker name**, never the app id, so two
   organizations' copies of one app never accept each other's tokens.
   Pinned by `packages/sdk/src/server/everyApp.test.ts` :: takes the
   audience from EVERYAPP_AUDIENCE, never the app id, outside dev.

## Known gaps, top 11

1. **Browser installs spend an account-wide token** (B7, high). With
   `BROWSER_APP_INSTALLS` on (off by default), an owner or admin signed in
   within 10 minutes installs a release with `CF_DEPLOY_TOKEN`, which can
   rewrite every Worker and database in the account. A thin deployer Worker
   holding the token is the follow-up.
2. **The deploy policy doesn't pin the `AppGateway` binding's props** (B3,
   B7, high). On self-host only the operator deploys, so this is the
   operator misattributing their own app; it is a hosted launch-gate item.
3. **An app spends the operator's provider keys without bound** (B4,
   high). Caps count only cost a provider reports (OpenRouter, DataForSEO).
   OpenAI, Anthropic, Workers AI, Groq and remote MCP servers never move
   the cap, so a default cap doesn't bound them. Use a provider-side limit
   where offered, or Cloudflare AI Gateway rate limits. Remote MCP apps
   aren't metered at all: only the server's own plan bounds them.
4. **First-party app hosts share the control plane's session cookie** (B1,
   B2, medium; Access mitigates). Script on any app host can overwrite it
   and sign the victim in as the attacker. Per-host sessions, as third-party
   hosts have, are the fix.
5. **A stolen admin session can take over members** (B2, medium; Access
   mitigates): reset links, admin invitations and promotions need no fresh
   sign-in.
6. **Refresh tokens for connected AI apps have no replay detection** (B5,
   medium). A stolen refresh token works until the client refreshes twice;
   revoking the connection ends it.
7. **Signing out doesn't reliably sign out of Access** (B6, medium): only
   the sidebar's button sends the browser to Access's logout.
8. **The Gateway doesn't check the Zero Trust configuration itself** (B6,
   medium). `everyapp access on` makes the right shape and `access show`
   says whether the applications and the policy are there; a hand-made
   change between runs goes unnoticed.
9. **Remote MCP servers are untrusted text, and one credential is one
   identity** (B4, B5, medium). Tool descriptions and results can steer the
   model; a static key gives every member granted the app its holder's reach
   on the server (with OAuth, each member uses their own account, and
   replacing the app's credential spec deletes those connections).
10. **A sole owner has no recovery but the operator** (B2, medium), and only
    the holder can revoke a personal token (B5, low).
11. **An app a person allowed can use every scope their OAuth connection
    holds** (B4, medium), not only the scopes it lists. A person has one
    connection per provider. It holds the scopes of every app in their
    organization, and the Gateway can't narrow a token: an app allowed for
    Search Console could also call Gmail. Allowing an app is a yes or no.
    The Allow page shows only the scopes the app lists; Your connections →
    Accounts says what the connection holds in a few words on its row,
    and lists every scope in the row's details. Reconnect there allows
    each app the person already allowed for what it lists now, with no
    page per app, since that page couldn't limit the app either. An app
    the person hasn't allowed can't use the connection at all. On self-host only the
    operator deploys apps.

Lower, still open:

- Any member can read the whole member directory (emails and roles) through
  Better Auth's organization routes (B2, low).
- An unclaimed setup link stays valid for 24 hours after the CLI stops
  waiting, and the agent flow prints it into the agent's output (B2, low;
  Access mitigates).
- Public routes are easy to miss where the operator looks: the deploy
  summary doesn't name them (B1, low).
- Proxy-forwarding headers (`X-Forwarded-For` and the like) reach apps as
  the client sent them; `cf-connecting-ip` is the address to trust (B1, low).
- Privacy and `GATEWAY_URL` are enforced at deploy time only: a dashboard
  change goes unnoticed until the next deploy or `status` (B7, low).
- A webhook's signing secret is stored as written in D1 (B9, low).
- Google, Microsoft, GitHub and Apple sign-in are tested against mocked
  endpoints only (B10, low).

The full ranked list as of 2026-11-02, fixed items included, is
`git show 673bed8c8:docs/threat-model.md`, "Known gaps, ranked".

Documented, not gaps: memberships, organization status and registry rows are
cached for up to 30 seconds per isolate; an identity JWT lives 120 seconds; a
session no one revokes lasts up to 7 days.

## The security review

Run `pnpm security-review` before a pull request that touches the perimeter,
identity, Cloudflare Access, OAuth, tokens or secrets (the security-review
skill, `.claude/skills/security-review/SKILL.md`). It is one restricted,
read-only Claude Code run over the branch's diff, with this repository's
boundaries (`scripts/security-review/scan-instructions.md`), its
false-positive rules (`scripts/security-review/false-positives.md`) and this
page; `packages/cli/src/lib/securityReview.test.ts` pins its behaviour with a
fake `claude`. It is advisory, runs where you run, and has no CI job. Apps
get their own checklist in the agent docs
(`landing-page/content/agent/security-review.md`, served at
https://everyapp.com/docs/agent/security-review).

## Reporting a problem

Every App is alpha and open source. If you find a hole, we'd rather know:

- Open a private vulnerability report on the repository (**Security → Report
  a vulnerability**), not a public issue.
- Say which boundary or invariant breaks, the shape it affects (self-hosted
  or hosted, with or without Access), and how to reproduce it. A failing
  test is the best report.
- Expect a fast, informal reply from a very small team. There is no bounty.
