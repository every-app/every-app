# Todo Example App

## Development

From your terminal:

```sh
pnpm install
pnpm dev
```

## Auth Email Configuration

This gateway now uses Better Auth email flows for organization invites and
password resets. Email delivery uses the Worker's `EMAIL` binding. Configure:

- `EMAIL_FROM` (example: `noreply@example.com`)
- `EMAIL_FROM_NAME` (example: `Every App`)

For compatibility, `EMAIL_FROM` may instead contain both values as
`Every App <noreply@example.com>`. See
[`docs/runbooks/email-sending-setup.md`](../../docs/runbooks/email-sending-setup.md)
for domain onboarding and verification.

## Helpful Resources

https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/
https://orm.drizzle.team/docs/connect-cloudflare-d1
