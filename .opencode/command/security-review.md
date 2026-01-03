---
description: Review authentication and authorization patterns
subtask: true
---
**Focus area:** $ARGUMENTS

Review authentication and authorization across all API routes and backend services.

## Service/Repository Authorization Pattern

We use defense-in-depth with two layers:

| Layer | Responsibility | On Failure |
|-------|----------------|------------|
| **Service** | Verify ownership BEFORE mutations | Throw clear error |
| **Repository** | Include `userId` in WHERE clauses | Return null/empty (silent) |

**Services** handle authorization and can call multiple repositories. **Repositories** are pure data access - no auth checks, no cross-repo imports.

This keeps repositories simple and testable while ensuring authorization can't be accidentally bypassed (the `userId` in WHERE clauses acts as a safety net).

## Checklist
- [ ] Services verify ownership before mutations
- [ ] Repositories include `userId` in WHERE clauses  
- [ ] Repositories do NOT import other repositories
- [ ] Server functions extract userId from session (never trust client)
- [ ] No hardcoded secrets or API keys
- [ ] Input validation on user-provided data

Don't make any changes, just write a report on the above checklist.
