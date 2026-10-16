# Identity, organizations, onboarding: what hosted Every App needs

Researcher: identity-orgs. Date: 2026-10-15. Code read at `e1d9d3c6` (this
worktree; `main` is one website-only commit ahead) and, where it changes
identity code, the in-flight CLI-redesign stack (`cli-redesign/08-checkout-is-truth`,
PRs #286-#293). Paths are relative to `apps/every-app-gateway/src/` unless
they start with `packages/`, `apps/`, `adr/` or `docs/`. "Stack" means the
file as it is on `cli-redesign/08-checkout-is-truth`.

## TL;DR

- The org model RFC-0001 asked for is mostly built: Better Auth's
  organization plugin, `activeOrganizationId` on the session, three roles,
  org-scoped repositories and middleware, an org switcher. What is missing
  for hosted is everything that lets a stranger in: sign-up is invite-only
  at the HTTP layer, only the setup claim can create an organization, and
  no code reads a hosted policy.
- Five things are built on "one gateway = one customer". They have to be
  switched off or changed for a gateway every org shares: the global
  `hasAnyOwnerMembership()` check, the `owner_bootstrap` singleton, the
  "install organization" (the oldest org with an owner, which gets the short
  `<app>.<base>` hostnames), Cloudflare Access auto-join into "the owner's
  organization", and org admins' power to ban, reset or delete accounts
  that span orgs.
- The perimeter only lets a session into an app when the session's
  **active** org owns it (`perimeter/betterAuthAuthenticator.ts:136`). It
  falls back to an org only when the user belongs to exactly one
  (`server/organization/orgContext.ts:94-98`). With a personal org per user,
  every invited user belongs to two orgs, so an app in the org that isn't
  active gets a 403, and a session with no active org redirects back to
  sign-in.
- **The biggest hosted risk is the cookie, and it's architectural.** The
  session cookie is `Domain=APP_BASE_DOMAIN`, and APP_BASE_DOMAIN is the
  gateway's own host (`auth/config.ts:204-221`, `server/app-hosts.ts:1-15`).
  Every app, including any app an org deploys itself, is a subdomain of
  it. JavaScript on any of those subdomains can write (not read) cookies
  for the parent domain. That is "cookie tossing", the reason GitHub moved
  Pages to `github.io` in 2013. The v2 design accepted the shared cookie
  because per-app cookies needed "a hand-rolled OAuth AS". The gateway now
  has an OAuth server and a one-time-code handoff (`auth/cloudflare-access/mobile-sign-in.ts`),
  so that cost is mostly paid. Hosted should put app hosts on a separate
  domain on the Public Suffix List (PSL) and give each app host its own
  `__Host-` session cookie through a redirect handoff.
- `GATEWAY_DEPLOYMENT_MODE` is read in exactly one place today: the deploy
  API gate in `server/deploy-token-auth.ts:16-67`, which the stack deletes.
  On the stack the only reader is `server/app-activation.ts:51`. No auth,
  org or onboarding code reads it. A typed `platformPolicy(env)` module has
  about 15 call sites to change (listed in §3, gap G1).
- Estimate: about 19 engineer-days for one person working with agents to
  get a safe self-serve hosted identity layer, plus PSL lead time, which
  has no SLA.

---

## 1. What exists today

### 1.1 Better Auth configuration

| Concern | Where | What it does today |
|---|---|---|
| Plugins | `auth/config.ts:307-343` | `expo` (shared), `admin()`, `organization({...})`, `cloudflareAccess(...)`, `tanstackStartCookies()` last. |
| Org creation | `auth/config.ts:310-316` | `allowUserToCreateOrganization: false`. Comment: "Only the setup claim creates an organization". |
| Org hooks | `auth/config.ts:319-334` | `afterAcceptInvitation`/`afterAddMember` grant default apps; `afterRemoveMember` deletes the user's app access in that org. |
| HTTP-closed endpoints | `auth/config.ts:162-185` | `/organization/{create,update,delete,invite-member,cancel-invitation,accept-invitation,list-invitations,get-full-organization,remove-member,update-member-role,add-member,leave}` and `/expo-authorization-proxy`. Membership changes go through gateway server functions that call `auth.api.*` server-side. |
| Invite-only sign-up | `auth/config.ts:89-108`, `:360-366` | HTTP `/sign-up/email` needs `?invitationToken=` matching a pending invitation **for the same email**. Server-side calls (no `ctx.request`) bypass the hook (`:349-351`), which is how the setup claim signs the owner up. |
| Create-org gate | `auth/config.ts:370-377` | `/organization/create` is refused until `hasAnyOwnerMembership()`. It is also closed by `disabledPaths`. |
| Default active org | `auth/config.ts:380-394` | `session.create.before` sets `activeOrganizationId` only when `resolveOrgContext` finds exactly one membership. |
| Email/password | `auth/shared.ts:13-17` | `autoSignIn: false`, `requireEmailVerification: false`. No `emailVerification.sendVerificationEmail` is configured anywhere. |
| Account linking | `auth/config.ts:252-261` | Only Cloudflare Access is a trusted provider, and only when Access sign-in is configured. No `socialProviders`. |
| Rate limits | `auth/config.ts:265-279`; `server/auth-rate-limit.ts:30-43,160-200`; `cloudflare.config.ts:141-152` | Better Auth's in-memory limiter (per isolate). Three Workers Rate Limiting bindings (IP 60/min, IP+email 10/min, email 30/min) on credential paths. A D1 `rate_limit_counters` table (`db/rate-limit.schema.ts:11-20`) for budgets that must hold across locations. It is used for OAuth DCR today. |
| Session cookie scope | `auth/config.ts:190-221`, `:274-288` | `crossSubDomainCookies.domain = APP_BASE_DOMAIN`, else GATEWAY_URL's hostname. `useSecureCookies` in production builds, so the cookie is `__Secure-better-auth.session_token`. `session.cookieCache` is off (`auth/shared.ts:8-12`), so every authenticated request reads the session from D1. |
| Schema-gen twin | `auth/cli-config.ts:17-37` | Same plugins over `sharedAuthOptions`. Any policy switch must not change the schema. |

### 1.2 Data model (`db/auth.schema.ts` and friends)

- `users` (`:4-24`) carries the admin plugin's `role`, `banned`,
  `banReason` and `banExpires`, plus a gateway `status`. Nothing sets
  `users.role` (grep: no reads or writes outside Better Auth).
- `sessions.activeOrganizationId` (`:44`) means the active org is per
  session, not per tab.
- `organizations` (`:97-104`) has a unique `slug`.
- `members` (`:106-123`) has **no unique (organization_id, user_id)**. The
  index was created in `drizzle/0012_absent_martin_li.sql:22` and dropped
  in `drizzle/0013_motionless_nitro.sql:1`.
- `invitations` (`:125-147`). Invite links carry their own token, stored
  hashed (`db/invitation-link-tokens.schema.ts`, `server/invitation-token.ts`).
- Self-host bootstrap tables: `owner_bootstrap`, a singleton with
  `CHECK id = 'owner'` (`db/owner-bootstrap.schema.ts:4-15`), and
  `owner_setup_tokens`, which the CLI mints straight into D1
  (`db/owner-setup-tokens.schema.ts:4-44`).
- `organization_keys` (`db/organization-keys.schema.ts:11-19`): a 12-char
  key that never changes, used in Worker names and hostnames. On the stack,
  candidates are the slug's letters, then the same with `2`…`50`
  (`packages/perimeter/src/registry/registration.ts:113-140` on the stack,
  `ORG_KEY_ATTEMPTS = 50`).
- `user_onboarding` (`db/onboarding.schema.ts`) has one row per user and no
  org fields.

### 1.3 Org context and roles

- `server/org-roles.ts:1-40` defines three fixed roles (`owner` > `admin` >
  `member`) and parses Better Auth's comma-separated role string.
- `server/organization/orgContext.ts:41-110` resolves `{orgId, userId, role}`
  from the session's `activeOrganizationId`, verified against `members`.
  With no active org it falls back to the user's **sole** membership
  (`:94-98`). Results are cached per isolate for 30 s with at most 500
  entries (`:15-21`, `:63-73`). `forgetOrgContext` clears only the current
  isolate.
- `middleware/auth.ts:20-109` provides `authMiddleware`, then
  `organizationMemberMiddleware`, then admin/owner middleware. Every org
  server function goes through one of them (`serverFunctions/admin.ts`,
  `apps.ts`, `userTokens.ts`, `appTokens.ts`). `getActiveOrganization`,
  `acceptInvitation` and the MCP-connection functions use `authMiddleware`
  alone.
- `server/services/MembershipService.ts`:
  - `requireManageableMember` (`:29-56`): nobody manages themselves or an
    owner, and only an owner manages an admin.
  - `requireAccountWideManageable` (`:81-99`): ban, reactivate and reset
    links only for users in no other org.
  - `deactivate` is a global ban plus revocations (`:107-118`).
- `server/services/AdminService.ts`:
  - `deleteUser` (`:76-145`) removes the membership, then **deletes the
    whole account if it has no other membership** (`:136-143`).
  - `sendPasswordResetEmail` (`:174-207`) checks only that the user is a
    member of this org, not `requireAccountWideManageable`. Any admin can
    trigger a reset email for an owner of another org. The attacker never
    gets the link, so the impact is low, but it doesn't match
    `MembershipService.createPasswordResetLink` (`:140-173`).

### 1.4 Invitations

- `server/services/InvitationService.ts:77-104`. `invite` calls
  `auth.api.createInvitation` (Better Auth checks the inviter's
  permission), mints a link token, and emails it best-effort. When email
  isn't configured or fails, the admin gets the link.
- `accept` (`:141-190`) checks the token and that the email matches, then
  calls `auth.api.acceptInvitation` server-side. Better Auth 1.7.7 then sets
  the session's active org to the new one
  (`node_modules/better-auth/dist/plugins/organization/routes/crud-invites.mjs:330`).
- UI: `routes/accept-invitation.tsx:34-200` asks the user to sign in or
  create an account. `routes/sign-up.tsx:64-106` shows the invited-account
  form only when the redirect carries an invite token, "Setup pending"
  while there is no owner (`:101-103`, `:313-338`), and "Invitation
  required" otherwise (`:376-396`).

### 1.5 Org switching UI

- `client/components/OrganizationSwitcher.tsx:23-119` is a sidebar
  dropdown over `authClient.useListOrganizations()` with a "Manage
  organizations" link.
- `client/hooks/useSetActiveOrganization.ts:11-33` calls Better Auth
  `organization.setActive`, refetches the session and collections, and
  goes home.
- `routes/_app/organizations.tsx:22-132` lists orgs with Switch buttons.
  The empty state is "Ask an owner or admin to invite you" (`:77-82`).
  There is no create button anywhere.
- `routes/_app/index.tsx:57-58` sends a session with no active org to
  `/organizations`.

### 1.6 Owner setup claim (self-host bootstrap)

- `server/services/SetupService.ts:110-203` takes the setup link (minted by
  the CLI in D1, ADR-0003 Decision 1). It refuses when
  `hasAnyOwnerMembership()`, takes the `owner_bootstrap` singleton, calls
  `auth.api.signUpEmail` server-side, creates the org server-side
  (`:167-173`), grants default apps, and consumes the link. On the stack the
  claim **adopts** an org with no members that holds apps instead of
  creating one (`SetupService.ts:155-180` on the stack;
  `OrganizationRepository.findAwaitingOwner/adoptForOwner`, stack
  `:27-79`). The deploy-token retrieval (`SetupService.ts:224-289` here) is
  deleted on the stack.
- `server/organization/owner-membership.ts:10-19`: `hasAnyOwnerMembership()`
  is "deliberately global across the gateway deployment".
- `routes/setup.tsx:45-104` and `routes/api/setup/claim.ts:39-60` serve the
  claim. `routes/api/admin/has-owner.ts:4-18` is unauthenticated.
- `server/repositories/OrganizationRepository.ts:37-52`:
  `findInstallOrganizationId()` is the oldest org with an owner. It is used
  in `server/services/AppRegistrationService.ts:154-157` to give that org
  the short hostname `<app>.<base>`. On the stack this moves to the CLI
  (`packages/cli/src/lib/gateway/registry.ts:142-200` on the stack:
  `installOrganization`, and `ensureInstallOrganization`, which creates a
  memberless org) and to `isInstallOrganization` in the shared registry
  rules (`registration.ts:157-158,196-202` on the stack).
- CLI install row: `packages/cli/src/lib/gateway/install.ts:13-33`,
  `_everyapp_install` with `CHECK (id = 'install')`. One row per gateway,
  holding account, zone, gateway host, app base domain and live app
  Workers.

### 1.7 Cloudflare Access (self-host SSO)

- `auth/cloudflare-access/membership.ts:84-93`: `findOwnerOrganizationId()`
  returns the org of the oldest owner membership.
- `:207-253`: `ensureAccessMembership` auto-joins people from
  `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`, or everyone the outer ring
  admits, into **that** org.
- `:163-200`: an Access sign-in auto-accepts every pending invitation for
  the verified email. This is a good pattern to generalize.
- `:260-284`: `EMAIL_PASSWORD_SIGN_IN=false` takes effect once *any* owner
  has linked Access.
- All settings come from Worker secrets (`auth/cloudflare-access/config.ts:1-25`),
  so they are gateway-wide, not per org.
- `auth/cloudflare-access/mobile-sign-in.ts:1-30` is the system-browser to
  app one-time-code handoff. It is Access-specific but provider-agnostic in
  shape.

### 1.8 Perimeter identity on app hosts

- `perimeter/betterAuthAuthenticator.ts:116-130` resolves the session, then
  `resolveOrgContext(activeOrganizationId)`. `hasAppAccess` (`:133-153`)
  refuses unless `session.orgId === app.organizationId` (`:136`). This is
  the documented contract in `docs/security-model.md:278-279`.
- `packages/perimeter/src/gateway.ts:277-290` authenticates every
  non-public request. A missing session gets a 302 to `loginUrl?return_to=`
  (`:360-370`).
- `utils/auth.ts:38-67`: `getSafeReturnTo` accepts only hosts that are
  subdomains of the gateway's own host (`:61-65`).
- `server.ts:216-229`: unknown subdomains of the gateway host or the app
  parent get a 404. `:244-252` sets `issuer` and `loginUrl` from
  GATEWAY_URL.
- `packages/perimeter/src/headers.ts:178-187,204-209,228-230` strips
  `Domain=` from app `Set-Cookie` headers. Inbound `Cookie` is stripped
  before proxying (`docs/security-model.md:13`).
- Mobile shell: `apps/mobile-native/src/lib/webview-cookies.ts:15-75`
  copies the Better Auth cookies into the WebView store with
  `domain: <gateway host>`.

### 1.9 Mode flag

- Declared as an optional **secret** (`cloudflare.config.ts:24-34`) and
  typed in `env.d.ts:17-18`. The self-host CLI writes `self_hosted`
  (`packages/cli/src/lib/gateway/secretsFile.ts:52`).
- Read here only by `server/deploy-token-auth.ts:16-29,55-67`: deploy API
  404 unless `self_hosted`.
- On the stack, `server/deployment-mode.ts:1-16` holds
  `resolveDeploymentMode`, read only by `server/app-activation.ts:47-53`
  (self-host activation). The deploy API and its tests are deleted, so
  RFC-0001's "hosted-mode tests verify `/api/internal/*` is disabled"
  becomes moot.

---

## 2. What the hosted tier needs (identity, orgs, onboarding)

From the brief: "Each user who signs up gets their own organization, or is
invited to one. Multi-tenant." RFC-0001 §Onboarding Model, hosted
(`adr/RFC-0001-org-rearchitecture-phase-1.md:27-31`) says the same: invite,
then join, else create a personal org and set it active. Platform
administration must never be a customer-visible org (`:39-42`).

A concrete target:

1. **Sign-up.** Anyone can sign up with email and password (verified) or
   with Google or GitHub. Turnstile on credential endpoints, plus global
   sign-up budgets.
2. **First session.**
   - With pending invitations for the verified email: auto-accept them (the
     Access pattern in `auth/cloudflare-access/membership.ts:163-200`,
     generalized) and make the newest one active. No personal org.
   - Without: create a personal org (unique slug, unique org key) and make
     it active.
3. **More orgs.** Users may create more orgs, up to a limit, through a
   gateway server function (the Better Auth HTTP route stays closed so the
   gateway's own cleanup and policy run). They may leave an org, and delete
   their account.
4. **Switching.** Switching sets the control-plane context only. App hosts
   decide the org from the app (host → app → `organizationId`) and check
   membership in *that* org, so tabs on two orgs' apps both work.
5. **Org admins** invite, change roles and remove members, and manage app
   access in their own org. They never ban, reset or delete **accounts**.
   Those powers belong to the user and the platform operator.
6. **Platform operator.** A separate surface, not a customer org and not a
   customer-reachable Better Auth role. It handles abuse bans, org
   suspension and support lookups.
7. **Off in hosted.** The setup claim, owner bootstrap, install
   organization, Access auto-join/outer ring/password toggle, and any
   "first owner" semantics.
8. **Cookies and hosts.** The control plane is on our own domain. App hosts
   are on a PSL-listed domain, each with a host-only session minted from
   the control-plane session.

---

## 3. Gaps, and the smallest change that closes each

Sizes are engineer-days for one person working with agents.

### (a) RFC-0001 Phase 1 scorecard

| Phase 1 item (`adr/RFC-0001...:69-90`) | Status | Evidence / what's left |
|---|---|---|
| 1. Org + membership model; `organizationId` on app tables | **Done** | `db/auth.schema.ts:97-147`; `apps`, `user_app_access` and `organization_keys` keyed by org. Small hole: no unique `(organization_id, user_id)` on `members` (G13). |
| 2. Active organization context | **Done for self-host, wrong for hosted** | `sessions.activeOrganizationId`; `orgContext.ts:41-98`; `middleware/auth.ts:50-73`. Hosted breaks it: multi-org users get no default org (`auth/config.ts:380-394`), and the perimeter gates on the active org (G7). |
| 2. Org-role authorization checks | **Done** | `middleware/auth.ts:78-109`; `MembershipService.ts:29-56`. Three fixed roles; no billing or deploy permission split yet. |
| 3. Org filters in all critical queries | **Done for tenant data; global "install" queries remain** | Repositories take `organizationId` (`server/repositories/AppRepository.ts:59-160,230-238`, `AppAccessRepository.ts:17-190`). Lookups by hostname or Worker name are global by design. Still global and single-tenant by intent: `hasAnyOwnerMembership` (`owner-membership.ts:10-19`), `findInstallOrganizationId` (`OrganizationRepository.ts:37-52`), Access `findOwnerOrganizationId` and `ownerHasAccessSignIn` (`membership.ts:85-93,260-273`). G8. |
| 4. Token/app/org consistency; platform key injection; usage dims | **Done (consistency); usage logged, not billed** | `server/app-gateway-entrypoint.ts:104-106,247`; PATs org-bound (`betterAuthAuthenticator.ts:76`); `ai.proxy.usage` carries `{organizationId, appId}` (`server/ai-proxy.ts:176-184`, caller from `app-gateway-entrypoint.ts:138`). Billing belongs to other researchers. |
| 5. Create / join / switch org | **Join and switch done; create not done** | Join: `InvitationService.ts:141-190`. Switch: `OrganizationSwitcher.tsx`, `organizations.tsx`. Create is closed by design (`auth/config.ts:310-316,163`). G6. |
| 5. Org-scoped admin management | **Done for self-host** | `serverFunctions/admin.ts` behind org admin/owner middleware. Hosted needs the account/org power split (G9). |
| 6. Tests: cross-org isolation, role auth, token misuse, e2e | **Partial** | Scattered: `server/user-management.sqlite.test.ts:298,334`, `server/invites-without-email.sqlite.test.ts:424`, `server/mcp-auth/gateway-mcp.e2e.sqlite.test.ts:1869-2217`, `server/app-lifecycle.sqlite.test.ts:246`, `server/organization/orgContext.test.ts:108-150`. No suite that sweeps every org server function with another org's ids, and no hosted-mode policy tests. G12. |
| Acceptance: "onboarding functional in both modes" | **Not done** | No hosted onboarding exists. G2-G6. |

### (b) Gaps for self-serve sign-up

**G1. A hosted policy module and mode plumbing (0.75 d).**
- *Gap.* Nothing in auth, orgs or onboarding reads the mode (§1.9).
  `GATEWAY_DEPLOYMENT_MODE` is an optional secret, so a missing secret
  silently means "invalid".
- *Smallest fix.* Add `server/platform-policy.ts`: `platformPolicy(env)`
  built on the stack's `resolveDeploymentMode`, returning a frozen object:
  - `mode`, `openSignUp`, `personalOrgOnFirstSession`, `usersCreateOrgs`,
    `orgLimit`
  - `setupClaim`, `accessSignIn`, `installOrgShortHosts`
  - `orgAdminsManageAccounts`, `requireEmailVerification`, `captcha`,
    `socialProviders`

  `invalid` must yield the most closed value of every field: no open
  sign-up, no setup claim, no Access auto-join. Expose the client-safe part
  through the existing `GET /api/auth/sign-in-methods`
  (`auth/cloudflare-access/plugin.ts:343-357`) by adding
  `signUp: "open" | "invite"` and providers. Make the mode a
  release-patched text binding, like `APP_BASE_DOMAIN`
  (`cloudflare.config.ts:176-178`), not a secret, so a hosted artifact
  can't come up without it.
- *Where it has to be consulted*, to answer question (e):
  - `auth/config.ts`: `:252-261` account linking, `:265-273` rate limit,
    `:307-343` plugins (Access, captcha, social), `:310-316`
    `allowUserToCreateOrganization`, `:360-366` invite-only hook,
    `:370-377` create-org gate, `:380-394` default org.
  - `auth/shared.ts:13-17`: email verification. Runtime only; `cli-config.ts`
    stays schema-only.
  - `routes/sign-up.tsx:64-106`, `routes/setup.tsx`,
    `routes/api/setup/claim.ts`, `routes/api/admin/has-owner.ts`,
    `serverFunctions/admin.ts:26-30`.
  - `server/services/SetupService.ts`, and `OrganizationRepository` (here
    `findInstallOrganizationId`; on the stack `findAwaitingOwner`).
  - `server/services/AppRegistrationService.ts:154-157` (stack: the
    `isInstallOrganization` input).
  - `auth/cloudflare-access/membership.ts`.
  - `server/services/MembershipService.ts:81-173` and
    `server/services/AdminService.ts:76-207`.
  - `perimeter/betterAuthAuthenticator.ts:116-153`.
  - `routes/_app/organizations.tsx:77-82` and
    `client/components/OrganizationSwitcher.tsx:110-115`.

**G2. Open sign-up and a personal org on first session (1.5 d).**
- *Gap.* `enforceInviteOnlySignUp` (`auth/config.ts:89-108`) refuses every
  HTTP sign-up without an invite. Only the claim creates orgs.
- *Smallest fix.*
  - When `policy.openSignUp`, skip the invite check, but keep it when an
    `invitationToken` is present so the token is validated.
  - In `databaseHooks.session.create.before` (`auth/config.ts:380-394`),
    the one place every sign-in method passes through (password, social,
    after email verification): if the policy says so and the user has zero
    memberships, first accept pending invitations for the verified email
    (move `acceptPendingInvitations` out of
    `auth/cloudflare-access/membership.ts:163-200` into
    `server/organization/`). If none, insert the personal org and owner
    membership in one `db.batch`, the way the stack's
    `OrganizationRepository.adoptForOwner` does. Then pick the active org.
  - Do it here rather than in `user.create.after`, because session creation
    is retried naturally and covers users whose first sign-up attempt died
    mid-way.
  - Slug: `slugify(name)` plus a random 6-char suffix. `organizations.slug`
    is unique, and `SetupService.ts:71-80`'s plain slugify collides at
    once.
  - The sign-up page gets an open form when `signUp === "open"`
    (`routes/sign-up.tsx:101-105`).

**G3. Email verification (1 d).**
- *Gap.* `requireEmailVerification: false` (`auth/shared.ts:16`), and no
  `emailVerification` config. Hosted needs verified emails for three
  reasons:
  1. Invitations are matched by email (`InvitationService.ts:168-175`).
  2. Social account linking requires a verified local email: Better Auth's
     `requireLocalEmailVerified` defaults to true
     (`node_modules/better-auth/dist/oauth2/link-account.mjs:138-139`), and
     unverified accounts can't link, which breaks "sign in with Google
     later".
  3. Free credits are an abuse target.
- *Smallest fix.* In hosted only:
  - `emailVerification.sendVerificationEmail` through the existing
    `server/email/sendEmail.ts`, with `sendOnSignUp: true` and
    `autoSignInAfterVerification: true`.
  - `emailAndPassword.requireEmailVerification: true`.
  - Organization `requireEmailVerificationOnInvitation: true`.
  - A small `/verify-email` page. The link goes in the query string, like
    the reset links (`server/email/links.ts`).
- *Dependency.* Cloudflare Email Sending is **beta**, and arbitrary
  recipients need Workers Paid (developers.cloudflare.com/email-service,
  page dated 2026-10-15). The `everyapp.com` sender isn't set up yet
  (`TODO.md` on main, "Email still says support@everyapp.dev").

**G4. Turnstile and sign-up budgets (1 d).**
- *Gap.* The Workers Rate Limiting bindings count per Cloudflare location
  and are "permissive, eventually consistent"
  (developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit). Fine
  for brute force; weak against distributed sign-up farms.
- *Smallest fix.*
  - Better Auth 1.7.7 ships a `captcha` plugin with provider
    `cloudflare-turnstile`. Its default endpoints are `/sign-up/email`,
    `/sign-in/email` and `/request-password-reset`
    (`node_modules/better-auth/dist/plugins/captcha/constants.mjs:9-13`).
    The token goes in the `x-captcha-response` header. Add it in hosted,
    plus the Turnstile widget on `sign-up`, `sign-in` and `forgot-password`.
  - Add `/sign-in/social` to its endpoints so social sign-up farms pay too.
  - Add a global daily budget for *org creation* (personal and explicit) in
    `rate_limit_counters`, keyed by `/24` or `/48` and by day. The table
    exists for exactly this kind of cross-location budget
    (`db/rate-limit.schema.ts:4-10`).

**G5. Social login: Google and GitHub (2 d; 1 web, 1 mobile).**
- *Gap.* No `socialProviders`. `sign-in-methods` lists only Access
  (`plugin.ts:351-353`). The mobile system-browser handoff is
  Access-specific (`mobile-sign-in.ts`), and Google blocks embedded
  WebViews (`docs/architecture-v2-recommendation.md:44`).
- *Smallest fix.*
  - Add `socialProviders.{google,github}` from secrets, and
    `accountLinking.trustedProviders: ["google"]` (Google asserts verified
    emails). GitHub links only to verified local accounts, which is
    Better Auth's default.
  - Generalize `sign-in-methods` and the sign-in/sign-up buttons.
  - Lift `mobile-sign-in.ts`'s start/continue/finish handoff off
    `ACCESS_PROVIDER_ID` so it works for any configured provider.
  - In hosted, Access sign-in is off (G8).

**G6. Users create orgs; create button (1 d).**
- *Gap.* `allowUserToCreateOrganization: false`, and `/organization/create`
  is closed.
- *Smallest fix.* A gateway server function `createOrganization` behind
  `authMiddleware` and the policy. It counts the user's owned orgs against
  `policy.orgLimit`, assigns a unique slug and org key up front, calls
  `auth.api.createOrganization` server-side (`{userId}`, as the claim does
  in `SetupService.ts:167-173`), and switches the session to the new org.
  Keep the Better Auth route closed so the gateway's limit, Turnstile
  budget and billing-customer creation (other researchers) always run.
  Add a "Create organization" item in `OrganizationSwitcher.tsx:110-115`
  and on `/organizations` (`:77-82`).

**G7. Org resolution on app hosts and default org for multi-org users (1 d).**
- *Gap.* `hasAppAccess` requires `session.orgId === app.organizationId`
  (`perimeter/betterAuthAuthenticator.ts:136`), and `authenticate` returns
  null when a multi-org session has no active org (`:119-123` plus
  `orgContext.ts:94-98`). That means a 302 back to sign-in, which
  `routes/sign-in.tsx:109-134` turns into a "stalled" page. With personal
  orgs this is the common case, not an edge case.
- *Smallest fix.* On app hosts, resolve membership in **the app's** org:
  `resolveOrgContext({userId, activeOrganizationId: app.organizationId})`.
  This needs `authenticate` to receive the resolved app; the perimeter has
  it before calling (`packages/perimeter/src/gateway.ts:279`). The minted
  JWT's `orgId` is then the app's org, which is what the SDK and the
  `AppGateway` entrypoint already assume (`app-gateway-entrypoint.ts:247`).
  For the control plane, `session.create.before` should pick the last-used
  org: add `users.lastActiveOrganizationId`, written by a wrapper around
  `setActive`, instead of failing closed on two or more memberships.
  Update `docs/security-model.md:278-279`.

**G13. Schema hygiene for many orgs (0.5 d).**
- Restore `UNIQUE(organization_id, user_id)` on `members`. Direct inserts
  in `auth/cloudflare-access/membership.ts:181-187,238-244` and the stack's
  `adoptForOwner` can race.
- In hosted, org keys get a random suffix instead of `orgKeyCandidates`'
  50 numbered attempts. Fifty orgs named "Ben" exhaust them and new orgs
  get `ORG_KEY_UNAVAILABLE`.
- Assign the org key at org creation, not at first app registration
  (`db/organization-keys.schema.ts:5-10`), so the workspace's hostnames are
  known up front.

**G14. Invitations in hosted (0.75 d).**
- Invites must be emailed. With the platform sender, keep the copy-link
  fallback (`InvitationService.ts:96-103`) but only for verified-domain
  orgs? See founder question Q8.
- Auto-accept on verified sign-in comes from G2.
- On the sign-up page, an invite token means "join only": skip the
  personal org. That already falls out of G2's order (invitations first).
- Today an admin-shared link is a bearer secret to whoever holds it
  (`auth/config.ts:82-108`), as long as the email matches. With
  verification on (G3), that also requires owning the mailbox.

### (c) Where the claim flow and install-row assumptions conflict with a shared gateway

**G8. Turn off the single-tenant bootstrap and the "install organization" in hosted (1 d).**

| Assumption | Where | What goes wrong in a shared gateway | Smallest fix |
|---|---|---|---|
| "Has the gateway got an owner?" is global | `server/organization/owner-membership.ts:10-19`; used at `auth/config.ts:370-377`, `routes/sign-up.tsx:101-103`, `routes/setup.tsx:67`, `SetupService.ts:116,126-131`, `routes/api/admin/has-owner.ts` | Before the first customer, every visitor sees "Setup pending: run `everyapp gateway claim-link`". After it, the answer is meaningless. | Policy-gate: in hosted, `/setup` and `/api/setup/claim` return 404, `hasOwner` isn't served, and the create-org gate isn't used (G6 replaces it). |
| One bootstrap claim per gateway | `db/owner-bootstrap.schema.ts:13`; `owner-membership.ts:21-62` | Harmless but dead in hosted. | Leave the table; unreachable when the claim 404s. |
| Setup links minted by the operator's Cloudflare login | ADR-0003 Decision 1 (`adr/ADR-0003-self-host-authority.md:24-31`); `db/owner-setup-tokens.schema.ts` | Hosted customers have no D1 access (ADR-0003 Decision 5, `:41-43`). | Nothing: the claim is off. Platform staff never need it. The operator surface is G10. |
| The install organization gets bare hostnames | `OrganizationRepository.ts:30-52`, `AppRegistrationService.ts:154-157`; stack: `registration.ts:157-158,196-202`, CLI `registry.ts:142-200` | The first customer to sign up would own `todo.<base>`, `openseo.<base>` and so on: namespace squatting on the catalog's names. | Hosted passes `isInstallOrganization: false` for every org. A hosted control plane calling the registry rules (ADR-0003 Decision 2) supplies it. |
| A memberless org with apps is adopted by the next claim | Stack: `SetupService.ts:155-164`, `OrganizationRepository.findAwaitingOwner/adoptForOwner` | Any customer org whose last member left would be takeover bait if the claim were reachable. | Claim 404 in hosted. Separately: a hosted org whose last owner leaves gets suspended, never adopted (G9). |
| Access auto-join targets "the owner's organization" | `auth/cloudflare-access/membership.ts:84-93,207-253` | `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS` would add strangers to whichever customer's owner membership is oldest. | `policy.accessSignIn = false` in hosted: don't register `cloudflareAccess` and don't trust it for linking (`auth/config.ts:252-261,339`). Per-org enterprise SSO later is a different design (per-org IdP config in D1). |
| Password sign-in can be switched off gateway-wide by any owner linking Access | `membership.ts:260-284`, `auth/config.ts:353-358` | One customer's owner would change sign-in for everyone if the secret were set. | Same: Access off in hosted. |
| Owners are immutable | `MembershipService.ts:45-48`; `AdminService.ts:98-100`; `TODO.md` "Owner recovery link and ownership transfer" | Hosted needs ownership transfer and multiple owners for support and churn. | `transferOwnership` server function, owner-only, which demotes self to admin (0.5 d, inside G9). |
| CLI install row is a singleton | `packages/cli/src/lib/gateway/install.ts:13-33` | Not an identity conflict. The hosted gateway is deployed by the platform's own pipeline, and the row can stay as a platform-ops record. Its `live_app_workers` service-binding list doesn't apply to WfP. | Out of scope here. Flag for the deploy researcher. |
| `deployed_by_actor` is a Cloudflare identity | ADR-0003 Decision 4 | Hosted actors are gateway users. | The hosted control plane writes `user:<id>`. |

**G9. Split account powers from org powers; leave, transfer, delete (1.5 d).**
- *Gap.* Several flows assume the org owns the account:
  - Org admins ban accounts (`MembershipService.deactivate`, `:107-118`)
    and mint reset links (`:140-173`). Both are guarded only by "user is in
    no other org".
  - `AdminService.deleteUser` deletes the platform account when it has no
    other membership (`AdminService.ts:136-143`).
  - `sendPasswordResetEmail` lacks the account-wide guard (`:174-207`).
  - Users can't leave (`/organization/leave` closed, `auth/config.ts:174-177`)
    or delete themselves (Better Auth `deleteUser` is off by default).
- *Smallest fix.* When `!policy.orgAdminsManageAccounts`:
  - Org admins' "deactivate" becomes "remove from org" (existing cleanup at
    `AdminService.ts:132-134`).
  - `deleteUser` never deletes the account.
  - Reset-link and reset-email functions return 404.
- Add `leaveOrganization`: a gateway server function that runs the same
  cleanup as removal and refuses the last owner.
- Add `transferOwnership`.
- Add `deleteMyAccount`: Better Auth `user.deleteUser.enabled` with a fresh
  session. It refuses while the user is the sole owner of an org that has
  other members or a paid plan.

**G10. Platform operator surface, separate from customer orgs (2 d).**
- *Gap.* RFC-0001 says to keep the admin plugin "for platform/global admin
  capabilities" (`:46-47`) but never use an admin org (`:41-42`). Today the
  admin plugin is registered (`auth/config.ts:309`), and its 15 HTTP
  endpoints are **open**: `/admin/impersonate-user`, `/admin/list-users`,
  `/admin/set-role`, `/admin/ban-user` and others
  (`node_modules/better-auth/dist/plugins/admin/routes.mjs`). They are
  inert only because no user has `users.role = "admin"`. Granting that
  role to a platform operator would make any XSS or phished session of
  theirs a cross-tenant skeleton key. On today's shared-cookie design that
  includes every app subdomain.
- *Smallest fix.*
  1. Add `"/admin/*"` (the exact list) to `DISABLED_AUTH_PATHS`.
  2. Serve an ops console on a separate host (`ops.everyapp.com`) that only
     Cloudflare Access protects. Verify the Access JWT with the existing
     `auth/cloudflare-access/jwt.ts` verifier against an ops-only AUD.
     Compare the Access email to an `OPS_EMAILS` secret.
  3. Console actions call services server-side: list orgs and users, ban
     and unban an account, suspend an org, read usage. Each action goes
     through `logEvent`.

  No impersonation in v1. Access is already the founder's tool
  (`docs/runbooks/cloudflare-access.md`), and this keeps operator identity
  out of the customer user table entirely.

### (d) Where the session cookie's scope is decided, and the hostname constraint

**Where it is decided.**
1. `auth/config.ts:204-221` (`resolveCookieDomain`). Production: APP_BASE_DOMAIN
   (`server/app-hosts.ts:26-29`), else GATEWAY_URL's hostname. Dev:
   `EVERYAPP_DEV_COOKIE_DOMAIN`.
2. `auth/config.ts:280-287` passes it as Better Auth
   `advanced.crossSubDomainCookies`. `useSecureCookies` (`:275`) sets the
   `__Secure-` prefix. HttpOnly and SameSite=Lax are Better Auth defaults.
3. `tanstackStartCookies()` (`auth/config.ts:340-342`) decides nothing about
   scope. It forwards Better Auth's `Set-Cookie` headers out of TanStack
   server functions, so it must stay last.
4. `server/control-plane-guard.ts` (stack `:108-120`) keeps the Domain on
   control-plane responses (`stripCookieDomains: false`). The perimeter
   strips Domain from app responses (`packages/perimeter/src/headers.ts:178-187`).
5. The mobile shell re-scopes its copy to the gateway host
   (`apps/mobile-native/src/lib/webview-cookies.ts:58-75`).

**The constraint this puts on hosted hostnames today.**
- APP_BASE_DOMAIN *is* the gateway host. Apps must be exactly one label
  below the gateway host (`server/app-hosts.ts:1-15`; registry naming
  `<app>-<orgKey>.<base>`, stack `registration.ts:196-202`).
- `return_to` must be a subdomain of the gateway host (`utils/auth.ts:61-65`).
- The gateway 404s unregistered subdomains of itself (`server.ts:216-229`).

So with today's code the hosted gateway at `X` serves apps at
`<app>-<org>.X`, and the session cookie goes to every one of them. Three
consequences:

1. **Cookie tossing across tenants (critical once orgs deploy their own
   apps).**
   - A browser lets a page on `evil-acme.X` set `Domain=X` cookies through
     `document.cookie`. MDN: "a response from `api.example.com` can set
     `Domain=example.com`", and only public suffixes are refused
     (developer.mozilla.org Set-Cookie). Server-side stripping
     (`headers.ts:178-187`) can't stop client-side JS.
   - An org app can therefore plant its own
     `__Secure-better-auth.session_token` on a narrower Path for every
     visitor. The victim's control-plane actions then run in the
     attacker's account: entering provider keys, approving MCP consent,
     paying. That is login CSRF or session fixation. GitHub moved Pages to
     `github.io` on 2013-04-05 for exactly this ("possible to write (but
     not read) github.com domain cookies").
   - The v2 design accepted the shared cookie for self-host "at consumer
     scale" (`docs/architecture-v2-recommendation.md:96,105`), when every
     app was the operator's own. Hosted invalidates that premise.
   - Better Auth's own docs warn: "Consider using separate domains for
     untrusted services" (better-auth.com/docs/concepts/cookies).
2. **The marketing site.** `everyapp.com` is the landing page's Workers
   Custom Domain (`landing-page/wrangler.jsonc` on main). The gateway
   can't take the apex, so it would be e.g. `app.everyapp.com`, and apps
   would need `*.app.everyapp.com`. That is a second-level wildcard
   certificate, which Universal SSL doesn't cover (Advanced Certificate
   Manager does).
