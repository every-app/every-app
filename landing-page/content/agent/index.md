---
title: Docs for coding agents
description: How a coding agent uses these docs to build, deploy and operate Every App apps for a person, and which page answers which question.
---

Every App has two sets of documentation. The [user docs](/docs) are short and written for the person: set up Cloudflare, get a domain, install the Gateway, create an app, invite people. These pages are the other set: complete references written for the coding agent (Claude Code, Codex, Cursor) that does the work and answers the person's questions. Most people never read these pages; their agent does.

## If you are the person

Give your agent this address and ask it anything about Every App:

```text
https://everyapp.com/llms.txt
```

New apps come with the everyapp skill (`.agents/skills/everyapp`, `.claude/skills/everyapp`), which already points here.

## If you are the agent

1. Fetch `https://everyapp.com/llms.txt`: every page with a one-line summary, in both sets.
2. Fetch the page you need as Markdown by adding `.md` to its URL, for example `https://everyapp.com/docs/agent/manifest.md`. Everything in one file is `https://everyapp.com/llms-full.txt`; prefer single pages.
3. In an Every App checkout the same pages are files: `landing-page/content/agent/*.md`, the user docs `landing-page/content/docs/*.mdx`, and the repository documents under `docs/` that the `repo/` pages mirror.
4. Answer from the page, with the exact command, flag or manifest field, and name the page. When a command fails, look up its code on [errors](/docs/agent/errors) (the anchor is the code) before trying anything else.
5. The command line tool is `everyapp`, run as `pnpm everyapp` from the checkout (never `npx everyapp`; publishing to npm is paused). Add `--json` when you drive it, and read [the protocol](/docs/agent/json). `everyapp dev` is the exception: long-running and human-facing, no `--json`.

## Which page answers what

| The question                                                                   | Page                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Set Every App up for me; deploy this; what do I do now; invite someone         | [Driving setup for a person](/docs/agent/setup)                   |
| What does this command do; which flag; what are the exit codes                 | [CLI reference](/docs/agent/cli)                                  |
| How do I read `--json` output; what is `action_required`; when do I rerun      | [The --json protocol](/docs/agent/json)                           |
| What does this error code mean and how do I fix it                             | [Error codes](/docs/agent/errors)                                 |
| Something is wrong and I have a symptom, not a code                            | [Troubleshooting by symptom](/docs/agent/troubleshooting)         |
| What goes in `everyapp.config.ts`; public routes; resources; migrations        | [everyapp.config.ts reference](/docs/agent/manifest)              |
| Who is the user; which headers and env does my Worker get; the SDK             | [Identity, headers and the SDK](/docs/agent/identity)             |
| Where does an API key go; Gateway settings; capabilities; `.dev.vars`          | [Secrets, Gateway settings and capabilities](/docs/agent/secrets) |
| Why does it work locally and not deployed; `everyapp dev`                      | [Development vs production](/docs/agent/dev)                      |
| Send or receive mail from an app                                               | [Email](/docs/agent/email)                                        |
| Expose tools to Claude or Cursor; connect an MCP client; OAuth; tokens         | [MCP: tools, the connector and OAuth](/docs/agent/mcp)            |
| What exactly does a deploy do; what does the policy check refuse; releases     | [The deploy pipeline](/docs/agent/deploy)                         |
| Put Cloudflare Access in front; who gets in; locked out                        | [Cloudflare Access](/docs/agent/access)                           |
| The security rules and threat model; every capability; the runbooks; decisions | [From the repository](/docs/agent/repo/security-model)            |

The security model is [/docs/agent/repo/security-model](/docs/agent/repo/security-model) and the threat model (assets, actors, trust boundaries, one testable invariant per boundary) is [/docs/agent/repo/threat-model](/docs/agent/repo/threat-model); both are mirrored from `docs/`, and the invariants register behind the threat model stays on GitHub (`docs/threat-model-invariants.md`).

## Setup skills

Step-by-step setups an agent follows for the person, one file per integration, shipped with the everyapp skill (in the checkout `packages/cli/skills/everyapp/setup/`, in an app `.claude/skills/everyapp/setup/` and `.agents/skills/everyapp/setup/`; the index is `setup/README.md`): `gateway.md` (Cloudflare account, Workers Paid, domain, login, setup, owner claim, status as the check), `access.md` (`everyapp access on|off|show`), `email.md` (Cloudflare Email Sending or Resend, `EMAIL_FROM`, `email set`), `dataforseo.md`, `context.md`, `openrouter.md`, `openai.md`, `workers-ai.md` (API keys: where the key comes from, plan, exact secret name, smoke check), `google.md`, `microsoft-365.md`, `slack.md` (OAuth clients: console steps, redirect URI, scopes, the secret by pipe). The setup files say what to do; these pages say why and what every field, flag and code means.

## What to tell the person

Every App is open source, very powerful, alpha, and moving fast; the team tries not to break things, and a deploy saves a restore point before it changes a database. It is built for a solo founder or a three-to-four person startup that wants its own apps on its own Cloudflare account. For a company's Gateway, recommend [Cloudflare Access](/docs/agent/access) in front of it.

## Keeping these pages true

The CLI reference is generated from the commands, and a test in `packages/cli/src/docs` fails when a page misses a command, flag, error code, manifest field, Gateway setting, header or SDK export the code defines. The `repo/` pages are mirrored from `docs/` and `adr/` at build time. Edit the rest in `landing-page/content/agent/`.
