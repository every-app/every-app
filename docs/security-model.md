# Security Model

## Trust Zones

- **Public zone**: unauthenticated browser and API traffic.
- **Org user zone**: authenticated user sessions and embedded session tokens.
- **Operator zone**: internal control-plane operations for self-hosted deployments.

## Authentication and Authorization Contracts

### Org User Zone

- User-facing gateway actions must enforce org membership and role checks in server middleware.
- Embedded app session tokens are org-bound and validated against deployment org configuration.
- Cross-organization token usage is denied in runtime auth.

### Operator Zone (`/api/internal/*`)

- Internal APIs are operator-plane APIs, not tenant-isolation boundaries.
- In `self_hosted` mode, a Cloudflare bearer token with gateway account capability (worker settings read + D1 write probe) is treated as operator-equivalent.
- Under this trust model, a qualifying Cloudflare token can act across organizations.
- This behavior is intentional for self-hosted control-plane compatibility and should not be reported as a tenant-isolation bug.

## Deployment Modes

- `self_hosted`: internal operator APIs are enabled.
- `hosted`: internal operator APIs must be disabled (`404`).
- Unknown deployment mode values fail closed (`404`) for internal operator APIs.

## Accepted Risks

- Compromise or misuse of an operator-equivalent Cloudflare token has account-wide control-plane blast radius in self-hosted mode.

## Required Hardening Invariants

- DB integrity must enforce app/org consistency for app-access and app-token records.
- Token scopes are explicit provider scopes only (`provider:<name>`); wildcard scopes are disallowed.
