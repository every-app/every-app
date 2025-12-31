# What is Every App?

Every App is a self-hosted platform for running personal web applications. 

Deploy the Gateway to your Cloudflare account, and access all your apps through a single interface.

Self host open source apps with one simple command or build your own and share them with the community.

## Open Source App Ecosystem
In the near future, there will be hundreds of high quality open source apps for you to self host. We need passionate community members to get there. 

Every App handles the boring parts so you can focus on building your idea:
- **1 command self hosting**
- **Simplified auth** 
- **Complete Full Stack example codebases** 
- **Prompts for agents to build features and maintain code**

### App Screenshots
This screenshot is of a split window. 
- Left - Gateway showing the apps the user is self hosting
- Right - Workout App: Program editor page

![Gateway and Workout Tracker](docs/images/gateway-and-workout-tracker.png)

## What is the Every App Gateway?
The Gateway is the parent application that hosts all your embedded apps. It provides:

- **Single URL** - Access all apps from one place
- **Shared Auth** - Log in once, access all apps
- **PWA Support** - Add to home screen, all apps inherit PWA benefits
- **LLM Gateway (Coming soon)** - Configure LLM provider once, instead of once per app. Define per-app budgets.

Apps run inside the Gateway's iframe and receive scoped session tokens for authentication, so you don't need to implement auth in your apps.

## Self Host
### Prerequisites
1. Make a Cloudflare Account (No credit card needed) - https://dash.cloudflare.com/sign-up
2. Login via the Cloudflare CLI
```bash
npx wrangler login
```
### Self Host Gateway
```bash
npx @every-app/cli gateway deploy
```

Follow the link this returns to create your account in the Gateway.


### Self Host Apps


#### Todo App


```bash
npx gitpick every-app/every-app/tree/main/apps/todo-app every-todo-app
cd every-todo-app
npx @every-app/cli app deploy
```


#### Workout Tracker


```bash
npx gitpick every-app/every-app/tree/main/apps/workout-tracker every-workout-tracker
cd every-workout-tracker
npx @every-app/cli app deploy
```


#### Cooking Assistant


```bash
npx gitpick every-app/every-app/tree/main/apps/every-chef every-chef
cd every-chef
npx @every-app/cli app deploy
npx wrangler secret put OPENAI_API_KEY
```


## Build Your Own App


```bash
npx @every-app/cli app create
cd your-project-name
pnpm run dev
```

The create command deploys your app to Cloudflare and registers it with your Gateway automatically.

For local development, click the "Dev" button on your app in the Gateway to use your local dev server instead of the deployed version.


## Coding Agent Setup

We recommend using an AI coding assistant to build your app. You can ask it to reference the example apps we've built using this MCP server and get started super quickly building out your app.

Add to your `opencode.json`:

```json
{
  "mcp": {
    "every-app": {
      "type": "local",
      "command": ["npx", "-y", "@every-app/mcp"]
    }
  }
}
```

For other AI tools (Claude Code, Cursor, etc.), see the [Coding Agent Setup docs](https://everyapp.dev/docs/coding-agent/setup/).

## Docs

Reference the full docs to learn more:
- Walkthrough of the AI Cooking Assistant: https://everyapp.dev/docs/walkthrough/overview/
- Coding Agent Setup: https://everyapp.dev/docs/coding-agents/setup/