3. **Routing limits (for the deploy and hostname researchers).** Workers
   allow 100 Custom Domains per zone, and Cloudflare says "If you require
   more than 100 custom domains per zone, consider using a wildcard route"
   (developers.cloudflare.com/workers/platform/limits). The stack deletes
   wildcard-route support (commit `bc2a55d1` "Serve apps only through
   per-app Custom Domains"), so hosted needs it back, or a WfP dispatch
   Worker on a wildcard route.

**G11. Separate PSL-listed app domain plus a per-host session handoff (3.5 d + PSL lead time).**

*Smallest fix that is actually safe:*
1. Control plane at `app.everyapp.com` (or `everyapp.com/app` if the
   landing page is merged). Its Better Auth cookie is host-only: drop
   `crossSubDomainCookies` in hosted.
2. Apps at `<app>-<orgKey>.<appsdomain>` on a domain we submit to the PSL
   private section (the architecture doc already sketches
   `{app}-{tenant}.everyapp.host`, `docs/architecture-v2-overview.md:387`).
   Once listed, each app host is its own site, so tossing across tenants is
   impossible and SameSite cookies stop crossing between apps.
3. The perimeter gets a `HostSessionAuthenticator`, behind the existing
   `SessionAuthenticator` interface (`packages/perimeter/src/session.ts`):
   - An app host with no host cookie redirects to
     `app.everyapp.com/api/auth/app-session?host=…&state=…`.
   - The gateway checks its session, membership in the app's org and app
     access, then mints a one-time code (a 60 s `verifications` row bound
     to host and state, the same pattern as `mobile-sign-in.ts:21-29`) and
     redirects to `https://<apphost>/__everyapp/session?code=…`.
   - The perimeter redeems the code and sets
     `__Host-everyapp_s=<opaque id>; Secure; HttpOnly; Path=/; SameSite=Lax`.
     MDN: `__Host-` cookies "must not have a Domain attribute … only sent
     to the host that set them".
   - The id maps to a row bound to the gateway session. Sign-out or
     revocation of the gateway session kills it.
   - Cloudflare Access issues per-application `CF_Authorization` cookies
     from one team-domain session the same way
     (developers.cloudflare.com/cloudflare-one/.../authorization-cookie).
4. Two more changes follow: `getSafeReturnTo` accepts registered app hosts
   (a D1 lookup) instead of "subdomain of the gateway"
   (`utils/auth.ts:61-65`), and the mobile WebView just follows the
   redirects, so `webview-cookies.ts` only needs the gateway-host cookie.

*Why now:* the v2 rejection of per-app cookies was its price, "a
hand-rolled OAuth AS" (`architecture-v2-recommendation.md:96`). The gateway
now has an OAuth server (`server/mcp-auth/*`) and a hardened one-time-code
handoff (`mobile-sign-in.ts`). Most of that price has been paid.

*Lead time:* the PSL has "NO SERVICE LEVEL AGREEMENTS ON TIME". Changes
"may take time to percolate to clients". Private-section domains need at
least two years of registration remaining (github.com/publicsuffix/list/wiki/Guidelines).
Pick and submit the apps domain in week one.

### (e) Mode flags: summary

- **Read today:** only `server/deploy-token-auth.ts:55` (the deploy API).
  On the stack, only `server/app-activation.ts:51`.
- **Must be read:** see G1's list. The rule is one typed policy object
  computed once per isolate, with no `env.GATEWAY_DEPLOYMENT_MODE` reads
  scattered through the code. Every hosted-opening field is closed on
  `invalid`, and every self-host-only power (claim, Access auto-join, D1
  activation) is off on anything but `self_hosted`.

### Other gaps found while reading

**G12. Cross-org and hosted-policy test suites (1.5 d).**
- A table-driven SQLite test with two orgs and three roles each calls every
  server function in `serverFunctions/*.ts` with the other org's ids and
  expects a deny.
- Perimeter tests for a multi-org user opening both orgs' apps (G7).
- Hosted-policy tests: open sign-up creates exactly one personal org; an
  invited sign-up creates none; `/setup` and `/api/setup/claim` return 404;
  Access off; `/admin/*` returns 404; org admins can't ban.
- The harness exists (`test/registry.ts` on the stack,
  `server/user-management.sqlite.test.ts`).

**G15. Session reads per request at hosted scale (0.5 d).**
- `session.cookieCache` is off (`auth/shared.ts:8-12`), so every
  authenticated app request reads the session from the one D1 database.
  D1 "is inherently single-threaded"; at 1 ms per query that is at most
  about 1,000 qps per database (developers.cloudflare.com/d1/platform/limits).
- In hosted, turn on `cookieCache` with `maxAge` around 60 s. That accepts
  a 60 s revocation lag, already the trade-off `orgContext`'s 30 s cache
  makes (`orgContext.ts:63-64`). Alternatively, put sessions in KV
  secondary storage.
- With G11 the per-host session row can carry its own short cache.

### Suggested PR order (each ships alone)

1. G1 policy module and release-patched mode binding; G8 hosted-off
   switches; G10's `/admin/*` closure (2 d).
2. G13 schema hygiene; G2 open sign-up and personal org; G7 app-org
   resolution and last-active org (3 d).
3. G3 email verification; G4 Turnstile and budgets; G14 invitations (2.75 d).
4. G6 create org; G9 leave, transfer, delete and the power split (2.5 d).
5. G12 test suites, written alongside 2-4 and finished here (1.5 d).
6. G11 PSL domain and per-host session handoff, after the domain is
   chosen. Start the PSL PR on day 1 (3.5 d).
7. G5 social login (2 d); G10 ops console (2 d); G15 cookie cache (0.5 d).

Total: about 19 engineer-days for one person with agents. G11 dominates
the risk, not the effort.

---

## 4. Open questions only the founder can answer

| # | Question | Why it matters | Recommended default |
|---|---|---|---|
| Q1 | Does someone who signs up through an invite also get a personal org? | It decides whether "everyone has at least two orgs" is the norm. That drives G7's urgency and the free-credit abuse surface (one free personal org per sign-up). | No. Invited sign-ups join only the inviting org. They can create their own org later (G6). |
| Q2 | Which domain hosts apps, and do we put it on the PSL? Where does the control plane live, given `everyapp.com` is the marketing site? | Certificates, cookie safety (G11), and PSL lead time with no SLA. It's also baked into every app URL. | Control plane at `app.everyapp.com`. Apps at `<app>-<org>.everyapp.app` (or `.everyapp.host`, per `architecture-v2-overview.md:387`). Submit to the PSL now. |
| Q3 | Use the per-host session handoff in self-host too, or only in hosted? | One model is simpler to test and lifts self-host's "apps one label below the gateway" rule. It costs one redirect per app host per session. | Both modes, since there's no backwards compatibility to keep. The self-host shared cookie becomes legacy. |
| Q4 | Sign-in methods at launch: password, Google, GitHub, magic link? | Each adds verification and linking rules (G5) and mobile handoff work. | Password with email verification, plus Google and GitHub. No magic link in v1. Cloudflare Access is self-host only. |
| Q5 | Must email be verified before the first sign-in, or only before spending free credits or inviting? | Hard verification adds friction on sign-up. Soft verification leaves unverified accounts that can't link social logins or accept invites. | Hard: no session until verified (`requireEmailVerification: true`), with auto sign-in after the link. |
| Q6 | How do platform operators act: an Access-protected ops host, or a Better Auth admin role on their normal account? | RFC-0001 forbids an admin org. A Better Auth role exposes 15 HTTP admin endpoints, impersonation included, to that account's session. | Ops host behind Cloudflare Access with an `OPS_EMAILS` allowlist. `/admin/*` closed over HTTP. No impersonation in v1. |
| Q7 | Can users create more orgs, and how many? Can any member create one, or only verified users? | Each org is a billing customer and a namespace (org key, hostnames). This is an abuse vector. | Yes, verified users only, at most 3 owned orgs, with a global daily org-creation budget (G4). |
| Q8 | Must invites always go by email, or can admins still copy links? | Copyable links are bearer secrets until the email-match check. With verification on they also need the mailbox, but a mis-shared link can still be redeemed by whoever controls that mailbox. | Keep copy-link (it helps when email lags), with a 72 h single-use token as today. |
| Q9 | Can a user choose their org's URL key (the `<org>` in `<app>-<org>.<domain>`), and is it permanent? | Keys never change (`db/organization-keys.schema.ts:5-10`), because Worker and resource names derive from them. | Auto from the name plus a random suffix, editable once at creation, then permanent. |
| Q10 | What happens to an org when its last owner leaves or deletes their account, and can owners delete an org themselves in v1? | It affects billing, WfP scripts and data retention. The stack's adopt-a-memberless-org path must never apply in hosted. | Refuse to let the last owner leave if other members exist (transfer first). Owner-initiated org deletion sets a 7-day "deleting" state, then a purge. |
| Q11 | Should a multi-org user be able to use two orgs' apps in parallel tabs? | Today the active org gates app access (`betterAuthAuthenticator.ts:136`). | Yes. The app host decides the org (G7). The switcher affects only the control plane. |

---

## 5. Load-bearing claims I relied on

1. **Any subdomain's JavaScript can write cookies for its parent domain
   unless the parent is a public suffix.** This is why the shared
   `Domain=<gateway host>` cookie is unsafe once orgs deploy their own apps
   (G11). Sources: MDN Set-Cookie; GitHub's 2013-04-05 github.io post;
   Better Auth cookie docs. *If wrong, G11 shrinks to a hardening item.*
   Critical.
2. **Workers Custom Domains are capped at 100 per zone.** Hosted app
   hostnames therefore need a wildcard route or a dispatch Worker, not the
   stack's per-app Custom Domains. Source: Cloudflare Workers limits page.
   Critical for the hostname design.
3. **The perimeter admits a session to an app only when the session's
   active org owns the app, and multi-org sessions have no default org.**
   Source: `perimeter/betterAuthAuthenticator.ts:119-136`,
   `server/organization/orgContext.ts:94-98`, `auth/config.ts:380-394`,
   checked against Better Auth 1.7.7's `crud-invites.mjs:330` (accept sets
   the active org). Critical for hosted UX.
