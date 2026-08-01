# Workout Tracker

## Development

Build the workspace SDK and run Workout Tracker behind the local Every App
gateway:

```sh
pnpm -C ../../packages/sdk build
pnpm -C ../../packages/cli build
pnpm dev
```

The Every App CLI manages the local identity keys needed by the app. Use
`pnpm dev:vite` only for bare Vite debugging; authenticated routes expect the
gateway started by `pnpm dev`.

## Helpful Resources

https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/
https://orm.drizzle.team/docs/connect-cloudflare-d1
