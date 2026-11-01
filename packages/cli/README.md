# everyapp

The CLI for [EveryApp](https://everyapp.com): deploy and run private web apps on your own Cloudflare account.

Nothing is published while we work from the repository (`.github/RELEASE.md`), so the CLI runs from a checkout of it: `pnpm install` once at the root, then `pnpm everyapp <command>` anywhere in the repository (never `npx everyapp`, which is npm's old 0.2 CLI). It builds itself the first time and again whenever its source, or the SDK, perimeter or toolbus it bundles, changed (`bin/everyapp.js`). Requires Node.js 22.18 or newer.

Every command but `dev` takes `--json` (NDJSON events on stdout; exit 0 done, 1 error, 2 action required) and `--help` lists its flags.

- Every command, explained: https://everyapp.com/docs/commands
- What coding agents read: [`skills/everyapp/SKILL.md`](skills/everyapp/SKILL.md), copied into each new app by `everyapp create`
- How it is tested: [`../../docs/TESTING.md`](../../docs/TESTING.md)