4. **Better Auth 1.7.7 ships what hosted sign-up needs:**
   - the `captcha` plugin with `cloudflare-turnstile`
     (`dist/plugins/captcha/constants.mjs`);
   - `allowUserToCreateOrganization` as a function, plus `organizationLimit`
     and `requireEmailVerificationOnInvitation`
     (`dist/plugins/organization/types.d.mts:22,38,189`);
   - `requireLocalEmailVerified` defaulting to true
     (`dist/oauth2/link-account.mjs:138`);
   - no built-in personal-org-on-sign-up. The docs' example sets
     `activeOrganizationId` in `session.create.before`
     (better-auth.com/docs/plugins/organization).

   Not critical: if any of these were missing, it adds about a day.
5. Cloudflare Email Sending is beta and needs Workers Paid for arbitrary
   recipients (developers.cloudflare.com/email-service, updated
   2026-10-15). Not critical: another provider can sit behind
   `server/email/sendEmail.ts`.
6. The Workers Rate Limiting binding counts per location and is
   eventually consistent, with periods of 10 or 60 s only. Not critical; it
   only shapes G4.
7. D1 is single-threaded per database, with 10 GB max on Workers Paid.
   Not critical; it shapes G15.

## 6. Sources

Code (this worktree at `e1d9d3c6`, and branch `cli-redesign/08-checkout-is-truth` where marked "stack"):

