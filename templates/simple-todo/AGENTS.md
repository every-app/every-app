# Agent instructions

- Before running everyapp, read the everyapp skill: `.agents/skills/everyapp/SKILL.md` (also in `.claude/skills/`). `everyapp create` puts it there.
- Deploy only with `pnpm run deploy` (everyapp deploy). Never run `cf deploy` or `wrangler deploy` directly.
- Run the app with `pnpm dev` (everyapp dev): it serves the app behind a local gateway with a seeded dev user.
- `cloudflare.config.ts` builds the Worker from `everyapp.config.ts`; declare D1, KV, Durable Objects and Workflows in `everyapp.config.ts`.
