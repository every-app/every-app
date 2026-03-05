# Todo Example App

## Development

From your terminal:

```sh
pnpm install
pnpm dev
```

## Required Auth Email Env Vars

This gateway now uses Better Auth email flows for organization invites and
password resets. Configure these secrets in your Worker environment:

- `RESEND_API_KEY`
- `EMAIL_FROM` (example: `Every App <noreply@example.com>`)

## Helpful Resources

https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/
https://orm.drizzle.team/docs/connect-cloudflare-d1
