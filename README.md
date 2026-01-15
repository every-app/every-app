# Every App
The open source personal software platform.
- Build what you wish existed.
- Bring your own AI. No credits, no limits.
- Self-host on Cloudflare. Free to start, $5/month max.

## Table of Contents
- [What is Every App?](#what-is-every-app)
- [Coding Agents & Vibe Coding](#coding-agents--vibe-coding)
- [What is the Gateway?](#what-is-the-gateway)
- [Self Hosting](#self-hosting)
- [Build Your Own App](#build-your-own-app)
- [Docs](#docs)

## What is Every App?

Every App is a self-hosted platform for personal web apps. Use your favorite coding agent to build apps tailored to yourself, family, friends or your company.

Every App handles the boring parts like auth, setting up your database, and hosting so that you can focus on building your idea.

Self host on Cloudflare with one simple CLI command. Since apps are built for Cloudflare's Serverless platform, hosting starts completely free. Even with dozens of apps, you're unlikely to exceed the $5/month paid plan.

## Coding Agents & Vibe Coding
Every App is for Engineers. It’s designed so that you can build awesome apps leveraging Coding Agents quickly, but with an unlimited ceiling of quality.

After you follow the instructions for setting up the Gateway, start with just vibe coding an idea you have, reimplement an old side project or test the example prompt in Build an App for building a kanban board. This will be a full stack app with a database and any other infra you need from Cloudflare, not a toy app that only works on localhost.

Once you’ve built something you love, you could stay in this Vibe Coding zone forever (please use the Security Review prompt), or you could dig deeper and build the best project of your life.

### Screenshots

This screenshot is of a split window.

- Left - Gateway showing the apps the user is self hosting
- Right - Workout App: Program editor page

![Gateway and Workout Tracker](docs/images/gateway-and-workout-tracker.png)

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
- LLM Gateway (Coming soon)
    - Configure LLM provider once, instead of once per app. Define per-app budgets.
- App Management (Coming soon)
    - Deploy and update apps via the UI instead of by running CLI commands to deploy.

</details>

## Self Hosting

### Prerequisites

1. Install [Node.js](https://nodejs.org/) (LTS version recommended)

   This also installs `npx`, a tool that runs Node packages without installing them globally. You'll see `npx` commands throughout these docs.

2. Make a Cloudflare Account (No credit card needed) - https://dash.cloudflare.com/sign-up

   Skip any Cloudflare onboarding like configuring a domain, this is unnecessary for Every App. 

3. Authenticate with Cloudflare (choose one):
   - Login via the [Cloudflare CLI](https://developers.cloudflare.com/workers/wrangler/commands/#login) (recommended):
     ```bash
     npx wrangler login
     ```
   - Or set the `CLOUDFLARE_API_TOKEN` environment variable

### Self Host Gateway

```bash
npx @every-app/cli gateway deploy
```

Follow the link this returns to create your account in the Gateway.

### Self Host Apps

#### Todo App

A minimal todo list app with keyboard navigation.

```bash
npx gitpick every-app/every-app/tree/main/apps/todo-app every-todo-app
cd every-todo-app
npx @every-app/cli app deploy
```

<details>
<summary><h4>Workout Tracker</h4></summary>

Track your workouts and programs.

```bash
npx gitpick every-app/every-app/tree/main/apps/workout-tracker every-workout-tracker
cd every-workout-tracker
npx @every-app/cli app deploy
```

</details>

<details>
<summary><h4>Cooking Assistant</h4></summary>

An AI Cooking Assistant and Recipe Manager

```bash
npx gitpick every-app/every-app/tree/main/apps/chef every-app-chef
cd every-app-chef
npx @every-app/cli app deploy
```

This also requires an OpenAI API key since its a chat interface:
```bash
npx wrangler secret put OPENAI_API_KEY
```

</details>

## Build Your Own App
### Coding Agent Setup
We recommend setting up the Every App MCP before building your app.

Add this config so that your agent can reference the example applications when building your app. Remember to remind it to use this tool if its not automatically.

Add to your `opencode.json`:

```jsonc
{
  "mcp": {
    "every-app": {
      "type": "local",
      "command": ["npx", "-y", "@every-app/mcp"]
    },
    // Tool for up to date documentation for libraries + Cloudflare
    "context7": {
      "type": "local",
      "command": [ "npx", "-y", "@upstash/context7-mcp"]
    }
}
```

For other AI tools (Claude Code, Cursor, etc.), see the [Coding Agent Setup docs](https://everyapp.dev/docs/coding-agent/setup/).

### CLI - app create
The create command deploys your app to Cloudflare, registers it with your Gateway and sets up your local development environment.

```bash
npx @every-app/cli app create
cd your-project-name
pnpm run dev
```

Click the "Dev" button for the app in the Gateway to use your local dev server instead of the deployed version.

### Database Migrations
When you or your coding agent make changes to the database schema, run the migrations locally:

```bash
pnpm run db:generate
pnpm run db:migrate:local
```

### App Features
Anything you can build on Cloudflare, you can build in Every App.

- [All Cloudflare Infrastructure](https://developers.cloudflare.com/directory/?product-group=Developer+platform)
    - Workers, KV, D1, Queues, Serverless Containers, Agents and more. Cloudflare's developer platform gives you everything you need to build amazing full stack web apps.
- [Tanstack Start](https://tanstack.com/start/latest)
    - Modern full stack framework built by the react-query team. Focused on type safety and a great DevEx for building applications.

### Patterns
Our example apps follow well-defined patterns so that coding agents can help build high-quality apps. Reading the [Patterns docs](https://everyapp.dev/docs/walkthrough/overview/) isn't necessary to get started, but could be helpful when you want to understand why your agent is structuring code the way it is.

- [Users & Auth](https://everyapp.dev/docs/walkthrough/users-and-auth/) - How auth flows from the Gateway to your app
- [Theming & Styling](https://everyapp.dev/docs/walkthrough/theming/) - Component library setup with light/dark themes
- [Drizzle & DB Schema Design](https://everyapp.dev/docs/walkthrough/drizzle-db-schema-design/) - Drizzle schema patterns
- [Organize Backend Code](https://everyapp.dev/docs/walkthrough/organize-backend-code/) - Structuring server functions
- [Instant UI Updates](https://everyapp.dev/docs/walkthrough/instant-updates/) - Optimistic updates for snappy UX
- [AI Chat & Tool Calls](https://everyapp.dev/docs/walkthrough/ai-chat/) - Streaming responses and user confirmations

## Docs
Reference the full docs to learn more: 
- https://everyapp.dev/docs
