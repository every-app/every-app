# Every App
The open source personal software platform.
- Build exactly what you want.
- Bring your own AI. No credits, no limits.
- Self-host in your own Cloudflare account, on Workers Paid: $5/month plus usage.

*Demo shows the Every App Gateway, a todo list optimized for keyboard navigation and an AI cooking assistant*

https://github.com/user-attachments/assets/7802f9ca-defd-4995-96f0-f46845cb3e83

## Table of Contents
- [What is Every App?](#what-is-every-app)
- [What is the Gateway?](#what-is-the-gateway)
- [Deploy Your Gateway](#deploy-your-gateway)
- [Deploy an Example App](#deploy-an-example-app)
- [Build Your Own App](#build-your-own-app)
- [Docs](#docs)

## What is Every App?

Every App is an open source platform for personal web apps.

It's built for experienced engineers who want to use their favorite AI tooling to build something with an unlimited ceiling of quality.

- We handle the tedious parts like auth, user management, database setup, and hosting so you can focus on your idea.
- Your agent can reference example apps via our MCP server, with patterns that scale as your codebase grows.
- Set it up in your own Cloudflare account with one command: `npx everyapp setup`
- Apps run on Cloudflare's serverless platform, so an idle app costs nothing beyond the $5/month Workers Paid plan.

Start by vibe coding an idea, reimplementing an old side project, or trying the [example prompt](https://everyapp.dev/docs/build-an-app/create-app/#example-prompt). Once you've built something you love, stay in vibe coding mode forever, or dig deeper and build the best project of your life.

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
- App Management (Coming soon)
    - Deploy and update apps via the UI instead of by running CLI commands to deploy.

</details>

## Deploy Your Gateway

### What you need

1. **Node.js 22.18 or newer** — https://nodejs.org

   This also installs `npx`, which runs the commands below without installing anything globally. Run everything with Node/npx — not bun: the Cloudflare CLI the deploy uses can't load the apps' `cloudflare.config.ts` under Bun.

2. **pnpm** — https://pnpm.io/installation — builds the starter app (`npm install -g pnpm`).

3. **A Cloudflare account on Workers Paid** — the one thing you buy: $5 a month, plus usage above generous included amounts ([costs](https://everyapp.dev/docs/how-it-works/gateway#what-it-costs)). [Sign up](https://dash.cloudflare.com/sign-up), then subscribe under **Workers & Pages → Plans**. The Free plan can't run Every App: D1 stops answering for the rest of the day once an account reaches its daily limits (enforced since September 2026), and the Gateway reads D1 on every request; requests also get only 10 ms of CPU.

4. **A domain on Cloudflare.** Every App lives at a subdomain of it: the Gateway at `apps.your-company.com`, each app one level below (`todo.apps.your-company.com`). Nothing else in the domain changes, so one your company already has on Cloudflare is fine.

   No domain on Cloudflare yet? Buy one in the Cloudflare dashboard (**Domains → Buy a domain**; about $10 a year for a `.com`, at cost, ready in minutes), or add one you own and point its nameservers at Cloudflare.

### Set up

```bash
npx everyapp setup
```

One command, from an empty account to a working Gateway and a live starter app:

1. It logs in to Cloudflare with Cloudflare's own CLI (a link and a code, so it works over SSH), or uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and checks for Workers Paid.
2. It asks where the Gateway lives (suggesting `apps.<your domain>`) and deploys it there. Every address is a Workers Custom Domain: Cloudflare creates its DNS record and certificate. No wildcard records, no DNS to edit by hand.
3. It opens a one-time setup link: create your owner account there. Nobody can sign up before you, and after you only people you invite.
4. Once your account exists, it logs this terminal in to the Gateway by itself, so it can deploy apps.
5. It deploys the starter app, a simple todo list, from `./simple-todo` to `https://simple-todo.apps.<your domain>`.

Stopped half-way (a login to approve, a domain to buy, a link you haven't opened yet)? Run it again: it picks up where it left off, and does nothing once everything is there. Coding agents can drive it with `--json` (NDJSON events; [Quickstart](https://everyapp.dev/docs/getting-started/quickstart) has a prompt).

[What the Gateway does](https://everyapp.dev/docs/how-it-works/gateway) explains, on one page, what it promises, what it costs, and its limits today; one to know now: deploying apps takes Cloudflare credentials that can also change the Gateway, so only let trusted admins deploy.

### Deploy from another machine

On your Gateway, go to **Admin → Tokens → Deploy token** (it's shown once), then:

```bash
npx everyapp login
```

Enter your Gateway URL, then paste the token when asked. Revoke it any time from the same page.

### Upgrading an existing install

`npx everyapp gateway upgrade` moves a Gateway to the release your CLI ships, keeping its data, users and apps.

A Gateway deployed before `setup` existed (on its domain's apex, with a wildcard DNS record) keeps its domain and app addresses while it moves to the current CLI. From a terminal:

```bash
npx everyapp gateway adopt --domain your-domain.dev --dry-run   # look first
npx everyapp gateway adopt --domain your-domain.dev             # record it as it is
npx everyapp gateway upgrade                                     # confirm when asked
npx everyapp gateway status
```

Later, `npx everyapp gateway use-per-app-domains` gives each app its own Custom Domain, after which the wildcard record can go. Details: [Upgrading an existing install](https://everyapp.dev/docs/reference/manage-your-gateway#upgrading-an-existing-install).

## Deploy an Example App

### Todo App

A minimal todo list app with keyboard navigation.

```bash
npx gitpick every-app/every-app/tree/main/apps/todo-app every-todo-app
cd every-todo-app
npx everyapp app deploy
```

Refresh your Gateway — the app appears, live at the URL the deploy prints (`https://todo.apps.your-company.com`). You're already logged in.

<details>
<summary><h4>Workout Tracker</h4></summary>

Track your workouts and programs.

```bash
npx gitpick every-app/every-app/tree/main/apps/workout-tracker every-workout-tracker
cd every-workout-tracker
npx everyapp app deploy
```

</details>

<details>
<summary><h4>Cooking Assistant</h4></summary>

An AI Cooking Assistant and Recipe Manager.

```bash
npx gitpick every-app/every-app/tree/main/apps/chef every-app-chef
cd every-app-chef
npx everyapp app deploy
```

Chat needs an OpenAI key. It goes on your **Gateway**, not the app — the Gateway holds provider keys and proxies AI calls for every app that declares the provider:

```bash
npx everyapp gateway secret set OPENAI_API_KEY
```

</details>

## Build Your Own App

```bash
npx everyapp app create
cd your-project-name
npx everyapp dev
```

`app create` scaffolds the app from the starter template, deploys it, registers it with your Gateway, and sets up local development.

`everyapp dev` runs your app behind a local Gateway that enforces the same security perimeter as production, signed in as a seeded dev user. Open the URL it prints — hot reload works as normal.

Need inspiration? Try the [example prompt](https://everyapp.dev/docs/build-an-app/create-app/#example-prompt) to get started.

### Database Migrations

When you or your coding agent change the database schema:

```bash
pnpm run db:generate
```

`everyapp dev` applies pending migrations locally on startup. To push schema changes to production, deploy — `everyapp app deploy` runs migrations as part of the deploy.

### App Features

Anything you can build on Cloudflare, you can build in Every App.

- [All Cloudflare Infrastructure](https://developers.cloudflare.com/directory/?product-group=Developer+platform)
    - Workers, KV, D1, Queues, Serverless Containers, Agents and more. Cloudflare's developer platform gives you everything you need to build amazing full stack web apps.
- [Tanstack Start](https://tanstack.com/start/latest)
    - Modern full stack framework built by the react-query team. Focused on type safety and a great DevEx for building applications.

### Patterns

Our example apps follow well-defined patterns so that coding agents can help build high-quality apps.

- [How It Works](https://everyapp.dev/docs/how-it-works/overview) - How the Gateway, perimeter, and your app fit together
- [The SDK](https://everyapp.dev/docs/how-it-works/sdk) - How auth flows from the Gateway into your app's code
- [Local Development](https://everyapp.dev/docs/build-an-app/local-dev) - `everyapp dev`, the seeded user, and migrations

## Docs
Reference the full docs to learn more:
- https://everyapp.dev/docs
- [Troubleshooting](https://everyapp.dev/docs/troubleshooting) — when a deploy fails

### Self-Hosting with Docker

To run the local Cloudflare-compatible runtime in containers instead of deploying to Cloudflare, see `SELF_HOSTING_DOCKER.md`. This is a local emulation path — it covers the Gateway and owner setup, not app deployment. If you expose ports beyond localhost, you are responsible for hardening access (reverse proxy, firewall rules, VPN/Zero Trust, etc.).
