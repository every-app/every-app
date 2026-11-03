---
title: Email
description: How an app sends mail through the Gateway with sendEmail(), receives mail in its email() handler, what everyapp email set configures, and the operator's setup.
---

The Gateway holds the mail provider and the default sender. Apps send through it with `sendEmail()` and never hold a provider key. Two lists belong to each installation, never to the manifest, so a release carries no one's domain:

| List | Set with | Means |
|---|---|---|
| senders | `everyapp email set --sender` | the `from` patterns the Gateway accepts from this app; empty: the Gateway's sender only |
| inbound | `everyapp email set --inbound` | addresses whose mail Email Routing delivers to the app's Worker |

The manifest declares what the app does: `capabilities: { email: { access: "write" } }` (it sends) and `email: { inbound: true }` (its Worker exports `email()`).

## Operator setup

Guide: `setup/email.md` in the everyapp skill.

1. Onboard the sending domain to one provider. For Cloudflare Email Sending, use the dashboard (Compute & AI → Email Service → Email Sending → Onboard Domain) or `cf email-sending subdomains create`. For Resend, verify the domain there.
2. Set the sender: `everyapp secret set EMAIL_FROM EMAIL_FROM_NAME`. `EMAIL_FROM` is an address or `Name <address>`; a display name is required one way or the other.
3. Give the Gateway a transport. A deployed Gateway already has Cloudflare's `EMAIL` binding. Resend needs `RESEND_API_KEY`; the REST API needs `EMAIL_REST_API_TOKEN` with the account. `EMAIL_PROVIDER` (`cloudflare` or `resend`) picks when both are set up.
4. Onboard every domain an app sends as. `email set --sender` doesn't check it; the provider refuses at send time (`email_sender_not_verified`).
5. For inbound mail, the domain must be a zone in the Gateway's account with Email Routing on. Turning it on locks the domain's MX and SPF to Cloudflare, so it needs the person's yes (`--enable-email-routing`).

The same sender sends invitations, password resets and cap alerts. Without it, the Gateway shows invite links to copy instead.

## `everyapp email set`

Run in the app's directory (or `--manifest <path>`) after its first deploy. Each flag replaces its whole list.

- `--sender <pattern>`: `*@<domain>` (any address on exactly that domain) or one address, up to 20. Needs the `email` capability (`EMAIL_NOT_DECLARED`).
- `--inbound <address>`: `*@<apex>` (a zone's catch-all) or one address, up to 50. Needs `email: { inbound: true }` (`EMAIL_INBOUND_NOT_DECLARED`).
- `--enable-email-routing`: turn Email Routing on for inbound domains without asking.

It writes the lists to the Gateway and makes or removes the Email Routing rules at once; no deploy. An address another rule or app holds is never taken over (`EMAIL_ADDRESS_TAKEN`). `everyapp email unset senders|inbound` clears a list. `everyapp email show` prints both against the manifest and what's routed. Deploys keep the rules in step, and `delete --purge` removes them.

## `sendEmail()`

```ts
import { sendEmail } from "@every-app/sdk/server";

const { messageId, status } = await sendEmail({
  env,
  message: {
    to: "customer@example.net",
    subject: "Your order shipped",
    text: "It's on its way.",
    from: { address: "orders@mail.example.com", name: "Acme" }, // optional
  },
});
```

The message takes `to`, `cc`, `bcc` (50 recipients together), `subject` (one line), `text` and/or `html`, `from` (absent: the Gateway's sender; present: must match one of the app's senders), `replyTo`, `headers` (up to 20, no reserved names) and `attachments` (up to 32, base64 `content`, `disposition` `attachment` or `inline` with `contentId`). The whole body is at most 5 MiB. `status` is `delivered`, `queued`, or `logged` (local dev, not sent). From a cron or `email()` handler, pass `for: { background: true, organizationId }`.

It throws `GatewayRefusalError` with a code:

- `capability_not_requested`: the manifest doesn't list `email`.
- `email_sender_not_allowed`: `from` matches no sender.
- `email_invalid_message`: the message breaks a rule.
- `email_sender_not_verified`: the domain isn't onboarded at the provider.
- `integration_not_configured`: the Gateway has no sender or provider.
- `email_budget_exhausted` (429): the daily budget is spent, 100 per recipient and 5,000 per Gateway on a self-hosted Gateway.
- `email_provider_limited`, `email_send_failed`, and `integration_read_only` (an AI client without write access).

`integrationStatus({ env, provider: "email" })` says whether sending is ready, the default sender and the app's senders, without sending. An app that wants Cloudflare's own binding with its own domain declares `resources.sendEmail` instead ([manifest](/docs/agent/manifest#email-sending)).

## Receiving mail

```ts
export default {
  ...everyApp(handler, { tools }),
  async email(message, env, ctx) {
    // message.from, message.to, message.headers, message.raw; message.reply(), forward(), setReject()
  },
};
```

The handler gets no identity: anyone can mail the address, so treat the message as untrusted. Its Gateway calls need `for: { background: true, organizationId }`. Declare `email: { inbound: true }`, deploy, then `everyapp email set --inbound support@example.com`.

## Local dev

`sendEmail()` prints the message (`status: "logged"`) unless `.dev.vars` holds `EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `EMAIL_FROM`, which send for real from your own account. A `from` must match `EVERYAPP_EMAIL_SENDERS` in `.dev.vars`. For inbound, `everyapp dev` prints a curl that posts a raw message (with `From`, `To`, `Subject`, `Message-ID`) to `/cdn-cgi/local/email` on the app's port.

## Hosted Gateways

A hosted Gateway sends all app mail as its own sender (`EMAIL_SENDERS_HOSTED` refuses `--sender`) with a lower budget of 20 per recipient a day.
