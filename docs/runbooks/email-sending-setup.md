# Email Sending Setup

The gateway sends its own mail (sign-up verification, password resets,
invitations) and apps' mail, through its `email` capability
([Apps send through the gateway](#apps-send-through-the-gateway)), with one
provider for the whole gateway: **Cloudflare Email Sending** (the default)
or **Resend**. [Choosing a provider](#choosing-a-provider) says which one
sends.

Cloudflare Email Sending has two transports:

- **Workers binding (default):** deployed Workers use the `EMAIL` binding
  declared in `apps/every-app-gateway/cloudflare.config.ts`. It does not use
  an API token.
- **REST:** Docker self-hosting uses the Email Sending REST API because its local
  `EMAIL` binding only writes `.eml` files. Set both `EMAIL_REST_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` to select REST explicitly. When both are present, REST
  takes precedence over the binding.

Resend sends through its API with the gateway's `RESEND_API_KEY`
([Resend](#resend)).

Email is optional. Without a sender and a provider, or when a send fails,
inviting someone still creates the invitation and the admin gets a **Copy invite
link** instead (single use, 72 hours, only for the invited email), and
**Generate password reset link** gives a one-hour, single-use reset link. The
Users page shows "Email is not configured" until it is.

## Choosing a provider

One provider sends everything, picked when each mail goes out
(`apps/every-app-gateway/src/server/email/providers/index.ts`):

1. `EMAIL_PROVIDER`, when set (`cloudflare` or `resend`, any case), names
   it, and that provider must be set up. One that isn't, or a value that
   isn't a provider, leaves the gateway unable to send (as if email weren't
   configured; `email.send.failed` logs the reason). It never falls back to
   the other provider.
2. Without it, the first provider, Cloudflare then Resend, whose settings
   are set: `EMAIL_REST_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`, then
   `RESEND_API_KEY`.
3. Otherwise Cloudflare's `EMAIL` binding. Every gateway Worker declares
   it, so it never outranks a `RESEND_API_KEY` you set: a deployed gateway
   with `RESEND_API_KEY` sends through Resend, without `EMAIL_PROVIDER`.

`EMAIL_FROM` and `EMAIL_FROM_NAME` ([Sender configuration](#sender-configuration))
are needed whichever provider sends. `GET /api/integrations/email` tells an
app which one it is (`provider`), and `email.send.failed` log lines name
the provider that refused. The daily mail budgets are the same whichever
provider sends.

## One-time domain onboarding

Ben must onboard the domain used by `EMAIL_FROM` before production sends will
work. With Cloudflare Email Sending:

```sh
npx cf email-sending subdomains create -z example.com --name example.com
```

Use only the domain (`example.com`), not the full sender address. Alternatively,
in the Cloudflare Dashboard go to **Compute & AI > Email Service > Email
Sending**, choose **Onboard Domain**, then **Add records and onboard**.

With Resend, verify the domain in Resend instead ([Resend](#resend)).

## Sender configuration

Set these sender values on the gateway Worker (`pnpm everyapp secret set
EMAIL_FROM EMAIL_FROM_NAME`; a Gateway setting's name says where it goes) or
in the Docker gateway `.env`:

- `EMAIL_FROM`: the sender address, for example `noreply@example.com`
- `EMAIL_FROM_NAME`: the display name, for example `Every App`

The previous combined format, `Every App <noreply@example.com>`, is also
accepted in `EMAIL_FROM`; in that case `EMAIL_FROM_NAME` is optional.

For Docker self-hosting with Cloudflare, also create a Cloudflare API token
for the account with **Email Sending** permission and set:

- `EMAIL_REST_API_TOKEN`: the Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID`: the account that owns the onboarded sending domain

Both values are required. Do not set `EMAIL_REST_API_TOKEN` on a deployed Worker
unless you intentionally want REST to take precedence over its binding.

## Resend

1. In Resend, add the sending domain (**Domains > Add domain**, or
   https://resend.com/domains) and publish the DNS records it lists (SPF
   and DKIM, optionally DMARC) until Resend shows it **Verified**. Until
   then Resend refuses mail from it, and the gateway's sends fail as
   `email_sender_not_verified`.
2. Create an API key (**API Keys > Create API key**). "Sending access",
   limited to that domain, is enough.
3. Give it to the gateway, with the sender if it isn't set yet:

   ```sh
   pnpm everyapp secret set RESEND_API_KEY
   pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME
   ```

   For Docker, set `RESEND_API_KEY` (and the sender) in the gateway's
   `.env`; the container keeps it across restarts. In local dev, put it in
   `apps/every-app-gateway/.dev.vars`.
4. Optionally pin the choice, for example while both providers are set up:
   `pnpm everyapp secret set EMAIL_PROVIDER` and answer the
   hidden prompt with `resend` (or `cloudflare`). `pnpm everyapp secret
   unset EMAIL_PROVIDER` goes back to the automatic choice.

Every domain an installation sends from (`everyapp email set --sender`)
must be verified in the same Resend account, the way the gateway's own is; until it
is, those sends answer `email_sender_not_verified` (422), whose message
points at https://resend.com/domains. Resend's rate limit (10 requests a
second per team by default) and daily or monthly quota answer
`email_provider_limited` (429); a key Resend refuses answers
`email_send_failed` (502), and `email.send.failed` says `Resend refused the
API key`.

Resend generates a plain-text part from the HTML when a message has none;
Cloudflare doesn't. A Resend send always reports `delivered` (Resend
answers an id, not per-recipient queues).

## Verify

1. Confirm the sending domain is active: in Cloudflare, `npx cf
   email-sending subdomains list -z example.com` gives its id, and `npx cf
   email-sending subdomains dns get <id> -z example.com` the records it
   expects; in Resend, the domain shows **Verified**.
2. `everyapp secret set …` changes the live gateway Worker, which reads each
   value on its next request; for Docker, restart the gateway after setting the
   sender and provider values in `.env`.
3. Request a password reset and send an organization invitation to addresses
   you control.
4. Confirm both messages arrive and check Worker logs for
   `email.send.failed` if either request fails (its `provider` field says
   which provider refused).

Local development intentionally does not set `remote: true` on the binding. It
therefore cannot send real email unless the REST transport or Resend is
explicitly configured. An email attempt without a usable provider or sender
configuration fails at send time and emits a structured error.

## Apps send through the gateway

An app that lists `capabilities: { email: { access: "write" } }` in its
`everyapp.config.ts` sends with `sendEmail()` from `@every-app/sdk/server`
(`docs/capabilities.md`, "Gateway services: email"). The gateway sends it with
the provider and sender above, so the setup on this page is all an app
needs; apps get no `send-email` binding of their own.

- **Which domains to onboard.** The gateway's sender domain (`EMAIL_FROM`'s)
  serves every app that sends without `from`. An app that sends as its own
  addresses has them set on its installation
  (`pnpm everyapp email set --sender "*@mail.example.com"`, in the app's
  directory, after its first deploy), and each of those domains must also
  be set up with the gateway's provider: onboarded to Email Sending in the
  gateway's Cloudflare account, the same way as above,

  ```sh
  npx cf email-sending subdomains create -z mail.example.com --name mail.example.com
  ```

  or verified in its Resend account ([Resend](#resend)). For Cloudflare,
  the zone must be on Cloudflare DNS in that account. Until a domain is set
  up the app's sends from it answer `email_sender_not_verified` (422),
  whose message names the step for the provider. Sending to arbitrary
  recipients with Cloudflare needs the Workers Paid plan, and a new account
  starts with a small daily quota that Cloudflare raises over time
  (`email_provider_limited`, 429, when it runs out).

  An app deployed from a release (`everyapp deploy <github url>`) has no
  directory here: clone its repository (only `everyapp.config.ts` is read)
  and run `everyapp email set` in it, or pass `--manifest <path>`.
- **Budgets.** App mail has its own daily budgets: 100 mails per recipient
  address and 5,000 for the whole gateway when self-hosted, 20 and 5,000 when
  hosted, counted once per distinct recipient. A hosted gateway sends app
  mail from its own sender only.
- **Check.** `GET /api/integrations/email` from the app
  (`integrationStatus({ env, provider: "email" })`) says whether the gateway
  can send, as whom, with which provider, and which senders its
  installation may name (what `everyapp email show` prints). Worker logs
  show every app send as `email.app.send` (never its subject or body).
- **Local dev.** With no gateway, `sendEmail()` really sends only through
  Cloudflare's REST API (`EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
  `EMAIL_FROM` in the app's `.dev.vars`) and prints the message otherwise.
  `integrationStatus()` names the provider the gateway would pick from the
  same `.dev.vars` (`RESEND_API_KEY`, `EMAIL_PROVIDER` included). The
  senders have a stand-in in dev: `EVERYAPP_EMAIL_SENDERS=*@mail.example.com`
  in `.dev.vars`; unset, every `from` is refused.

## Inbound mail to an app

An app that receives mail (agentic-inbox, say) exports an `email()` handler
beside its `fetch` and declares it in its manifest:

```ts
email: { inbound: true },
```

Its addresses are its installation's:
`pnpm everyapp email set --inbound "*@example.com" --inbound support@mail.example.com`
(in the app's directory, after its first deploy; `*@<apex>` is the zone's
catch-all, any other address one rule) routes them to the app's Worker,
`every-<org>-<app>`, with Email Routing rules that name it, at once;
`everyapp deploy` keeps the rules in step with the stored list. An app
whose Worker isn't uploaded yet, or whose deployed manifest doesn't declare
inbound yet, gets no rule: `email set` stores its addresses, and the deploy
that uploads the declaration checks and routes them. The deploy policy
keeps refusing the `email` trigger (cf would reconcile the account's
addresses itself, with no record of whose they are), so these rules are the
only link.

- **Before anything is written**, by `email set` and by every deploy, the
  checks: each domain's zone in the account (`EMAIL_ZONE_NOT_FOUND` if none
  holds it), a catch-all on a subdomain refused (`EMAIL_CATCH_ALL_NOT_APEX`:
  Email Routing has catch-alls on an apex only; list each subdomain address
  instead), an address another app recorded or a rule it didn't make
  delivers elsewhere (`EMAIL_ADDRESS_TAKEN`), and a catch-all that already
  sends the zone's mail somewhere (`EMAIL_CATCH_ALL_TAKEN`). A rule named
  `everyapp:<worker>`, or one that already sends the address to the app's
  Worker (the manual step below), is adopted.
- **Email Routing off for a domain** (the zone's setting for its apex,
  Cloudflare's MX records for a subdomain): turning it on adds and locks the
  domain's MX and SPF records, so its mail moves to Cloudflare. At a terminal
  the command asks; unattended it stops with `EMAIL_ROUTING_DISABLED` and
  changes nothing, and `--enable-email-routing` (a flag of `email set` and
  of `deploy`) turns it on without asking. Routing is turned on only for
  the domains the inbound addresses name.
- **Then** (at once for `email set`, after the upload for `deploy`) it
  creates a rule per address
  (`{"name":"everyapp:<worker>","matchers":[{"type":"literal","field":"to","value":"support@mail.example.com"}],"actions":[{"type":"worker","value":["<worker>"]}]}`)
  and points the catch-all at the Worker, each recorded in the gateway's D1 as
  the app's (`email-route`). An address dropped from the list loses its rule
  in the same run (`email set`) or on the next deploy, a dropped catch-all
  drops mail again, and `everyapp delete --purge` removes every route the
  app recorded.
- **Check.** `everyapp email show` and `everyapp status` list each
  installation's senders and addresses; `status` says `EMAIL_ROUTE_MISSING`
  (run `everyapp deploy`) when a rule is gone, off or sends mail elsewhere,
  or routing is off for the domain, `EMAIL_ROUTE_PENDING` (run
  `everyapp deploy`) when an address is set but not routed yet or a route
  is still there for an address the list dropped, and
  `EMAIL_INBOUND_UNDECLARED` when addresses are stored for an app whose
  deployed manifest doesn't declare inbound, which no deploy of it routes
  (`everyapp email unset --inbound` clears them, or a deploy once the
  manifest declares it; `email show` names the clearing command); a deploy
  of an app that declares inbound with no address yet
  prints one line naming `everyapp email set --inbound`.

Hosted organizations' apps (the dispatch tier) receive no mail: the deploy
API and the GitHub install refuse `email: { inbound: true }`.

By hand, for an app whose addresses aren't set yet (the Worker's name is
printed by `everyapp deploy` and `everyapp status`):

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
   Setting these addresses with `everyapp email set --inbound` later adopts
   the rules (by the name `everyapp:<worker>`, or because they already send
   to the app's Worker).

To reply from those addresses, onboard the same domain for sending (above)
and list it with `everyapp email set --sender`. The `email()` handler runs with no
identity and anyone can mail the address: it treats the message as untrusted
and calls the gateway with `for: { background: true, organizationId }`.

Locally, `everyapp dev` prints, for an app that declares
`email: { inbound: true }`, how to deliver a message to the handler:
`curl -X POST "http://127.0.0.1:<app port>/cdn-cgi/local/email?from=someone@example.net&to=hello@example.com" --data-binary @message.eml`
(any `to`: there is no routing in dev; the raw message needs a
`Message-ID` header), on the app's own dev port, not the gateway's.

Not yet verified on a live account: that a rule delivers to a Worker with no
routes and no workers.dev subdomain (every app Worker), that it survives
redeploys, the exact output of `cf email-routing rules create`, and whether
Email Routing takes a subdomain while the zone's apex has it off. If delivery
doesn't work, the fallback is a gateway-owned trigger that relays the message
to the app over its binding.
