# Workout Tracker

## Development

Build the workspace SDK and run Workout Tracker behind the local Every App
gateway:

```sh
pnpm -C ../../packages/sdk build
pnpm -C ../../packages/cli build
pnpm dev
```

`pnpm dev` runs `everyapp dev`, which manages the local identity keys, applies
local D1 migrations and starts the app with `cf dev` behind the local gateway.
Use `pnpm dev:vite` (bare `cf dev`) only for debugging the app server alone;
authenticated routes expect the gateway started by `pnpm dev`. The Worker is
defined in `cloudflare.config.ts` from `everyapp.config.ts`. Deploy only with
`pnpm run deploy` (`everyapp app deploy`).

## Helpful Resources

https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/
https://orm.drizzle.team/docs/connect-cloudflare-d1