- `apps/every-app-gateway/src/auth/config.ts`, `auth/shared.ts`,
  `auth/cli-config.ts`, `auth/cloudflare-access/{membership,plugin,config,outer-ring,mobile-sign-in}.ts`
- `apps/every-app-gateway/src/server/organization/{orgContext,owner-membership}.ts`,
  `server/org-roles.ts`
- `apps/every-app-gateway/src/server/services/{OrganizationService,MembershipService,InvitationService,SetupService,AdminService,OnboardingService,AppRegistrationService}.ts`;
  stack `SetupService.ts`
- `apps/every-app-gateway/src/server/repositories/{OrganizationRepository,AppRepository,AppAccessRepository}.ts`;
  stack `OrganizationRepository.ts`
- `apps/every-app-gateway/src/db/{auth,owner-bootstrap,owner-setup-tokens,organization-keys,onboarding,rate-limit}.schema.ts`;
  `drizzle/0012_absent_martin_li.sql`, `drizzle/0013_motionless_nitro.sql`
- `apps/every-app-gateway/src/routes/{sign-up,sign-in,setup,accept-invitation}.tsx`,
  `routes/_app/{organizations,index}.tsx`, `routes/api/setup/claim.ts`,
  `routes/api/admin/has-owner.ts`, `routes/api/me/apps.ts`, `routes/__root.tsx`
