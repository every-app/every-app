# RFC-0001: Organization Re-Architecture (POC)

- Status: Accepted
- Date: 2026-03-02

## Summary

Implement hosted organization multi-tenancy as one integrated phase that includes backend, auth, proxy behavior, UX, and tests before shipping the POC.

This RFC also aligns with a future Phase 3 goal to deploy user apps via Workers for Platforms.

## Goals

- Replace global/single-tenant gateway assumptions with org-scoped boundaries.
- Use Better Auth organization primitives for org and membership lifecycle.
- Keep app developer experience simple (apps can continue to think in a single active workspace context).
- Ensure cross-org isolation is verified by automated tests.

## Non-Goals (for POC)

- Full production hardening (SLOs, deep anti-abuse automation, incident tooling).
- Final billing implementation.
- Full WfP deployment orchestration.

## Onboarding Model

### Hosted

- User signs up.
- If user has an invite, they join that org.
- If user has no invite, create a personal org/workspace and set it active.

### Self-hosted

- First user signs up.
- First user becomes owner of the first org.
- Replace global "owner bootstrap" semantics with org-owner semantics over time.

### Platform Administration

- Do not use a customer-visible "admin organization" as platform control plane.
- Keep platform-admin concerns separate from customer org membership.

## Better Auth Alignment

- Adopt Better Auth organization plugin as the primary org/membership model.
- Keep the admin plugin for platform/global admin capabilities where needed.
- Keep domain entities (`apps`, app access, app tokens) explicitly org-scoped in application tables.

## Hosted Runtime Constraints (v1)

- Platform-managed provider credential model:
  - Gateway uses platform-owned provider keys (for example a single OpenAI API key).
  - Apps and users never receive raw provider keys.
  - BYO provider keys are deferred.
- Hosted app workers are single-tenant:
  - Each deployed app worker instance is pinned to one organization.
  - Runtime auth enforces token organization claim matches worker organization.

## Implementation Phases

### Phase 0: Decisions (this RFC + ADRs)

- Topology and repository strategy.
- OSS/open-core boundary.
- Control-plane auth direction.
- Hosted/self-hosted onboarding behavior.

### Phase 1: Integrated Org Re-Architecture (must include tests)

1. Data model and migrations
   - Add org and membership model.
   - Add `organizationId` to app domain tables.
2. Auth/session/middleware
   - Active organization context.
   - Org-role authorization checks.
3. API and services/repositories
   - Enforce org filters in all critical queries/mutations.
4. AI proxy and credentials
    - Token/app/org consistency checks.
    - Platform-managed provider credential injection at gateway.
    - Usage metering dimensions include org/app/token for billing.
5. UX and onboarding
   - Create/join/switch org.
   - Org-scoped admin management.
6. Tests (required to ship)
   - Cross-org isolation.
   - Org-role authorization.
   - Token misuse across org boundaries.
   - End-to-end smoke flows.

### Phase 2: Billing, Usage, Limits

- Org-level metering and plan enforcement.

### Phase 3: Deploy User Apps on Behalf of Users (WfP)

- GitHub URL -> build/deploy pipeline using Workers for Platforms control plane.
- Reuse Phase 1 API-first control-plane contracts.

## Acceptance Criteria for Phase 1

- No global authorization path remains for tenant data operations.
- Exception: documented `self_hosted` internal control-plane endpoints may use Cloudflare account token trust, but must be disabled in `hosted` mode.
- All app-domain operations are org-scoped.
- Org onboarding and admin UX are functional in both hosted and self-hosted modes.
- Required test suite passes.
- Hosted-mode tests verify `/api/internal/*` is disabled regardless of Cloudflare account token validity.

## Risks

- Missing org filters in repositories/services.
- Drift between Better Auth organization state and app domain org-scoped records.
- Legacy CLI paths that bypass control-plane APIs.

## Mitigations

- Defense-in-depth org checks in middleware + services + repositories.
- API-first control plane contracts and deprecation plan for direct DB writes.
- Explicit test coverage for cross-org and role-based authorization.
- Long-term auth direction: expose a gateway OAuth provider and migrate CLI/control-plane auth to gateway-issued user/org-scoped credentials.
