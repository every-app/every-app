# Hosted Every App: research brief (2026-10-15)

Shared context for the research agents. Read this first, then the files it names.

## The founder's vision, in his words (lightly condensed)

Users sign up for an agent on everyapp.com and can then use all of the apps.
Each app proxies into secrets through the gateway: the app never knows the
secrets, it calls the gateway, and the gateway authorizes the app's access to
certain secrets when the app is created. The gateway meters any usage at the
app level. For OpenSEO, for example, all billing and metering happens at the
gateway instead of in the app. If people use OpenRouter, each app requests
permission to use OpenRouter and we meter at the gateway. Later: usage limits
per app, and security so each app isn't malicious, all at the gateway layer,
each app only having what the gateway gave it.

Each user who signs up gets their own organization, or is invited to one.
Multi-tenant. Users can also deploy their own apps using Workers for
Platforms, namespaced: each app isolated from each other, each organization
able to run many apps hosted on Workers for Platforms on their behalf. Make
it super easy and secure to run either customizations/forks of a repo or
pure internal apps, "like Cloudflare OS, but much easier".

Ground rules: this is rapid prototyping of a proof of concept with no
users. No backwards compatibility. Be ambitious; propose the long-term
vision and a series of PRs to get there.

## What already exists (read these, in this order)

Design history:
- `adr/ADR-0001-hosted-vs-self-hosted-topology.md` (2026-03): one codebase,
  `self_hosted` vs `hosted` mode, org multi-tenancy, platform-managed
  provider keys for hosted v1, hosted app Workers single-tenant per org.
- `adr/RFC-0001-org-rearchitecture-phase-1.md`: onboarding model
  (sign up -> personal org or invited org), Better Auth organization plugin,
  phases (orgs -> billing -> WfP).
- `adr/ADR-0002-cli-and-control-plane-auth.md` and
  `adr/ADR-0003-self-host-authority.md` (today): self-host authority is
  Cloudflare account access; the CLI writes the gateway's D1 directly; the
  hosted tier gets its own HTTP control plane and credentials.
- `docs/architecture-v2-recommendation.md` §2.6 and
  `docs/architecture-v2-overview.md` §1, §2, §5: the "one door" perimeter,
  the `getAppFetcher()` seam, and the sketched hosted tier (dispatch
  namespace, outbound worker, LLM key injection, per-tenant D1/KV,
  `{app}-{tenant}.everyapp.host` single-label hostnames, envelope-encrypted
  tenant secrets).
- `docs/security-model.md`: the perimeter contract, MCP/OAuth, AI proxy.
- `docs/cli-redesign.md` §1, §5, §6: today's decisions for the self-host
  CLI (being built now in PRs #286-#293). Note "Hosted tier: it needs an
  HTTP deploy API with its own auth ... Nothing here should be built for it
  yet."
- `TODO.md`: open decisions, including "AI Gateway routing" and "Metered
  billing at the gateway (deferred)".
- The integrations design on branch `research/app-integrations`
  (`git show research/app-integrations:docs/research/2026-10-integrations-hub/app-integrations.md`)
  and its GitHub POC (PR #281, branch `poc/github-integration`): the
  "declare in manifest -> admin approves -> call through the gateway binding
  -> gateway injects the token" pattern that the founder's "apps request
  permission to use OpenRouter" generalizes.

Code (gateway = `apps/every-app-gateway`, packages = `packages/*`):
- `apps/every-app-gateway/src/server.ts`: the one public Worker; Host
  routing; the `AppGateway` WorkerEntrypoint apps call over a service
  binding with `props` {organizationId, appId, workerName}.
- `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts` and
  `ai-proxy.ts`, `ai-usage.ts`: the AI proxy today (OpenAI only, one shared
  key, manifest `providers` + `ai.models`/`ai.routes`, usage tapped off the
  stream and logged, not billed).
- `packages/sdk/src/server/gatewayFetch.ts`: how apps call it.
- `packages/sdk/src/cloudflare/worker.ts` (`everyAppWorker()`): how an app
  Worker's bindings are built (the gateway binding with props, identity
  keys, D1/KV/DO/Workflows, secrets, crons).
- `packages/perimeter/src/gateway.ts`, `getAppFetcher.ts`, `registry.ts`,
  `manifest/manifest.ts`: the perimeter, the service-binding/dispatch seam,
  the registry row shape, the manifest schema.
- `apps/every-app-gateway/src/db/*.schema.ts`: D1 schema (Better Auth
  users/sessions/organizations/members/invitations, apps,
  user_app_access, app_tokens, organization_keys, mcp_*, user tokens).
- `apps/every-app-gateway/src/auth/config.ts`: Better Auth config
  (`allowUserToCreateOrganization: false`, invite-only sign-up, Cloudflare
  Access plugin), `src/server/organization/orgContext.ts`.
- `packages/cli/src/commands/app/deploy/deployApp.ts`, `lib/cf/*`,
  `lib/gateway/apply.ts`, `patchBuildOutput.ts`, `desiredState.ts`: the
  self-host deploy pipeline (cf CLI: resources, D1 migrations with
  bookmarks, `cf deploy --prebuilt`, gateway rebind by redeploying the
  gateway with service bindings reconstructed from the registry).
- `apps/every-app-gateway/src/server/toolbus/*`, `packages/toolbus`: MCP
  and the ToolBus (one `/mcp` for all apps, consent, audit table).

OpenSEO (the first real app to move its billing to the gateway) is at
`/Users/bensenescu/workspaces/open-seo`: `src/server/billing/*`,
`src/shared/billing.ts`, `src/shared/billing-credit-features.ts`,
`src/server/lib/dataforseo/client.ts`, `src/server/features/sam/*`
(OpenRouter agent). It bills through Autumn today: a `usage_credits`
credit system over two metered features (`seo_data_usage`, `llm_usage`),
plans (free 500 one-off credits, base $10/mo 10k credits with overage,
YC $50/mo, credit top-ups $1/1,000), a 1.28x markup on DataForSEO cost,
`check({lock})` holds before expensive calls and `balances.finalize`
after, and `track` for deductions. The founder's Autumn org
("Ben Senescu's Org", live env) holds these plans today.

## Terms

- Gateway: the one public Worker (control plane + perimeter + AI proxy +
  MCP). Self-host: one per Cloudflare account. Hosted: one for everyone.
- App: a private Worker reached only through the gateway. Self-host: a
  service binding. Hosted: a Workers for Platforms user Worker.
- Catalog app: an app we ship (todo, chef, workout, RepoLens, OpenSEO).
- Org app: an app an organization deploys itself (fork, customization, or
  internal tool).
- Broker: the gateway's app-facing capability surface (AI proxy today;
  integrations and metered providers next): apps call it over their
  binding, the gateway checks the grant and injects the secret.
