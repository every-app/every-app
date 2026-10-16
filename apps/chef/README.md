# Chef

> **Standalone Docker self-hosting is not supported for Chef under Every App
> v2.** Chef requires the identity configuration and gateway service binding
> that `everyapp deploy` provides. Use `pnpm run deploy` for a production
> deployment behind the gateway, or `pnpm dev` for local development.

## Development

Add a local OpenAI key, and run Chef behind the local Every App gateway:

```sh
cp .dev.vars.example .dev.vars
# Set OPENAI_API_KEY in .dev.vars
pnpm dev
```

The SDK uses `OPENAI_API_KEY` directly only in local development, where
`cloudflare.config.ts` declares it as a secret read from `.dev.vars`.
Production deploys receive the private `EVERY_APP_GATEWAY` service binding from
`everyapp deploy`; Chef does not need an app token or provider key there.
Recipe images live in the `R2` bucket, which `cloudflare.config.ts` adds to the
Worker that `everyAppWorker()` builds from `everyapp.config.ts`.

Use `pnpm dev:vite` (bare `cf dev`) only for debugging the app server alone.
Authenticated routes expect the gateway started by `pnpm dev`. Deploy only with
`pnpm run deploy` (`everyapp deploy`).

## Helpful Resources

https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/
https://orm.drizzle.team/docs/connect-cloudflare-d1
