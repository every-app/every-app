HARD EXCLUSIONS - Automatically exclude findings matching these patterns:

1. Denial of Service (DOS) vulnerabilities or resource exhaustion attacks
2. Secrets/credentials stored on disk (these are managed separately)
3. Rate limiting concerns or service overload scenarios (services don't need to implement rate limiting)
4. Memory consumption or CPU exhaustion issues
5. Lack of input validation on non-security-critical fields without proven security impact
6. Input sanitization concerns for github action workflows
7. A lack of hardening measures. Code is not expected to implement all security best practices, just avoid obvious vulnerabilities.
8. Race conditions or timing attacks that are theoretical rather than practical issues. Only report a race condition if it is extremely problematic.
9. Vulnerabilities related to outdated third-party libraries. These are managed separately and should not be reported here.
10. Files that are only unit tests or only used as part of running tests: `*.test.ts`, `*.sqlite.test.ts`, `src/test/`, `test-helpers.ts`, `test-fixtures.ts`, the fake Cloudflare account in `packages/cli/src/test/`, and the mock Access in `apps/every-app-gateway/scripts/access-local.mjs`.
11. Log spoofing concerns. Outputting un-sanitized user input to logs is not a vulnerability.
12. SSRF vulnerabilities that only control the path. SSRF is only a concern if it can control the host or protocol.
13. Including user-controlled content in AI system prompts is not a vulnerability. In general, the inclusion of user input in an AI prompt is not a vulnerability.
14. Do not report issues related to adding a dependency to a project that is not available from the relevant package repository. Depending on internal libraries that are not publicly available is not a vulnerability.
15. Do not report issues that cause the code to crash, but are not actually a vulnerability. E.g. a variable that is undefined or null is not a vulnerability.
16. Generated files: `routeTree.gen.ts`, `src/db/auth.schema.ts`, drizzle migrations and their `meta/` snapshots, `worker-configuration.d.ts`.
17. Documentation: anything under `docs/`, `prompts/`, `landing-page/content/`, and `*.md` files.

SIGNAL QUALITY CRITERIA - For remaining findings, assess:

1. Is there a concrete, exploitable vulnerability with a clear attack path?
2. Does this represent a real security risk vs theoretical best practice?
3. Are there specific code locations and reproduction steps?
4. Would this finding be actionable for a security team?
5. Which actor in docs/threat-model.md is the attacker (a visitor, a member, an admin, an app's code, an AI client, a third-party app), and which of its invariants breaks? A finding that names neither is probably not one.

PRECEDENTS -

1. Logging high value secrets in plaintext is a vulnerability. Otherwise, do not report issues around theoretical exposures of secrets. Logging URLs is assumed to be safe. Logging request headers is assumed to be dangerous since they likely contain credentials.
2. UUIDs can be assumed to be unguessable and do not need to be validated. If a vulnerability requires guessing a UUID, it is not a valid vulnerability.
3. Audit logs are not a critical security feature and should not be reported as a vulnerability if they are missing or modified.
4. Environment variables and CLI flags are trusted values. Attackers are not able to modify them in a secure environment. Any attack that relies on controlling an environment variable is invalid.
5. Resource management issues such as memory or file descriptor leaks are not valid.
6. Subtle or low impact web vulnerabilities such as tabnabbing, XS-Leaks, prototype pollution, and open redirects are not valid.
7. Vulnerabilities related to outdated third-party libraries. These are managed separately and should not be reported here.
8. React is generally secure against XSS. React does not need to sanitize or escape user input unless it is using dangerouslySetInnerHTML or similar methods. Do not report XSS vulnerabilities in React components or tsx files unless they are using unsafe methods.
9. Most vulnerabilities in github action workflows are not exploitable in practice. Before validating a github action workflow vulnerability ensure it is concrete and has a very specific attack path.
10. A lack of permission checking or authentication in client-side TS code is not a vulnerability. Client-side code is not trusted and does not need to implement these checks, they are handled on the server-side. The same applies to all flows that send untrusted data to the backend, the backend is responsible for validating and sanitizing all inputs.
11. Only include MEDIUM findings if they are obvious and concrete issues.
12. Logging non-PII data is not a vulnerability even if the data may be sensitive. Only report logging vulnerabilities if they expose sensitive information such as secrets, passwords, or personally identifiable information (PII).
13. Command injection vulnerabilities in shell scripts are generally not exploitable in practice since shell scripts generally do not run with untrusted user input. Only report command injection vulnerabilities in shell scripts if they are concrete and have a very specific attack path for untrusted input.
14. SSRF (Server-Side Request Forgery) vulnerabilities in client-side JavaScript/TypeScript files are not valid since client-side code cannot make server-side requests that would bypass firewalls or access internal resources. Only report SSRF in server-side code. The same logic applies to path-traversal attacks, they are not a problem in client-side JS.
15. Path traversal attacks using ../ are generally not a problem when triggering HTTP requests. These are generally only relevant when reading files where the ../ may allow accessing unintended files.
16. Injecting into log queries is generally not an issue. Only report this if the injection will definitely lead to exposing sensitive data to external users.

PRECEDENTS specific to EveryApp (docs/threat-model.md has the full model) - 17. The operator is root on a self-hosted Gateway (docs/adr/ADR-0003): the CLI reads and writes the Gateway's D1 database and uploads Workers with the operator's own Cloudflare login or API token, by design. A finding must show someone without that login doing one of those things; "the CLI writes the database directly" is not one. 18. Apps are private Workers reached only through the Gateway over a service binding, and every private route carries a fresh identity JWT the SDK verifies (packages/sdk/src/internal/identity.ts). An app route or server function with no authentication of its own is expected: `everyApp()`, `getEveryAppUser()` and `requireEveryAppUser()` are where identity is read. Flag an app only when it trusts a client-supplied header, cookie or parameter instead, or declares a route `public` in everyapp.config.ts and then exposes member data or takes a state change on it with no check of its own. 19. Inbound `Cookie`, `Authorization`, `x-everyapp-*` and `cf-access-*` headers are stripped by the perimeter before an app sees a request (packages/perimeter/src/headers.ts); public routes get `Authorization` back for the app's own bearer or webhook authentication, which the Gateway never interprets. 20. Identity tokens live two minutes, and memberships and organization status are cached per isolate for up to 30 seconds: revocation taking effect within that window is documented, not a finding. 21. `EVERYAPP_DEV`, `everyapp dev`, its gateway-lite and dev ToolBus, the dev key pair in packages/sdk/src/dev, and `apps/every-app-gateway/src/routes/api/dev/` are local development only, never set or served in production. 22. Password accounts on a self-hosted Gateway are not email-verified (only an Access sign-in verifies), sign-up is invite-only, and there are no per-organization usage limits yet; TODO.md records each. Rate limits on sign-in and mail exist and their numbers are not up for review. 23. Worker secrets (`everyapp secret set`), `.dev.vars`, `.everyapp/secrets.env` and the Cloudflare login the CLI keeps are the intended places for credentials. A finding about a secret must show it reaching a command line, a log, `--json` output, an error message, a client, or another organization's app. 24. The CLI runs on the operator's machine with the operator's inputs: a manifest, a build output or a flag the operator wrote is trusted. A release tarball or a GitHub release the operator chose to install is trusted as its publisher is; only a tarball entry escaping its directory, or a build script run from a fetched repository, counts.
