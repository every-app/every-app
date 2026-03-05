# ADR-0001: Hosted vs Self-Hosted Topology

- Status: Accepted
- Date: 2026-03-02

## Context

We are building a hosted version of the Every App Gateway, while keeping self-hosting as a core product path.
The current gateway and CLI assumptions are strongly single-tenant/global, and app deploy workflows assume the gateway and apps share a Cloudflare account.

Key constraints for the near term:

- Product is still pre-launch/POC and can tolerate breaking changes.
- We need a practical path to multi-tenant organizations.
- We want to avoid unnecessary codebase/release complexity early.

## Decision

1. Use a single repository and single gateway application codebase, with runtime mode separation:
   - `self_hosted` mode
   - `hosted` mode
2. Use organization-based multi-tenancy in hosted mode.
3. Keep hosted and self-hosted differences policy-driven (feature/capability flags), not forked app logic.
   - Control-plane trust model is mode-specific:
     - `self_hosted`: Cloudflare account token is the internal control-plane root-of-trust.
     - `hosted`: Cloudflare account ownership checks are not a valid tenant authorization boundary.
4. Use an open-core boundary:
   - Open: gateway core, auth/session flows, organization model, app runtime APIs.
   - Potentially private later: hosted-only control-plane operations (billing, anti-abuse policies, internal operational tooling).
5. Hosted provider credentials are platform-managed for v1:
   - Gateway uses a platform-owned provider API key for AI proxying.
   - Customer apps and users never receive provider API keys.
   - BYO provider keys are explicitly deferred.
6. Hosted app worker deployments are single-tenant for v1:
   - Each deployed app worker instance is scoped to one organization.
   - Multi-tenant app worker runtime support is deferred.

## Rationale

- Avoids repository drift and duplicated maintenance.
- Allows faster POC iteration with one deployable gateway artifact.
- Preserves future flexibility for hosted-private features without committing to a hard split now.

## Consequences

Positive:

- Faster implementation and lower maintenance overhead.
- Cleaner migration path from current global model.

Negative:

- Need disciplined boundaries to prevent hosted-only logic from leaking into self-hosted paths.
- Requires clear capability toggles and tests for both modes.
- Internal API behavior must be explicitly fail-closed by mode (no implicit fallback to self-hosted semantics).

## Follow-ups

- Define and document mode/capability flags.
- Keep control-plane integrations behind explicit interfaces.
- Long-term: gateway will expose an OAuth provider so CLI and other clients can authenticate through gateway-managed identity/org context instead of relying on Cloudflare account tokens.
- Revisit this ADR after hosted GA usage patterns are known.
