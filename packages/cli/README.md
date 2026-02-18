# everyapp

CLI for [Every App](https://everyapp.dev) - deploy and manage self-hosted apps on Cloudflare.

## Installation

```bash
# Run directly with npx
npx everyapp <command>

# Or install globally
npm install -g everyapp
```

## Commands

### Deploy the Gateway

Deploy the Every App Gateway to your Cloudflare account:

```bash
npx everyapp gateway deploy
```

### Create a new app

Create a new app from the starter template:

```bash
npx everyapp app create [name]
```

This will:
1. Prompt for an app ID (or use the provided name)
2. Deploy to Cloudflare (D1 database, KV namespace, Worker)
3. Configure wrangler.jsonc, package.json, and .env files
4. Install dependencies and run local migrations

### Deploy an app

Deploy your app to Cloudflare:

```bash
npx everyapp app deploy
```

Run this from your app directory to build and deploy updates.

### Set up local environment

Set up local development for an existing Every App app (for example, after cloning a repo):

```bash
npx everyapp app setup-local
```

This will:
1. Verify Cloudflare and gateway setup
2. Install dependencies
3. Create or refresh `.env.local`
4. Generate Cloudflare types and run local migrations

### Remote D1 shell

Run commands with access to your production D1 database:

```bash
npx everyapp app remote-d1-shell -- <command>
```

Examples:
```bash
# Run migrations
npx everyapp app remote-d1-shell -- npx drizzle-kit migrate

# Open Drizzle Studio
npx everyapp app remote-d1-shell -- npx drizzle-kit studio
```

## Documentation

For full documentation, visit [everyapp.dev/docs](https://everyapp.dev/docs).
