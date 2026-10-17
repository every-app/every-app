# Email Sending Setup

The gateway sends password-reset and invitation emails through Cloudflare Email
Service, and so do apps, through the gateway's `email` capability
([Apps send through the gateway](#apps-send-through-the-gateway)). It supports
two transports:

- **Workers binding (default):** deployed Workers use the `EMAIL` binding
  declared in `apps/every-app-gateway/cloudflare.config.ts`. It does not use
  an API token.
- **REST:** Docker self-hosting uses the Email Sending REST API because its local
  `EMAIL` binding only writes `.eml` files. Set both `EMAIL_REST_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` to select REST explicitly. When both are present, REST
  takes precedence over the binding.

Email is optional. Without a sender and a transport, or when a send fails,
inviting someone still creates the invitation and the admin gets a **Copy invite
link** instead (single use, 72 hours, only for the invited email), and
**Generate password reset link** gives a one-hour, single-use reset link. The
Users page shows "Email is not configured" until it is.

## One-time domain onboarding

Ben must onboard the domain used by `EMAIL_FROM` before production sends will
work:

```sh
npx cf email-sending subdomains create -z example.com --name example.com
```

Use only the domain (`example.com`), not the full sender address. Alternatively,
in the Cloudflare Dashboard go to **Compute & AI > Email Service > Email
Sending**, choose **Onboard Domain**, then **Add records and onboard**.

## Sender configuration

Set these sender values on the gateway Worker (`pnpm everyapp secret set
EMAIL_FROM --for gateway`, then `EMAIL_FROM_NAME`) or in the Docker gateway
`.env`:

- `EMAIL_FROM`: the sender address, for example `noreply@example.com`
- `EMAIL_FROM_NAME`: the display name, for example `Every App`

The previous combined format, `Every App <noreply@example.com>`, is also
accepted in `EMAIL_FROM`; in that case `EMAIL_FROM_NAME` is optional.

For Docker self-hosting, also create a Cloudflare API token for the account with
**Email Sending** permission and set:

- `EMAIL_REST_API_TOKEN`: the Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID`: the account that owns the onboarded sending domain

Both values are required. Do not set `EMAIL_REST_API_TOKEN` on a deployed Worker
unless you intentionally want REST to take precedence over its binding.

## Verify

1. Confirm Cloudflare shows the sending domain as active. From the CLI,
   `npx cf email-sending subdomains list -z example.com` gives its id, and
   `npx cf email-sending subdomains dns get <id> -z example.com` the records
   it expects.
2. `everyapp secret set … --for gateway` redeploys the gateway with each
   value; for Docker, restart the gateway after setting the sender and REST
   values in `.env`.
3. Request a password reset and send an organization invitation to addresses
   you control.
4. Confirm both messages arrive and check Worker logs for
   `email.send.failed` if either request fails.

Local development intentionally does not set `remote: true` on the binding. It
therefore cannot send real email unless the REST transport is explicitly
configured. An email attempt without a usable transport or sender configuration
fails at send time and emits a structured error.

## Apps send through the gateway

An app that lists `capabilities: { email: { access: "write" } }` in its
`everyapp.config.ts` sends with `sendEmail()` from `@every-app/sdk/server`
(`docs/capabilities.md`, "Gateway services: email"). The gateway sends it with
the transport and sender above, so the setup on this page is all an app
needs; apps get no `send-email` binding of their own.

- **Which domains to onboard.** The gateway's sender domain (`EMAIL_FROM`'s)
  serves every app that sends without `from`. An app that sends as its own
  addresses lists them in its manifest (`senders: ["*@mail.example.com"]`),
  and each of those domains must also be onboarded to Email Sending in the
  gateway's Cloudflare account, the same way as above:

  ```sh
  npx cf email-sending subdomains create -z mail.example.com --name mail.example.com
  ```

  The zone must be on Cloudflare DNS in that account. Until a domain is
  onboarded the app's sends from it answer `email_sender_not_verified` (422),
  whose message names this command. Sending to arbitrary recipients needs the
  Workers Paid plan, and a new account starts with a small daily quota that
  Cloudflare raises over time (`email_provider_limited`, 429, when it runs
  out).
- **Budgets.** App mail has its own daily budgets: 100 mails per recipient
  address and 5,000 for the whole gateway when self-hosted, 20 and 5,000 when
  hosted, counted once per distinct recipient. A hosted gateway sends app
  mail from its own sender only.
- **Check.** `GET /api/integrations/email` from the app
  (`integrationStatus({ env, provider: "email" })`) says whether the gateway
  can send, as whom, and which senders the app may name. Worker logs show
  every app send as `email.app.send` (never its subject or body).

## Inbound mail to an app

An app that receives mail (agentic-inbox, say) exports an `email()` handler
beside its `fetch` and lists the addresses it receives in its manifest:

```ts
email: {
  // "*@<apex>" is the zone's catch-all; any other address is one rule.
  inbound: ["*@example.com", "support@mail.example.com"],
},
```

`everyapp deploy` then routes them to the app's Worker, `every-<org>-<app>`,
with Email Routing rules that name it. The deploy policy keeps refusing the
`email` trigger (cf would reconcile the account's addresses itself, with no
record of whose they are), so these rules are the only link.

- **Before anything is uploaded** the deploy finds each domain's zone in the
  account (`EMAIL_ZONE_NOT_FOUND` if none holds it), refuses a catch-all on a
  subdomain (`EMAIL_CATCH_ALL_NOT_APEX`: Email Routing has catch-alls on an
  apex only; list each subdomain address instead), an address another app's
  deploy recorded or a rule it didn't make delivers elsewhere
  (`EMAIL_ADDRESS_TAKEN`), and a catch-all that already sends the zone's mail
  somewhere (`EMAIL_CATCH_ALL_TAKEN`). A rule named `everyapp:<worker>`, or
  one that already sends the address to the app's Worker (the manual step
  below), is adopted.
- **Email Routing off for a domain** (the zone's setting for its apex,
  Cloudflare's MX records for a subdomain): turning it on adds and locks the
  domain's MX and SPF records, so its mail moves to Cloudflare. At a terminal
  the deploy asks; unattended it stops with `EMAIL_ROUTING_DISABLED` and
  uploads nothing, and `everyapp deploy --enable-email-routing` turns it on
  without asking. The deploy only turns it on for domains `email.inbound`
  names.
- **After the upload** it creates a rule per address
  (`{"name":"everyapp:<worker>","matchers":[{"type":"literal","field":"to","value":"support@mail.example.com"}],"actions":[{"type":"worker","value":["<worker>"]}]}`)
  and points the catch-all at the Worker, each recorded in the gateway's D1 as
  the app's (`email-route`). An address dropped from `email.inbound` loses its
  rule on the next deploy, a dropped catch-all drops mail again, and
  `everyapp delete --purge` removes every route the app recorded.
- **Check.** `everyapp status` lists each app's addresses and says
  `EMAIL_ROUTE_MISSING` (run `everyapp deploy`) when a rule is gone, off or
  sends mail elsewhere, or routing is off for the domain.

Hosted organizations' apps (the dispatch tier) take no `email.inbound`.

By hand, for an app without `email.inbound` (the Worker's name is printed by
`everyapp deploy` and `everyapp status`):

1. Enable Email Routing on the zone:

   ```sh
   npx cf email-routing enable -z example.com --name example.com
   ```

2. Send the mail to the Worker. In the dashboard: **Email Routing > Routing
   rules > Catch-all address > Edit > Send to a Worker >
   `every-<org>-<app>`**, then enable it. Or from the CLI:

   ```sh
   npx cf email-routing rules catch-all update -z example.com --body '{"enabled":true,"matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["every-<org>-<app>"]}]}'
   ```

   For addresses on a subdomain, add the subdomain to the zone's Email
   Routing (`npx cf email-routing enable -z example.com --name mail.example.com`),
   then create one literal rule per address (**Routing rules > Create address
   > Send to a Worker**, or
   `npx cf email-routing rules create -z example.com --body '{"name":"everyapp:every-<org>-<app>","enabled":true,"matchers":[{"type":"literal","field":"to","value":"support@mail.example.com"}],"actions":[{"type":"worker","value":["every-<org>-<app>"]}]}'`).
   Adding these addresses to `email.inbound` later adopts the rules.

To reply from those addresses, onboard the same domain for sending (above)
and list it in the app's `senders`. The `email()` handler runs with no
identity and anyone can mail the address: it treats the message as untrusted
and calls the gateway with `for: { background: true, organizationId }`.

Locally, `everyapp dev` prints, for an app with `email.inbound`, how to
deliver a message to the handler:
`curl -X POST "http://127.0.0.1:<app port>/cdn-cgi/local/email?from=someone@example.net&to=support@example.com" --data-binary @message.eml`
(the raw message needs a `Message-ID` header), on the app's own dev port,
not the gateway's.

Not yet verified on a live account: that a rule delivers to a Worker with no
routes and no workers.dev subdomain (every app Worker), that it survives
redeploys, the exact output of `cf email-routing rules create`, and whether
Email Routing takes a subdomain while the zone's apex has it off. If delivery
doesn't work, the fallback is a gateway-owned trigger that relays the message
to the app over its binding.
