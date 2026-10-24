# Agent instructions

- Deploy only with `pnpm run deploy` (everyapp deploy). Never run `cf deploy` or `wrangler deploy` directly.
- Run the app with `pnpm dev` (everyapp dev): it serves the app behind a local gateway with a seeded dev user.
- `cloudflare.config.ts` builds the Worker from `everyapp.config.ts`; declare D1, KV, Durable Objects and Workflows in `everyapp.config.ts`.
- Before opening a pull request, run `/security-review` in Claude Code (Anthropic's open-source security review of the branch's changes) and fix what it finds; CI runs the same review on every pull request. The Gateway signs people in: read identity only through the SDK (`everyApp()`, `getEveryAppUser()`, `requireEveryAppUser()`), never from a client-supplied header or cookie, and treat every route listed under `public` in `everyapp.config.ts` as open to the internet. What the Gateway promises and what the app must do itself: `docs/threat-model.md`.
