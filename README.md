# Every App
The open source personal software platform.
- Build exactly what you want.
- Bring your own AI. No credits, no limits.
- Self-host on Cloudflare. Free to start, $5/month max.

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
- Self host on Cloudflare with one CLI command: `npx everyapp gateway deploy`
- Since apps are built for Cloudflare's serverless platform, hosting scales to zero and starts completely free.

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

### Prerequisites

1. **Node.js 22 or newer** — https://nodejs.org

   This also installs `npx`, which runs the commands below without installing anything globally. Run everything with Node/npx — not bun, whose child-process handling makes `wrangler deploy` silently skip the upload.

2. **pnpm 9 or newer** — https://pnpm.io/installation — the CLI uses it to install and run app projects.

3. **A Cloudflare account** (free, no credit card) — https://dash.cloudflare.com/sign-up

4. **A domain on Cloudflare.** Your Gateway lives at your domain and each app gets its own subdomain — Gateway at `you.dev`, apps at `todo-<your-org>.you.dev` (your org slug is created with your account). [Add your domain to Cloudflare](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/) (free plan is fine) and update the nameservers at your registrar.

   Nameserver changes can take a few hours to propagate, so do this first. You can deploy the Gateway without a domain to look around, but apps can't be reached until you have one.

5. **Authenticate with Cloudflare** (choose one):
   - Browser login (recommended):
     ```bash
     npx wrangler login
     ```
   - Or set **both** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs the "Edit Cloudflare Workers" template plus Zone → DNS → Edit.

### Deploy

```bash
npx everyapp gateway deploy --domain you.dev
```

This creates a database and KV storage on your Cloudflare account, deploys the Gateway to your domain, and points `*.you.dev` at it.

That last part needs a wildcard DNS record. The CLI creates it when it can; if it prints instructions instead, add it once in the Cloudflare dashboard:

> **you.dev → DNS → Add record**: Type **CNAME**, Name **`*`**, Target **`you.dev`**, Proxy **ON** (orange cloud).

When it finishes, open `https://you.dev` and create your account. **Do this promptly** — the first person to reach the signup page becomes the owner. Signup is invite-only after you.

### Connect your terminal

App deploys are authorized by a deploy token. On your Gateway, go to **Admin → App Tokens** and click **Create Deploy Token** (it's shown once), then:

```bash
npx everyapp login
```

Enter your Gateway URL, then paste the token when asked. Revoke it any time from the same page.

## Deploy an Example App

### Todo App

A minimal todo list app with keyboard navigation.

```bash
npx gitpick every-app/every-app/tree/main/apps/todo-app every-todo-app
cd every-todo-app
npx everyapp app deploy
```

Refresh your Gateway — the app appears, live at the URL the deploy prints (`https://todo-<your-org>.you.dev`). You're already logged in.

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
npx wrangler secret put OPENAI_API_KEY --name every-app-gateway
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