- `apps/every-app-gateway/src/client/components/OrganizationSwitcher.tsx`,
  `client/hooks/{useSetActiveOrganization,useActiveOrganization}.ts`
- `apps/every-app-gateway/src/middleware/auth.ts`, `serverFunctions/*.ts`
- `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`,
  `server.ts`, `server/app-hosts.ts` (and stack diff),
  `server/control-plane-guard.ts`, `server/auth-rate-limit.ts`,
  `server/deploy-token-auth.ts`, `server/ai-proxy.ts`,
  `server/app-gateway-entrypoint.ts`, `server/email/{sendEmail,links}.ts`,
  `utils/auth.ts`, `env.d.ts`, `cloudflare.config.ts`
- Stack: `server/deployment-mode.ts`, `server/app-activation.ts`,
  `packages/perimeter/src/registry/registration.ts`,
  `packages/cli/src/lib/gateway/registry.ts`
- `packages/perimeter/src/{gateway,headers}.ts`;
  `packages/cli/src/lib/gateway/{install,secretsFile}.ts`;
  `apps/mobile-native/src/lib/webview-cookies.ts`;
  `landing-page/wrangler.jsonc` (main)
- `apps/every-app-gateway/node_modules/better-auth` 1.7.7:
  `dist/plugins/captcha/constants.mjs`,
  `dist/plugins/organization/{types.d.mts,routes/crud-invites.mjs,routes/crud-org.mjs}`,
  `dist/plugins/admin/{admin,routes}.mjs`, `dist/oauth2/link-account.mjs`,
  `dist/context/create-context.mjs:170-175`
