---
description: Review TanStack DB usage and patterns
subtask: true
---
**Focus area:** $ARGUMENTS

Review this codebase for proper TanStack DB usage. Make sure that we're not using normal react-query or other data fetching patterns when possible.

## Documentation
- [Live Queries](https://tanstack.com/db/latest/docs/guides/live-queries)
- [Mutations](https://tanstack.com/db/latest/docs/guides/mutations)
- [Schemas](https://tanstack.com/db/latest/docs/guides/schemas)
- [createOptimisticAction](https://tanstack.com/db/latest/docs/reference/functions/createOptimisticAction)

## File Structure
| Location | Purpose |
|----------|---------|
| `client/tanstack-db/*Collection.ts` | One collection per entity |
| `client/tanstack-db/index.ts` | Re-exports all collections |
| `client/tanstack-db/queryClient.ts` | QueryClient with gcTime/staleTime |
| `client/tanstack-db/persister.ts` | localStorage persister for offline |
| `client/actions/*.ts` | Optimistic actions via `createOptimisticAction` |

## Checklist

### Collections
- [ ] Wrapped with `lazyInitForWorkers()` so it works on Cloudflare

### Optimistic Actions
- [ ] Use `createOptimisticAction` for complex mutations
- [ ] Pre-generate IDs with `nanoid()` before action - same ID used in `onMutate` and `mutationFn`
- [ ] `onMutate` updates all affected collections synchronously
- [ ] `mutationFn` calls server then refetches via `collection.utils.refetch()`

### Non-Optimistic Mutations
When the client lacks data needed for optimistic updates (e.g., adding a friend by email where the server looks up the user), call the server function directly then refetch:
```typescript
await serverFunction({ data });
await collection.utils.refetch();
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Use `useQuery`/`useMutation` from react-query | Use `useLiveQuery` and collections |
| Coordinate multiple optimistic mutations in component code | Use `createOptimisticAction` |
| Store nested entities in collections | Flat data, join at query time |
| Generate IDs inside `onMutate` or `mutationFn` | Pre-generate IDs in helper function |
| Skip refetch after `mutationFn` | Always `await collection.utils.refetch()` |

Don't make any changes, just write a report on the above checklist.
