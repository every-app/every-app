---
description: Review adherence to service/repository pattern
subtask: true
---
**Focus area:** $ARGUMENTS

Review this codebase for adherence to our Service/Repository pattern.

## Expected Structure
serverFunctions/ → server/services/ → server/repositories/

## Rules
| Layer | Must Do | Must NOT Do |
|-------|---------|-------------|
| **Server Functions** | Extract userId from session, validate input, call services | Direct DB access, trust client for userId |
| **Services** | Verify ownership before mutations, call repositories | Import other services, direct DB access |
| **Repositories** | Include userId in WHERE clauses | Import other repositories, auth logic |

## Checklist
- [ ] 3-layer separation exists for each domain
- [ ] Services verify ownership before mutations
- [ ] Repositories include userId in WHERE clauses
- [ ] Repositories do NOT import other repositories
- [ ] Server functions extract userId from session (never trust client)

Don't make any changes, just write a report on the above checklist.
