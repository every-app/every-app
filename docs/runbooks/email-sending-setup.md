# Email Sending Setup

The gateway sends password-reset and invitation emails through Cloudflare Email
Service. It supports two transports:

- **Workers binding (default):** deployed Workers use the `EMAIL` binding
  declared in `apps/every-app-gateway/wrangler.jsonc`. It does not use an API
  token.
- **REST:** Docker self-hosting uses the Email Sending REST API because its local
  `EMAIL` binding only writes `.eml` files. Set both `EMAIL_REST_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` to select REST explicitly. When both are present, REST
  takes precedence over the binding.

## One-time domain onboarding

Ben must onboard the domain used by `EMAIL_FROM` before production sends will
work:

```sh
npx wrangler email sending enable example.com
```

Use only the domain (`example.com`), not the full sender address. Alternatively,
in the Cloudflare Dashboard go to **Compute & AI > Email Service > Email
Sending**, choose **Onboard Domain**, then **Add records and onboard**.

## Sender configuration

Set these sender values on the gateway Worker or in the Docker gateway `.env`:

- `EMAIL_FROM`: the sender address, for example `noreply@example.com`
- `EMAIL_FROM_NAME`: the display name, for example `Every App`

The previous combined format, `Every App <noreply@example.com>`, is also
accepted in `EMAIL_FROM`; in that case `EMAIL_FROM_NAME` is optional. These can
be stored using the same Worker secret/config-variable workflow as the other
gateway environment values.

For Docker self-hosting, also create a Cloudflare API token for the account with
**Email Sending** permission and set:

- `EMAIL_REST_API_TOKEN`: the Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID`: the account that owns the onboarded sending domain

Both values are required. Do not set `EMAIL_REST_API_TOKEN` on a deployed Worker
unless you intentionally want REST to take precedence over its binding.

## Verify

1. Confirm Cloudflare shows the sending domain as active. From the CLI, the DNS
   check is `npx wrangler email sending dns get example.com`.
2. Deploy the Worker after setting the sender values, or restart the Docker
   gateway after setting the sender and REST values in `.env`.
3. Request a password reset and send an organization invitation to addresses
   you control.
4. Confirm both messages arrive and check Worker logs for
   `email.send.failed` if either request fails.

Local development intentionally does not set `remote: true` on the binding. It
therefore cannot send real email unless the REST transport is explicitly
configured. An email attempt without a usable transport or sender configuration
fails at send time and emits a structured error.