- `adr/RFC-0001-org-rearchitecture-phase-1.md`, `adr/ADR-0001-*.md`,
  `adr/ADR-0002-*.md`, `adr/ADR-0003-self-host-authority.md`,
  `docs/architecture-v2-recommendation.md`, `docs/architecture-v2-overview.md`,
  `docs/security-model.md`, `docs/cli-redesign.md:585-590`, `TODO.md`
  (worktree and main)

Web (fetched 2026-10-15):

- Better Auth, Organization plugin: https://www.better-auth.com/docs/plugins/organization
- Better Auth, Cookies (cross-subdomain warning): https://www.better-auth.com/docs/concepts/cookies
- Better Auth, Captcha plugin (Turnstile): https://www.better-auth.com/docs/plugins/captcha
- MDN, Set-Cookie (Domain rules, `__Host-` prefix): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- GitHub Blog, "New GitHub Pages domain: github.io" (2013-04-05): https://github.blog/news-insights/the-library/new-github-pages-domain-github-io/
- Public Suffix List guidelines: https://github.com/publicsuffix/list/wiki/Guidelines
- Background: https://en.wikipedia.org/wiki/Public_Suffix_List ; https://jefftk.com/p/history-of-the-public-suffix-list
- Cloudflare Workers limits (100 custom domains/zone, 1,000 routes/zone): https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare Access authorization cookie: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
- Cloudflare Email Service (Email Sending beta): https://developers.cloudflare.com/email-service/
- Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/
