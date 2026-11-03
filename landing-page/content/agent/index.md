---
title: Docs for coding agents
description: How a coding agent uses these docs to set up, build and operate EveryApp for a person, and which page answers which question.
---

EveryApp puts the web apps a person builds or installs online in their own Cloudflare account, behind one Gateway that handles sign-in, who can open what, each app's database, and one MCP address for their AI clients. The [user docs](/docs) are short and for the person. These pages are for the coding agent (Claude Code, Codex, Cursor) that does the work.

## How to use them

1. Start at `https://everyapp.com/llms.txt`: every page with one line each.
2. Fetch a page as Markdown by adding `.md`: `https://everyapp.com/docs/agent/manifest.md`. In a checkout of the EveryApp repository they're `landing-page/content/agent/*.md`.
3. Answer with the exact command, flag or field, and name the page. When a command fails, look its code up on [errors](/docs/agent/errors) first.
4. The CLI is `everyapp` (`npm install -g everyapp`; `pnpm everyapp` in a checkout). Add `--json` and read [the protocol](/docs/agent/json).

Two skills ship in the CLI package (`node_modules/everyapp/skills/<name>` in an app), and every new app links them from `.agents/skills/` and `.claude/skills/`: `everyapp` (drives the CLI; its `setup/*.md` files are step-by-step guides for each integration) and `build-every-app` (how to build an app the way the open apps do; served here as [Build an app](/docs/agent/build) and [Example patterns](/docs/agent/patterns)).

## Which page answers what

| Question | Page |
|---|---|
| Set EveryApp up for me; what only I can do | [setup](/docs/agent/setup) |
| What can my Gateway do; which command for which job; what next | [gateway](/docs/agent/gateway) |
| Install OpenSEO, OpenCRM, OpenAnalytics, OpenMail | [apps](/docs/agent/apps) |
| Every command and flag | [cli](/docs/agent/cli) |
| Reading `--json` output, actions, reruns | [json](/docs/agent/json) |
| What an error code means | [errors](/docs/agent/errors) |
| Something's wrong, no code | [troubleshooting](/docs/agent/troubleshooting) |
| What's left to do; Needs setup | [status](/docs/agent/status) |
| Build or change an app | [build](/docs/agent/build), [patterns](/docs/agent/patterns) |
| `everyapp.config.ts` | [manifest](/docs/agent/manifest) |
| Who's the user; headers; the SDK | [identity](/docs/agent/identity) |
| Where a key goes; `configure`; Gateway settings | [secrets](/docs/agent/secrets) |
| `everyapp dev`; local vs production | [dev](/docs/agent/dev) |
| Sending and receiving mail | [email](/docs/agent/email) |
| Webhooks, alerts, `emit()`, the audit log | [events](/docs/agent/events) |
| Agent tools, the MCP address, OAuth, tokens, MCP apps | [mcp](/docs/agent/mcp) |
| A Mac or phone app signing in to one app | [native](/docs/agent/native) |
| What a deploy does; releases; delete | [deploy](/docs/agent/deploy) |
| API providers and OAuth providers | [providers](/docs/agent/providers) |
| The default AI model; AI Gateway | [ai](/docs/agent/ai) |
| Cloudflare Access | [access](/docs/agent/access) |
| Continue with Google and the like | [signin](/docs/agent/signin) |
| People, groups, app access, caps, usage | [workspace](/docs/agent/workspace) |
| Security: who is trusted with what, the boundaries and their invariants | [security](/docs/agent/repo/threat-model) |

## What to tell the person

EveryApp is open source, alpha and moving fast. It suits a solo founder or a small team that wants its own apps on its own Cloudflare account, for about $5 a month plus usage. Cloudflare Access in front is on by default; keep it on.

## Keeping these pages true

[cli](/docs/agent/cli) is generated from the commands, and the headings of [errors](/docs/agent/errors) from the codes in the source (`pnpm -C packages/cli docs:update`). Build and patterns are the build skill, copied when the site builds. A test in `packages/cli/src/docs` fails when a generated page is stale, a link or anchor is broken, the manifest page misses a field, or a page names a command or flag the CLI doesn't have.
