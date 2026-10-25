# Agent instructions

- Before running everyapp, read the everyapp skill: `packages/cli/skills/everyapp/SKILL.md` (`everyapp create` copies it into each new app as `.agents/skills/everyapp` and `.claude/skills/everyapp`).
- The complete references written for agents (every command and flag, the `--json` protocol, every error code, `everyapp.config.ts`, what an app receives from the Gateway, deploys, secrets, development, email, MCP, Cloudflare Access) are `landing-page/content/agent/*.md`, served at https://everyapp.com/llms.txt. Answer "how do I" questions from them; the user docs in `landing-page/content/docs` stay short and are for the person.
- Run everything from this checkout with `pnpm everyapp`, never `npx everyapp` (publishing is paused).
- Before a pull request that touches the perimeter, identity, public routes, tools, OAuth, Access, secrets or queries, run `pnpm security-review` (the security-review skill).
