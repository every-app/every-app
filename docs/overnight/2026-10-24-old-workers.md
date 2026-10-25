# The 17 old Workers on workers.dev: listed and deleted (2026-10-24)

The public-surface thread's record, verbatim from its orchestrator, kept here because it names the maintainers' Cloudflare account inventory (Worker names, storage ids, the counts of Workers, Custom Domains and Access applications): `docs/overnight/` stays out of the public copy (`scripts/public-copy/policy.mjs`), while TODO.md travels scrubbed and its rules were written for the parenthesized lists, not a table. The one-line outcome is in TODO.md ("Threat model and security scanning") and the public summary in docs/threat-model.md, known gap 33.

**The 17 old Workers on workers.dev (Ben's Q11d, "delete them this weekend"), listed with evidence before deletion, then deleted 2026-10-24 22:54Z.** The list is TODO.md's ("The old-era Workers in the Cloudflare account ... all with workers.dev on") re-read live on 2026-10-24 (Pacific evening) from the account's Workers API (97 Workers), each name's `subdomain` setting, its bindings, the account's 20 Workers Custom Domains, every zone's Workers routes and DNS records, the 14 Access applications, and a scan of the other 80 Workers' service and Durable Object bindings. All 17 had `workers.dev` on (`subdomain.enabled: true`); 15 answered **200** at `https://<name>.bensenescu.workers.dev/` (pre-#267 code behind nothing), `every-app-state` answered 401 and `every-app-state-token` 404. **None** had a Custom Domain, a route, a DNS record, an Access application, or another Worker bound to it; none is named by a manifest, a doc or code on main except as history (TODO "Paused", docs/launch-2026-10-27.md A10, docs/threat-model.md item 33, and `scripts/public-copy/private.txt`, which lists `every-every-workout-tracker` as a string the public copy scrubs). `every-app-state` and `every-app-state-token` were the Alchemy state Worker and its token of the December 2025 CLI (commit a3e065ed "Alchemy first draft"); that code is gone and no `alchemy.run.ts` in any checkout names them.

| Worker | created | last modified | workers.dev before | bindings left behind (not deleted) |
|---|---|---|---|---|
| every-every-workout-tracker | 2026-01-02 | 2026-01-02 | 200 | D1 `28732d7b…`, KV `0a7c3ea1…` |
| every-git-init2 | 2026-01-06 | 2026-01-06 | 200 | D1 `6255cd95…`, KV `999182a2…` |
| every-graham | 2026-01-21 | 2026-02-22 | 200 | D1 `aa916598…`, KV `ef9e379e…`, DO `PAGE_COLLAB_DO`, `SIMPLE_COLLAB_DO` (storage went with the Worker) |
| every-julia | 2026-01-19 | 2026-01-19 | 200 | D1 `6fab0536…`, KV `767c8709…`, R2 `every-julia` |
| every-llm-chat | 2025-11-21 | 2025-11-24 | 200 | D1 `f9724138…`, KV `1c4de807…`, R2 `every-llm-chat` |
| every-open-minutes | 2026-01-16 | 2026-01-18 | 200 | D1 `6979d4f6…`, KV `64e5910d…`, R2 `every-open-minutes`, DO `TRANSCRIPTION_CONTAINER` (a container) |
| every-open-seo | 2026-02-28 | 2026-03-04 | 200 | D1 `beb9b074…`, KV `f20d5543…`, R2 `every-open-seo`, Workflow `SiteAuditWorkflow` |
| every-simple-todo | 2026-01-29 | 2026-01-29 | 200 | D1 `f013f709…`, KV `2acb6c8b…` |
| every-simple-todo-template | 2026-01-03 | 2026-02-06 | 200 | Hyperdrive `35d51c08…` |
| every-super-seo | 2026-02-23 | 2026-02-27 | 200 | D1 `2601d93a…`, KV `4abd52f3…`, R2 `every-super-seo`, Workflow `SiteAuditWorkflow` |
| every-tab-bar | 2026-01-29 | 2026-01-29 | 200 | D1 `13822c26…`, KV `81432e6a…` |
| every-test-create | 2026-01-29 | 2026-01-29 | 200 | D1 `9063b30d…`, KV `0ef7fda9…` |
| every-todo-app | 2026-01-03 | 2026-03-16 | 200 | D1 `24948bea…`, KV `377aab5b…`, DO `USER_SYNC` |
| every-winery | 2026-01-04 | 2026-01-06 | 200 | D1 `2e826a47…`, KV `91119f01…`, R2 `every-winery` |
| every-app-every-todo-app-bensenescu | 2025-12-23 | 2025-12-23 | 200 | D1 `24948bea…` and KV `377aab5b…` (shared with every-todo-app) |
| every-app-state | 2025-12-23 | 2025-12-23 | 401 | DO `STORE` (the old Alchemy state; storage went with the Worker) |
| every-app-state-token | 2025-12-23 | 2025-12-23 | 404 | a Secrets Store secret `ALCHEMY_STATE_TOKEN` (the store entry stays) |

Not touched, on purpose: the five old Workers without workers.dev (`every-chef`, `every-todo`, `every-workout-tracker`, `every-counterscale`, `every-alchemy-example`: Ben's ask named the 17 on workers.dev; they answer nothing publicly); the D1 databases, KV namespaces, R2 buckets and the Hyperdrive config the table lists (storage deletion is a separate reviewed step: the launch log says "leave deleting the D1 and KV for a reviewed list after launch"); and everything live or similarly named (`every-app-gateway`, `every-app-landing-page`, `every-app-domain-redirect`, the five `every-bensenescu-*` app Workers, `open-seo*`, `simple-todo-template`, `todo-app`).

**Done 2026-10-24 22:54:10–22:54:37Z** with `cf workers delete <name> --force --delete-with-references` under the maintainer's cf login, one call per name in the order of the table, after the read-only MCP connection was refused (HTTP 403 on DELETE: no write scope, so nothing was ever deletable from that tool). Verified at 22:54:46Z: the account lists 80 Workers (97 before), none of the 17 remains, and every live or similarly named Worker is still there. At 22:54:50Z all 17 `https://<name>.bensenescu.workers.dev/` answer **404**; the live sites are unchanged (everyapp.team and crm.everyapp.team 302 to Access, everyapp.com, app.openseo.so and openseo.so 200).
