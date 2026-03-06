# ADR-0002: CLI and Control-Plane Authentication Model

- Status: Accepted
- Date: 2026-03-02

## Context

Today, app deployment and registration flows rely on direct Cloudflare-account assumptions:

- CLI writes directly to gateway D1 records for app catalog/access.
- Internal provisioning endpoint currently verifies Cloudflare account token access.

This is incompatible with hosted multi-tenant operations and future Workers for Platforms (WfP) deployment on behalf of users.

## Decision

1. Move to an API-first gateway control plane contract for app registration and token provisioning.
2. De-emphasize direct gateway DB writes from CLI.
3. Treat Cloudflare credential checks as transitional compatibility behavior only.
4. Introduce hosted control-plane auth for privileged operations (org-scoped, gateway-issued credentials/session), not caller Cloudflare account ownership checks.
5. Require org-bound runtime auth contracts for app and session tokens:
   - Gateway-issued tokens must include organization identity.
   - Runtime auth must deny cross-organization token usage.
6. Hosted app worker instances are org-pinned in v1:
   - Deployment injects an organization identifier secret per worker.
   - SDK auth verifies token organization claim matches deployed org identifier.

## Rationale

- Hosted mode cannot assume the caller has Cloudflare credentials for the gateway account.
- WfP requires a central control plane regardless of whether deploy trigger comes from CLI, UI, or GitHub URL.
- API contracts are reusable across self-hosted and hosted modes.

## Consequences

Positive:

- Unified integration surface for CLI and future hosted deployment workflows.
- Cleaner path to WfP without reworking app registration semantics.

Negative:

- Requires short-term CLI refactor away from direct D1 mutation paths.
- Transitional period where old and new pathways may coexist.

## Security Assumptions

- In `self_hosted` mode, anyone with a valid Cloudflare account token for the gateway account is treated as an internal operator.
- Compromise or misuse of that Cloudflare token carries account-wide control-plane blast radius.
- This trust model is intentionally not valid for hosted multi-tenant operations.
- See also the canonical trust boundary definition in `docs/security-model.md`.

## Transitional Guardrails

- Cloudflare-account-token-based internal API auth is allowed only for `self_hosted` mode.
- In `hosted` mode, `/api/internal/*` must be disabled and return `404`.
- Any deployment mode parsing/configuration errors must fail closed (internal APIs disabled).
- Legacy Cloudflare-token control-plane flows are deprecated and must be removed after hosted gateway-issued org-scoped credentials are rolled out.

## Follow-ups

- Add gateway API endpoints for app registration and access grant workflows.
- Migrate CLI to those APIs.
- Mark legacy Cloudflare-token-based provisioning flow as deprecated and remove after migration.
- Long-term: expose an OAuth provider from the gateway so CLI can authenticate as the user/org context and use gateway-issued credentials for control-plane auth instead of Cloudflare account bearer tokens.
