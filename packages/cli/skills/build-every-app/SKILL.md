---
name: build-every-app
description: Build or change an app on EveryApp: create one, add a feature, a page, a table, an AI tool, a capability, a public route or a secret, the way the apps already on EveryApp do it. Use before writing any code for an EveryApp app, for "build me an app", "add X to the app" or "make the app do Y".
---

# Build an app on EveryApp

An EveryApp app is a private web app on the person's own Cloudflare account,
behind their Gateway. The Gateway signs people in, holds every key and serves
the app's tools to AI clients. The app gets nothing it doesn't declare in
`everyapp.config.ts`.

This skill is short on purpose. Before the first edit, read the build page
and the patterns table. They change without a CLI upgrade:

- https://everyapp.com/docs/agent/build.md: how to build, the shape of the
  starter, working with the person
- https://everyapp.com/docs/agent/patterns.md: each job, and the file to copy
  from the starter or an open app
- Every other page: https://everyapp.com/llms.txt. No network:
  `pnpm everyapp docs <page>`

## Rules that don't change

1. **The Gateway signs people in.** Read the user only as `context.user`
   (behind `ensureUserMiddleware`) or the `user` a tool handler gets. No
   login, session, cookie or token check of the app's own.
2. **Every route is private, every query scoped** by `user.id` or the
   organization. A route is public only when listed under `public`, and
   then it checks what it must itself.
3. **Schema in `src/db/schema.ts`,** then `pnpm run db:generate`, and commit
   the migration. Never edit a deployed migration.
4. **A value the app needs is declared, never pasted.** It never goes
   through the chat, into a committed file or onto a command line.
5. **`pnpm dev` to try, `pnpm test` and `pnpm types:check` before a pull
   request, `pnpm run deploy` to ship.** Never `cf deploy` or
   `wrangler deploy`.
6. **Never edit this skill** (it's a link into the CLI package) **and never
   vendor the SDK or CLI** into the app.

## Where to read, by job

| Job | Page |
| --- | --- |
| A field of `everyapp.config.ts`: secrets, settings, capabilities, features, `public` and bearer routes, resources | https://everyapp.com/docs/agent/manifest.md |
| Who the user is; headers; the SDK | https://everyapp.com/docs/agent/identity.md |
| Where a value lives; `configure` | https://everyapp.com/docs/agent/secrets.md |
| AI calls through the Gateway; providers | https://everyapp.com/docs/agent/ai.md, https://everyapp.com/docs/agent/providers.md |
| The app's AI tools (`defineTools()`) | https://everyapp.com/docs/agent/tools.md |
| Sending and receiving email | https://everyapp.com/docs/agent/email.md |
| `pnpm dev`; local vs production | https://everyapp.com/docs/agent/dev.md |
| Deploys and releases | https://everyapp.com/docs/agent/deploy.md |
| A Mac or phone app signing in | https://everyapp.com/docs/agent/native.md |
| Running `pnpm everyapp` | the everyapp skill beside this one |
| Before a pull request that touches identity, public routes, tools, secrets or queries | https://everyapp.com/docs/agent/security-review.md (`/security-review` in Claude Code) |
