# Agent instructions

An EveryApp app: a private web app on the person's Cloudflare account, behind their EveryApp Gateway.

- To build or change this app, read the build-every-app skill first: `.agents/skills/build-every-app/SKILL.md`. It points at the build and patterns pages of the agent docs.
- Before running everyapp (deploy, secrets, the database, the Gateway), read the everyapp skill: `.agents/skills/everyapp/SKILL.md`.
- Both are links into `node_modules/everyapp/skills/`, the skills of the CLI this app pins. A broken link means `pnpm install` hasn't run; where links don't work, read `node_modules/everyapp/skills/<name>/SKILL.md`. Never edit them: the app's own skills go under another name.
- The skills are short and point at the agent docs, which change without an upgrade: https://everyapp.com/llms.txt lists every page, `https://everyapp.com/docs/agent/<page>.md` is one as Markdown, and `pnpm everyapp docs <page>` prints one offline.
- The Gateway signs people in: no login, session or cookie of the app's own. Read the user only as `context.user` behind `ensureUserMiddleware`, or the `user` a tool handler receives.
- Every query is scoped: by `user.id`, as `src/server/todos.ts` does, or by the organization for rows the team shares.
- `pnpm dev` to try it, `pnpm test` and `pnpm types:check` before a pull request, `pnpm run deploy` to ship. Never `cf deploy` or `wrangler deploy`.
- When identity, public routes, tools, secrets or queries change, review the diff against https://everyapp.com/docs/agent/security-review.md (`/security-review` in Claude Code).
