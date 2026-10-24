# EveryApp
> Make every app open source

> Own and customize your software. Pay only for what you use.

> Why vibe code something from scratch?

It's so fun making a tool for yourself. But, it's still scary to move it off of localhost. EveryApp gives you piece of mind, with a default private design.



The open source personal software platform.
- Build exactly what you want.
- Bring your own AI. No credits, no limits.
- Self-host in your own Cloudflare account, on Workers Paid: $5/month plus usage.

*Demo shows the Every App Gateway, a todo list optimized for keyboard navigation and an AI cooking assistant*

https://github.com/user-attachments/assets/7802f9ca-defd-4995-96f0-f46845cb3e83

## Table of Contents
- [What is Every App?](#what-is-every-app)
- [What is the Gateway?](#what-is-the-gateway)
- [Work from This Checkout](#work-from-this-checkout)
- [Your First App](#your-first-app)
- [Your Gateway: `setup`](#your-gateway-setup)
- [Deploy an Example App](#deploy-an-example-app)
- [Build Your Own App](#build-your-own-app)
- [Security](#security)
- [Docs](#docs)

## What is Every App?

Every App is an open source platform for personal web apps.

It's built for solo founders and small teams who build with coding agents and want something with an unlimited ceiling of quality.

Every App is alpha: open source, very powerful, moving fast, and trying not to break things. Expect rough edges. We strongly recommend putting Cloudflare Access in front of your Gateway: see [docs/runbooks/cloudflare-access.md](docs/runbooks/cloudflare-access.md).

- We handle the tedious parts like auth, user management, database setup, and hosting so you can focus on your idea.
- Your agent can reference example apps via our MCP server, with patterns that scale as your codebase grows.
- Set it up in your own Cloudflare account with one command: `pnpm everyapp setup`
- Apps run on Cloudflare's serverless platform, so an idle app costs nothing beyond the $5/month Workers Paid plan.

Start by vibe coding an idea, reimplementing an old side project, or trying the [example prompt](https://everyapp.com/docs/create-an-app#tell-your-agent-what-you-want). Once you've built something you love, stay in vibe coding mode forever, or dig deeper and build the best project of your life.

<details>
<summary><h2>What is the Gateway?</h2></summary>

The Gateway is the parent application where you manage and access your apps.

If you look at normal SaaS or Consumer apps, they each implement the same stuff over and over like authentication and user management.

We simplify building apps by standardizing as much as possible and hoisting what we can into the Gateway.

### Gateway Features:
- Single URL
    - Go to your Gateway. Access all your apps.
- Authentication
    - Users log into the Gateway. Apps inherit auth from the Gateway. You don't need to worry about screwing up auth or building out frontend flows.
- User Management
    - Add other users to the Gateway so that they can use the apps.
- Mobile Optimized
    - User adds Gateway to their home screen once. All apps get the benefits of being rendered within the Gateway.
- LLM Gateway
    - Configure your LLM provider once on the Gateway instead of once per app. Apps declare which providers they use and never hold a provider key.
- App Management
    - Install published apps from the Gateway's Admin page (optional, turned on during setup).

</details>

## Work from This Checkout

Nothing is published right now: no npm packages, and no syncs to the public repository. The CLI, the Gateway and the apps all run from this repository, and a deploy always deploys the code in front of you. Don't use `npx everyapp`: that runs the old 0.2 CLI from npm, which can't deploy this Gateway.

### What you need

1. **Node.js 22.18 or newer** — https://nodejs.org. Run everything with Node, not Bun: the Cloudflare CLI the deploy uses can't load the apps' `cloudflare.config.ts` under Bun.

2. **pnpm** — https://pnpm.io/installation. The repository pins pnpm 10.34.5 (`packageManager` in `package.json`), and a newer pnpm switches to it by itself.

3. **A Cloudflare account on Workers Paid** — the one thing you buy: $5 a month, plus usage above generous included amounts ([costs](https://developers.cloudflare.com/workers/platform/pricing/)). [Sign up](https://dash.cloudflare.com/sign-up), then subscribe under **Workers & Pages → Plans**. The Free plan can't run Every App: D1 stops answering for the rest of the day once an account reaches its daily limits (enforced since September 2026), and the Gateway reads D1 on every request; requests also get only 10 ms of CPU.

4. **A domain on Cloudflare.** Every App lives at a subdomain of it: the Gateway at `apps.your-company.com`, each app one level below (`todo.apps.your-company.com`). Nothing else in the domain changes, so one your company already has on Cloudflare is fine.

   No domain on Cloudflare yet? Buy one in the Cloudflare dashboard (**Domains → Buy a domain**; about $10 a year for a `.com`, at cost, ready in minutes), or add one you own and point its nameservers at Cloudflare.

### Install

```bash
pnpm install
pnpm everyapp --help
```

`pnpm install` also builds the SDK, which the apps and the Gateway load from `packages/sdk/dist`. `pnpm everyapp …` runs the CLI from this checkout, anywhere in the repository. It builds itself the first time, and again whenever its source or the SDK's changes (a few seconds). Inside an app, `pnpm dev` and `pnpm run deploy` run it too. Below, `everyapp` means `pnpm everyapp`.

To type `everyapp` from anywhere, link it once: `pnpm -C packages/cli install:global` (an `npm link` of `packages/cli`).

## Your First App

```bash
pnpm everyapp create my-app
cd apps/my-app
pnpm dev
```

`create` copies the starter template (`templates/simple-todo`) to `apps/my-app`, installs it and sets up its local database, without contacting anything in Cloudflare. `pnpm dev` (`everyapp dev`) runs it behind a local Gateway that enforces the same security perimeter as production, signed in as a seeded dev user. Open the URL it prints — hot reload works as normal. When it should go live:

```bash
pnpm run deploy
```

The first deploy finds no Gateway in your Cloudflare account and offers to install one at `apps.<your domain>`: it runs `everyapp setup` (below) right there, owner account included, then deploys your app to `https://my-app.apps.your-company.com`. Refresh your Gateway and it's there. Coding agents get a one-page guide to the CLI in the new app's `.agents/skills/everyapp/SKILL.md` (and `.claude/skills/`).

Need inspiration? Try the [example prompt](https://everyapp.com/docs/create-an-app#tell-your-agent-what-you-want) to get started.

## Your Gateway: `setup`

```bash
pnpm everyapp setup --domain apps.your-company.com
```

`setup` installs the Gateway where you choose, upgrades it after a `git pull`, and repairs it when `everyapp status` says something is off. It deploys no app. From an empty account to a working Gateway:

1. It logs in to Cloudflare with Cloudflare's own CLI (a link and a code, so it works over SSH), or uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and checks for Workers Paid.
2. It builds the Gateway from `apps/every-app-gateway` and deploys it at `--domain` (leave the flag out and it asks, suggesting `apps.<your domain>`). Every address is a Workers Custom Domain: Cloudflare creates its DNS record and certificate. No wildcard records, no DNS to edit by hand.
3. It opens a one-time setup link and waits for you to create your owner account there. Nobody can sign up before you, and after you only people you invite.

Your Cloudflare login is the only credential: there is no Gateway token to create or paste. The CLI registers and deploys apps by writing the Gateway's own database with it, so apps deploy before the owner exists too (from CI, say).

Stopped half-way (a login to approve, a domain to buy, a link you haven't opened yet)? Run it again: it picks up where it left off, and once everything is there it says `<Your account>'s Gateway is up to date with <release> ✓` and changes nothing. Coding agents can drive it with `--json` (NDJSON events).

The [docs](https://everyapp.com/docs) explain what the Gateway promises and what it costs, and [How it works](https://everyapp.com/docs/how-it-works) its limits today; one to know now: deploying apps takes Cloudflare credentials that can also change the Gateway, so only let trusted admins deploy.

### Deploy from another machine

Log in to the Gateway's Cloudflare account there (`pnpm everyapp login`, or the first `pnpm everyapp` command offers it), then deploy from a checkout of this repository. That's all: nothing is kept on the machine that set the Gateway up, and the CLI finds the Gateway by asking the accounts your login sees (`--account-id` picks when more than one has one). In CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Each app records who deployed it. To take someone's deploy access away, remove them from the Cloudflare account (or revoke the API token).

### Upgrading your Gateway

The Gateway is built from this checkout, so upgrading it is `git pull` then `everyapp gateway deploy`, keeping its data, users and apps. `gateway deploy` only updates the Gateway your login finds: it never installs one. Both name what they deploy by its version when the checkout is exactly that release (its `gateway-v<version>` tag), and by commit otherwise. Deploying a new app does it too, since that redeploys the Gateway from the same checkout. The build is kept under `node_modules/.cache/everyapp` by the tree hash of the Gateway's sources (and the SDK, perimeter and toolbus it bundles), so it only happens again after they change. A checkout behind the live Gateway is refused with "run git pull"; `everyapp status` says whether the live Gateway was built from your checkout's sources, and what to run when something is off. `everyapp setup --release <file|url>` installs a published Gateway release instead, and a CLI with no checkout takes the latest release of `every-app/every-app` (.github/RELEASE.md).

## Deploy an Example App

The example apps live in `apps/`. Deploy one from its directory:

```bash
cd apps/todo-app
pnpm run deploy
```

Refresh your Gateway — the app appears, live at the URL the deploy prints (`https://todo.apps.your-company.com`). You're already logged in.

- **Todo App** (`apps/todo-app`) — a minimal todo list with keyboard navigation.
- **Workout Tracker** (`apps/workout-tracker`) — track your workouts and programs.
- **Cooking Assistant** (`apps/chef`) — an AI cooking assistant and recipe manager. Chat needs an OpenAI key, which goes on your **Gateway**, not the app: the Gateway holds provider keys and proxies AI calls for every app that declares the provider.

  ```bash
  pnpm everyapp secret set OPENAI_API_KEY
  ```

## Build Your Own App

Every command is on the [Commands](https://everyapp.com/docs/commands) page: `login`, `setup`, `gateway deploy`, `status`, `create`, `dev`, `deploy`, `delete`, `secret`, `email`, `db` and `workflow`.

### An app in its own repository

An app can live in its own repository, next to this checkout. Its `package.json` links the SDK and the CLI from the checkout by path:

```json
{
  "scripts": {
    "dev": "everyapp dev",
    "deploy": "everyapp deploy",
    "db:migrate:local": "everyapp db migrate"
  },
  "dependencies": {
    "@every-app/sdk": "link:../private-every-app/packages/sdk"
  },
  "devDependencies": {
    "everyapp": "link:../private-every-app/packages/cli"
  }
}
```

Then `pnpm install`, `pnpm dev` and `pnpm run deploy` work there as they do in `apps/`. `everyapp create` run outside this repository sets a new app up this way.

### Database Migrations

When you or your coding agent change the database schema:

```bash
pnpm run db:generate
```

`everyapp dev` applies pending migrations locally on startup. To push schema changes to production, deploy — `everyapp deploy` runs migrations as part of the deploy.

### App Features

Anything you can build on Cloudflare, you can build in Every App.

- [All Cloudflare Infrastructure](https://developers.cloudflare.com/directory/?product-group=Developer+platform)
    - Workers, KV, D1, Queues, Serverless Containers, Agents and more. Cloudflare's developer platform gives you everything you need to build amazing full stack web apps.
- [Tanstack Start](https://tanstack.com/start/latest)
    - Modern full stack framework built by the react-query team. Focused on type safety and a great DevEx for building applications.

### Patterns

Our example apps follow well-defined patterns so that coding agents can help build high-quality apps.

- [How It Works](https://everyapp.com/docs/how-it-works) - How the Gateway, the identity pass and your app fit together
- [Create an App](https://everyapp.com/docs/create-an-app) - create, describe, `pnpm dev`, deploy

## Security

Every App is open source, alpha, and moving fast. It is also very powerful: an app you deploy runs as a private Worker in your Cloudflare account with everything that account can do, and whoever holds your Cloudflare login can change anything, the Gateway included. Three things to know before you invite anyone:

- **Put the Gateway behind Cloudflare Access.** It is a second sign-in from a company that does nothing else, in front of every page and every app, before any of our code runs. `pnpm everyapp access on` sets it up ([the runbook](docs/runbooks/cloudflare-access.md) explains what it does); the Free plan covers 50 people.
- **Read the threat model.** [docs/threat-model.md](docs/threat-model.md) says what the Gateway promises, to whom, where each promise is enforced and tested, what is out of scope, and what we know is still open. [docs/security-model.md](docs/security-model.md) describes the mechanisms one by one.
- **Tell us what you find.** Report a hole privately through the repository's **Security → Report a vulnerability**, not in a public issue; a failing test is the best report. Every pull request here gets Anthropic's security review for Claude Code, and so does every app created with `everyapp create`.

## Docs
Reference the full docs to learn more:
- https://everyapp.com/docs
- [Troubleshooting](https://everyapp.com/docs/troubleshooting) — when a deploy fails

### Self-Hosting with Docker

To run the local Cloudflare-compatible runtime in containers instead of deploying to Cloudflare, see `SELF_HOSTING_DOCKER.md`. This is a local emulation path — it covers the Gateway and owner setup, not deploying apps. If you expose ports beyond localhost, you are responsible for hardening access (reverse proxy, firewall rules, VPN/Zero Trust, etc.).
