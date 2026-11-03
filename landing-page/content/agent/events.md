---
title: "Events: webhooks, email alerts and emit()"
description: The Gateway's event bus. What an event looks like, webhook subscriptions and their signature, email alerts, events pushed to apps, an app's own events with emit(), everyapp events, and the audit log.
---

What happens on the Gateway (a member joins, an app is installed, a cap is hit, a tool call is blocked, a token is revoked) becomes one typed event. Owners and admins subscribe a target to the types they want:

- a webhook URL (Slack, Zapier, n8n, your server), signed;
- email to the organization's owners or admins;
- an app, which declares `events: { subscribe, why }` in its manifest.

The events are also the audit log. Manage them in **Manage workspace → Events**, with `everyapp events …`, or with the `everyapp_workspace_events*` tools. Members can't.

## The envelope

Every delivery is one JSON object: `id` (`evt_…`, sortable; delivery is at least once, so dedupe on it), `type`, `version`, `summary` (one line a person reads, for no-code receivers), `time`, `gateway`, `organization` (`{ id, slug, name }`), `actor` (who caused it), and `data` (the type's shape, at most 16 KiB). There's no ordering; use `time`.

Headers: `x-everyapp-event` (the type), `x-everyapp-event-id`, `x-everyapp-delivery` (the same on every retry), `x-everyapp-attempt` (1 to 7) and `x-everyapp-signature`.

## The signature

`x-everyapp-signature: t=<unix seconds>,v1=<hex>`. The `v1` value is HMAC-SHA256 with the subscription's secret over `<t>.<raw body>`. A receiver reads the raw body before parsing, compares each `v1` in constant time, and refuses a `t` more than 300 seconds off.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyEveryApp(secret, header, rawBody, now = Date.now() / 1000) {
  let t = null;
  const sigs = [];
  for (const part of (header ?? "").split(",")) {
    const [key, value = ""] = part.trim().split("=", 2);
    if (key === "t" && /^\d+$/.test(value)) t = Number(value);
    if (key === "v1") sigs.push(Buffer.from(value, "hex"));
  }
  if (t === null || sigs.length === 0 || Math.abs(now - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected));
}
```

In a Worker, `verifyWebhook(request, { provider: "everyapp", secret })` from `@every-app/sdk/server` does it (it also checks Slack and GitHub webhooks); otherwise use `crypto.subtle` with HMAC SHA-256. Every webhook has a secret: give one (16 to 128 printable characters) or let the Gateway make one, shown once.

## Patterns

A subscription's `events` list takes exact types (`member.joined`), prefixes (`member.*`), an app's own (`app.crm.*`), or `*`. `*` matches everything except `ping` and `subscription.*`. `everyapp events types` prints the catalogue. Families: `member.*`, `organization.*`, `app.*`, `cap.*`, `group.*`, `tool.*`, `connection.*`, `token.*`, `access.*`, `signin_provider.*`, `mcp_app.*`, `provider.*`, `subscription.*`, `ai.*` and `ping` (tests).

## Delivery

Webhooks get a POST with a 10-second timeout, no redirects followed, and up to 7 attempts over about 35 hours (1 m, 5 m, 30 m, 2 h, 8 h, 24 h). A 410 stops at once. Deliveries are kept 30 days and events 90. `events redeliver <dlv_…>` starts a delivery over.

A webhook URL must be public `https://`, a hostname (not an IP), not a private name (`localhost`, `*.lan`, a bare label), not the Gateway or an app host, and carry no credentials. `EVENTS_ALLOW_PRIVATE_TARGETS=true` (self-hosted) allows `http:` and private targets for a receiver on your network.

## Email alerts

An email subscription mails each event to the live owners (`--email owners`) or owners and admins (`--email admins`) through the Gateway's sender. Without a sender (`EMAIL_FROM`) the subscription is still added, and the answer's `next` says its deliveries fail until one is set. The built-in **Cap alerts** subscription mails owners and admins at 80% of a cap and at the cap; it can be paused, not removed.

## Events pushed to apps

An app that declares `events: { subscribe: ["member.removed"], why: "…" }` gets a subscription made by its deploy. Deliveries come as `POST /__everyapp/events` over the service binding, never the internet, with a system token instead of a signature. `everyApp()` answers that path itself:

```ts
export default everyApp(handler, {
  events: { on: { "member.removed": async (event) => { /* … */ } } },
});
```

Handlers run as the event's organization's background work: a Gateway call with no `for` is that organization's. Apps may receive `member.*` (not `member.password_reset`), `group.*`, `app.*` and a few other families. Dropping the field removes the subscription on the next deploy.

## An app's own events: `emit()`

```ts
import { emit } from "@every-app/sdk/server";
await emit({ env, event: "invoice.paid", data: { invoiceId, amount } });
```

The event is delivered as `app.<app id>.invoice.paid`. Nothing is declared. Rules: the name is lowercase dot-separated segments, at most 64 characters; `data` is a JSON object, at most 8 KiB and 8 levels deep; no key may read like a credential (`token`, `secret`, `apiKey`, `session`, …); at most 600 emits per app per hour. Refusals: `event_name_invalid`, `event_data_invalid`, `event_data_too_large`, `event_data_refused`, `event_rate_limited`. Under `everyapp dev` it checks the same rules and prints instead of delivering.

## `everyapp events`

Every command but `events types` is one of the Gateway's admin tools (`everyapp_workspace_events*`), run as you like the `workspace` commands ([workspace](/docs/agent/workspace)): `EVERYAPP_TOKEN` or `everyapp login --gateway <url>`. What the Gateway refuses (a target rule, the 25-subscription limit, an unknown id or type, a bad secret) is `GATEWAY_TOOL_ERROR` with its code in `data.code`; the CLI's own checks are `EVENT_SINK_CONFLICT`, `EVENT_TARGET_REQUIRED` and `VALUE_ON_COMMAND_LINE`.

| Command | Does |
|---|---|
| `events add <url> [--events <types>] [--name] [--secret \| --secret-from-env <VAR>]` | A webhook. No `--events` means everything. |
| `events add --email owners\|admins [--events <types>]` | An email subscription. |
| `events list`, `events remove <id>`, `events enable <id>`, `events disable <id>` | Manage subscriptions (`sub_…`). |
| `events test <id>` | Sends a `ping` to that subscription, paused or not, and reports the first attempt's answer. |
| `events deliveries [<id>] [--dead] [--limit <n>] [--before <cursor>]` | Recent deliveries (30 days). |
| `events redeliver <dlv_…>` | Retries one. |
| `events types` | The catalogue this CLI ships with (no Gateway needed). |

Never invent a secret or put one on the command line: leave `--secret` out, then hand `data.secret` to the person once for their receiver. A subscription's events or URL can't be changed from the CLI; remove it and add it again (the Admin page and `everyapp_workspace_events_set` can change them). An organization has at most 25 subscriptions.

## Audit log

The stored events, newest first, kept 90 days, never holding a secret: **Manage workspace → Activity → Audit**, `everyapp workspace audit` (`--type`, `--actor`, `--since`), or `everyapp_workspace_audit`.
