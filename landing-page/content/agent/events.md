---
title: "Events: webhooks, email alerts and emit()"
description: The Gateway's event bus. Every event type with its version and data shape, the envelope and headers, how deliveries are signed, retried and refused, the email sink and the built-in Cap alerts, how an app emits its own events with emit(), every everyapp events command, the admin MCP tools, the error codes and the limits.
metaDescription: "The Gateway's event bus: every event type and data shape, signed and retried webhooks, email alerts, emit() from apps, and the events commands."
---

## The model

Everything the Gateway already knows about (a member joins, an app is installed, a cap is hit, an agent's tool call is blocked, a token is revoked) becomes one typed event on a bus inside the Gateway Worker. An owner or admin **subscribes** a webhook URL, or the organization's owners and admins by email, to a list of event types or patterns. The Gateway **delivers** each matching event as a signed JSON `POST` (HMAC-SHA256 over a timestamp and the body), retries a failed delivery for about 35 hours, keeps a 30-day delivery log with a visible dead state, and lets an admin redeliver. Apps emit their own events through the SDK's `emit()`, named `app.<id>.<name>`, attributed like every other Gateway call. Nothing in an event is ever a secret, a tool's arguments or result, or a mail body.

The bus needs no Cloudflare resource beyond the Gateway's own: events, subscriptions and deliveries are rows in the Gateway's D1 (`event_subscriptions`, `events`, `event_deliveries`, migration `0012_events.sql`; schema in `apps/every-app-gateway/src/db/events.schema.ts`). The first attempt runs right after the event under `waitUntil`; retries run from a per-minute cron trigger (`* * * * *`) on the Gateway Worker, beside the hourly one. The shared contract (the catalogue's names, versions and descriptions, the patterns, the app event rules, every limit and the header names) is `packages/sdk/src/internal/events.ts`, exported from `@every-app/sdk/internal` as `EVENT_TYPES`, `EVENT_HEADERS` and the constants named below; the Gateway's builders of each type's `data` and summary are `apps/every-app-gateway/src/server/events/catalogue.ts`. The design and its reasons are `docs/design/2026-10-events-out.md`.

Who does what:

| Who                       | Does                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owners and admins         | Add, change, pause, test and remove subscriptions; read deliveries; redeliver. In the Gateway (**Manage workspace** → **Events**, `/admin/events`, which the Events tab PR adds), with the CLI, or, once the twins PR lands, through the MCP tools. |
| The operator (CLI)        | The same with `pnpm everyapp events …` but changing a subscription's events or name (remove it and add it again), written straight into the Gateway's D1 under the Cloudflare login, like every `everyapp` command.                                 |
| An app                    | Emits its own events with `emit()`; declares nothing.                                                                                                                                                                                               |
| Members, read-only agents | Nothing: the bus is admin-only.                                                                                                                                                                                                                     |

The person's page is [/docs/events](/docs/events): adding a webhook, the Slack recipes, email alerts, the three verification snippets and the event list, short.

## The envelope

Every delivery body is one JSON object:

```json
{
  "id": "evt_01K8M3Z9QX7S4V2B6N8P0R1T3Y",
  "type": "member.joined",
  "version": 1,
  "summary": "jo@acme.com joined as member",
  "time": "2026-10-25T09:15:03.412Z",
  "gateway": "https://apps.acme.com",
  "organization": { "id": "org_…", "slug": "acme", "name": "Acme" },
  "actor": {
    "kind": "user",
    "id": "…",
    "email": "ada@acme.com",
    "name": "Ada"
  },
  "data": {
    "user": { "id": "…", "email": "jo@acme.com", "name": "Jo" },
    "role": "member",
    "via": "invitation"
  }
}
```

| Field          | Meaning                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `evt_` and 26 characters that sort by time (a ULID: 10 characters of Crockford base32 time, 16 of randomness, uppercase, from the Gateway and the CLI alike). Delivery is at least once: a receiver may see the same `id` twice and deduplicates on it. |
| `type`         | The event type, from [the catalogue](#the-catalogue), or `app.<id>.<name>` for an app's own.                                                                                                                                                            |
| `version`      | An integer per type. A breaking change to a type's `data` bumps it, and the old version stays documented here. Every type is at version 1 today; an app's own events are always 1.                                                                      |
| `summary`      | One line a person reads ("crm reached its monthly cap (1,000)"), so a receiver that maps only top-level string keys (Slack's Workflow Builder, Zapier's Catch Hook, Make) can post it without parsing `data`. Map `type`, `gateway` and `summary`.      |
| `time`         | When it happened, ISO 8601 in UTC with milliseconds.                                                                                                                                                                                                    |
| `gateway`      | The Gateway's URL (`GATEWAY_URL`), so one receiver can serve several Gateways.                                                                                                                                                                          |
| `organization` | `{ id, slug, name }` of the organization the event belongs to. Every event belongs to one.                                                                                                                                                              |
| `actor`        | Who caused it (below).                                                                                                                                                                                                                                  |
| `data`         | The type's shape, from the catalogue. At most 16 KiB serialized (`EVENT_DATA_MAX_BYTES`); 8 KiB for an app's own (`APP_EVENT_DATA_MAX_BYTES`).                                                                                                          |

No ordering is promised between events; `time` and `id` order them. The envelope is built at delivery time from the stored row, so an event the CLI queued reads the same as one the Gateway emitted.

### Common objects

Several types share these:

- `user`: `{ id, email, name }` of the member the event is about. `name` and `email` may be null for a person who has since left. Never a password hash, token or session.
- `actor`: `{ kind, id?, email?, name? }`, where `kind` is one of:
  - `user`: a person in the Gateway's pages.
  - `agent`: an MCP caller (`tool.*`); `id` is its credential's id and `name` its connection's client name.
  - `app`: an app's Worker (an app's own event without a signed-in person, `id` the app id).
  - `operator`: the Cloudflare login that ran the CLI: `id` is its email, or `api-token:<account id>`, with `email` when the login has one.
  - `gateway`: a cron or an internal rule (a cap check, a catalog sync, a setup-state change the Gateway saw, an idle connection expiring).
- `app`: `{ id, rowId, name }`: the manifest id, the registry row id, the display name.

## Delivery headers

| Header                 | Value                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| `Content-Type`         | `application/json`                                                       |
| `User-Agent`           | `every-app-gateway/<release version>` (`dev` without a release)          |
| `X-EveryApp-Event`     | the type                                                                 |
| `X-EveryApp-Event-Id`  | the event id (`evt_…`)                                                   |
| `X-EveryApp-Delivery`  | the delivery id (`dlv_…`): one per subscription, the same on every retry |
| `X-EveryApp-Attempt`   | `1` to `7`; a redeliver starts the count over at `1`                     |
| `X-EveryApp-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>`                                  |

Header names are case-insensitive; Node.js, Workers and the `EVENT_HEADERS` constant spell them in lowercase: `x-everyapp-event`, `x-everyapp-event-id`, `x-everyapp-delivery`, `x-everyapp-attempt`, `x-everyapp-signature`.

## The signature

The signature is HMAC-SHA256, keyed with the subscription's secret, over the UTF-8 bytes of `<t>.<body>`: the timestamp from the header, a dot, and the exact request body as sent (`eventSigningInput(timestamp, body)` in `@every-app/sdk/internal`). The header is `t=<t>,v1=<lowercase hex>` (`formatEventSignature`); `parseEventSignature` reads one, and a header may carry more than one `v1`, any of which may match. A receiver:

1. reads the raw body before parsing it (a re-serialized body won't match);
2. splits the header on `,` into `t` and the `v1` values;
3. computes the HMAC over `<t>.<raw body>` and compares it with each `v1` in constant time;
4. refuses a `t` more than 300 seconds from its clock either way (`EVENT_SIGNATURE_TOLERANCE_SECONDS`), so a captured delivery can't be replayed later.

Every webhook subscription has a secret: one given at add (16 to 128 printable ASCII characters with no spaces, `EVENT_SECRET_MIN_LENGTH`, `EVENT_SECRET_MAX_LENGTH`) or one generated and shown once (`whsec_` and 32 random bytes in base64url, from the Gateway and the CLI alike). The receiver uses the whole string, `whsec_` included, as the HMAC key. No signature means no delivery: a webhook row without a URL or a secret is `dead` with `subscription_gone`. Each snippet below is a complete receiver on `PORT` (default 3000) reading the secret from `EVERYAPP_WEBHOOK_SECRET`; the same snippets are on [/docs/events](/docs/events#check-the-signature).

### Node.js

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const SECRET = process.env.EVERYAPP_WEBHOOK_SECRET;

export function verifyEveryApp(
  secret,
  header,
  rawBody,
  now = Date.now() / 1000,
) {
  let timestamp = null;
  const signatures = [];
  for (const part of (header ?? "").split(",")) {
    const [key, value = ""] = part.trim().split("=", 2);
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1") signatures.push(Buffer.from(value, "hex"));
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(now - timestamp) > 300) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  return signatures.some(
    (given) =>
      given.length === expected.length && timingSafeEqual(given, expected),
  );
}

createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (!verifyEveryApp(SECRET, req.headers["x-everyapp-signature"], body)) {
      res.writeHead(400).end("bad signature");
      return;
    }
    const event = JSON.parse(body.toString("utf8"));
    console.log(event.type, event.id);
    res.writeHead(200).end("ok");
  });
}).listen(Number(process.env.PORT ?? 3000));
```

In a Worker, read the body with `await request.arrayBuffer()` and use `crypto.subtle` (`importKey("raw", …, { name: "HMAC", hash: "SHA-256" })`, then `verify`, which compares in constant time).

### Python

```python
import hashlib
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ["EVERYAPP_WEBHOOK_SECRET"]


def verify_everyapp(secret, header, raw_body, now=None):
    timestamp = None
    signatures = []
    for part in (header or "").split(","):
        key, _, value = part.strip().partition("=")
        if key == "t" and value.isascii() and value.isdigit():
            timestamp = int(value)
        elif key == "v1":
            signatures.append(value.encode())
    if timestamp is None or not signatures:
        return False
    if abs((now or time.time()) - timestamp) > 300:
        return False
    expected = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256
    ).hexdigest().encode()
    return any(hmac.compare_digest(expected, given) for given in signatures)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not verify_everyapp(SECRET, self.headers.get("X-EveryApp-Signature"), body):
            self.send_response(400)
            self.end_headers()
            return
        event = json.loads(body)
        print(event["type"], event["id"])
        self.send_response(200)
        self.end_headers()


HTTPServer(("", int(os.environ.get("PORT", "3000"))), Handler).serve_forever()
```

### Go

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func verifyEveryApp(secret, header string, body []byte, now time.Time) bool {
	timestamp := int64(-1)
	var signatures [][]byte
	for _, part := range strings.Split(header, ",") {
		key, value, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch key {
		case "t":
			if t, err := strconv.ParseInt(value, 10, 64); err == nil && t >= 0 {
				timestamp = t
			}
		case "v1":
			if sig, err := hex.DecodeString(value); err == nil {
				signatures = append(signatures, sig)
			}
		}
	}
	if timestamp < 0 || len(signatures) == 0 {
		return false
	}
	age := now.Unix() - timestamp
	if age > 300 || age < -300 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(timestamp, 10) + "."))
	mac.Write(body)
	expected := mac.Sum(nil)
	for _, sig := range signatures {
		if hmac.Equal(sig, expected) {
			return true
		}
	}
	return false
}

func main() {
	secret := os.Getenv("EVERYAPP_WEBHOOK_SECRET")
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || !verifyEveryApp(secret, r.Header.Get("X-EveryApp-Signature"), body, time.Now()) {
			http.Error(w, "bad signature", http.StatusBadRequest)
			return
		}
		log.Println(r.Header.Get("X-EveryApp-Event"), r.Header.Get("X-EveryApp-Event-Id"))
		w.WriteHeader(http.StatusOK)
	})
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

## Patterns

A subscription's `events` is a list of exact types or patterns (`eventPatternMatches`, `eventSubscribed` in `@every-app/sdk/internal`):

| Pattern                | Matches                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `member.joined`        | that type only                                                                      |
| `member.*`             | every type that starts `member.`                                                    |
| `app.*`                | the Gateway's `app.*` types and every app's own events (`app.crm.invoice.paid` too) |
| `app.crm.*`            | every event the app `crm` emits                                                     |
| `app.crm.invoice.paid` | that one event of that app                                                          |
| `*`                    | everything except `ping` and `subscription.*` (name those to get them)              |
| none (an empty list)   | everything except `ping` and `subscription.*`; stored as `["*"]`                    |

`ping` reaches only the subscription under test, whatever its list, and reaches it even while it is paused: that is what a test is for. A list that holds `*` is stored as `["*"]` by the CLI. A pattern is checked when it is added (`eventPatternProblem`): lowercase segments joined by dots, optionally ending `.*`, that match at least one catalogue type, or name an app's own events (`app.<id>.*`, `app.<id>.<name>`); anything else is `EVENT_TYPE_UNKNOWN`. The Gateway's `app.*` types have exactly one segment after `app.`; an app's own have two or more (`isAppOwnEventType`).

## Delivery and retries

**Queueing.** An emit inserts the `events` row, reads the organization's subscriptions, matches the enabled ones' patterns in code, and inserts one `event_deliveries` row per match with `status` `pending`, in one D1 batch. A type with a dedupe key (the cap events: `cap.reached:<org>:<app row>:<month>:<cap>`, `app.paused_cap:…` the same, `cap.warning:<org>:<app row>:<month>:<cap>:80`) is emitted at most once per key: a second insert collides and nothing is delivered. A paused subscription (`enabled` 0) gets no delivery rows. The Gateway then attempts the new deliveries at once under `waitUntil`. An event the CLI queues (`app.installed`, `app.updated` and `app.removed` from its deploys and removals, `app.needs_setup` and `app.ready` after `configure`, `secret set|unset` and `deploy`, `access.changed`, `mcp_app.*`, the ping of `events test`) is written in the same D1 batch as the change it reports, and has no `waitUntil`: the per-minute sweep picks it up within a minute. An emit that fails is logged (`events.emit_failed`) and swallowed: a webhook never breaks the action that caused it.

**An attempt.** The Gateway claims the row for 60 seconds (the claim adds one to `attempts`, so the first attempt is attempt 1), loads the event (gone: the delivery is `dead` with `event_gone`) and the subscription (gone, or paused and the event isn't a `ping`: `dead` with `subscription_gone`), checks the URL against the [target rules](#targets) again, builds the body, signs it and posts it with `redirect: "manual"` and a 10-second timeout (`EVENT_DELIVERY_TIMEOUT_MS`). Any 2xx is delivered. Anything else fails, with a code at the start of the delivery's `last_error`:

| `last_error`                             | When                                                                                                                                                 | Then                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `redirect`                               | a 3xx: the Gateway never follows one, so a target can't send the body elsewhere; `last_status_code` keeps the status                                 | retried                          |
| `status_<code>: <answer>`                | another status; the answer's first 200 characters (`EVENT_RESPONSE_KEEP_CHARS`) of at most 1 KiB read (`EVENT_RESPONSE_READ_MAX_BYTES`), on one line | retried; a 410 is `dead` at once |
| `timeout`                                | no answer within 10 seconds                                                                                                                          | retried                          |
| `connection: <message>`                  | a network error                                                                                                                                      | retried                          |
| `target_refused: <reason>`               | the URL breaks a [target rule](#targets) now (a setting changed since it was added)                                                                  | retried                          |
| `internal: <message>`                    | the Gateway failed building or sending it                                                                                                            | retried                          |
| `event_gone`, `subscription_gone`        | above                                                                                                                                                | `dead` at once                   |
| `email_…`, `no_recipients`, `partial: …` | the [email sink](#the-email-sink)                                                                                                                    | as said there                    |

Never the request body.

**Retries.** The first attempt is immediate; after attempt n fails the next waits (`EVENT_RETRY_DELAYS_MS`):

| After attempt | Next attempt in |
| ------------- | --------------- |
| 1             | 1 minute        |
| 2             | 5 minutes       |
| 3             | 30 minutes      |
| 4             | 2 hours         |
| 5             | 8 hours         |
| 6             | 24 hours        |
| 7             | none: `dead`    |

Seven attempts (`EVENT_DELIVERY_MAX_ATTEMPTS`) over about 35 hours. A target answering 410 Gone is `dead` at once. Retry resolution is one minute. A `target_refused` attempt counts like any failure: unsetting `EVENTS_ALLOW_PRIVATE_TARGETS` stops deliveries to a private target, and setting it again before the schedule runs out lets the next attempt through.

**The sweep.** The per-minute cron (`* * * * *`) takes up to 50 `pending` rows whose `next_attempt_at` has come and that no one holds, soonest due first, attempts them six at a time and stops after 25 seconds, leaving the rest for the next minute. The hourly cron runs the sweep too, so a Gateway whose per-minute trigger was never published (installed before events and not yet updated with `pnpm everyapp update`) still delivers, hourly.

**States.** A delivery is `pending` (waiting for its first attempt or a retry), `delivered`, or `dead` (no more attempts). `events deliveries` splits `pending` into queued and `failed` (the last attempt failed and a retry is due). The subscription records `last_delivery_at`, `last_delivery_status` (`delivered`, `failed`, `dead`) and `consecutive_failures` (each failed or dead attempt adds one, a delivered one resets it); the Events tab and `events list` show them.

**Redeliver.** `events redeliver <delivery id>` (or **Redeliver** on a failed or dead row in the Deliveries sheet) takes a `pending` or `dead` delivery back to `pending`, due now, with `redelivered_at` stamped and its attempts reset to 0, so it gets the whole schedule again: the next try is attempt 1 (`X-EveryApp-Attempt: 1`), then up to six retries over about 35 hours. A `delivered` delivery is left alone, and so is one an attempt holds right now (the CLI answers `outcome` `delivered` or `attempting` and changes nothing). The delivery id and `X-EveryApp-Delivery` stay the same, and the receiver sees the same event `id` again. The Gateway attempts it at once from the UI; from the CLI the sweep sends it within a minute. The CLI refuses a delivery whose subscription was removed (`EVENT_SUBSCRIPTION_NOT_FOUND`) or is paused (`EVENT_SUBSCRIPTION_DISABLED`), since the Gateway would drop it.

**Retention.** The hourly maintenance deletes `event_deliveries` rows older than 30 days (`EVENT_RETENTION_DAYS`) and `events` rows older than 90 days (`AUDIT_RETENTION_DAYS`: the events are the [audit log](#audit-log)), both constants, not settings, 10,000 rows of each a run. Subscriptions are kept until removed and go with their organization.

## Targets

A webhook URL is checked when it is added and again before every attempt (`apps/every-app-gateway/src/server/events/target.ts`; the CLI's copy for `events add` is `packages/cli/src/lib/gateway/eventTarget.ts`), so a changed setting applies to existing subscriptions:

- `https:` only (`http:` with [the setting](#events_allow_private_targets); any other scheme never);
- a hostname, not an IP literal (IPv4 in any spelling the URL parser reads as one, or a bracketed IPv6);
- not a local or private name: `localhost`, `local`, `localdomain`, `internal`, `intranet`, `lan`, `corp`, `private`, `home.arpa` or `onion`, or a name under one (`n8n.lan`, `hooks.acme.corp`), or a bare label with no dot (`n8n`), which only a private resolver answers (`EVENT_PRIVATE_NAME_SUFFIXES` and `isPrivateEventTargetName` in `@every-app/sdk/internal`, the one list the Gateway and the CLI read);
- not the Gateway's own host, an app's host under `APP_BASE_DOMAIN`, or the hosted tier's third-party domain (`THIRD_PARTY_DOMAIN`), nor a name under one; the CLI can't read `THIRD_PARTY_DOMAIN` back, so `events add` lets such a URL through and the Gateway refuses it at the first attempt;
- no user name or password in the URL, no fragment;
- at most 2,048 characters (`EVENT_URL_MAX_LENGTH`).

A refused URL is `EVENT_TARGET_REFUSED` at add, and `target_refused: <reason>` in `last_error` on an attempt, a failure that retries like any other.

The URL is pinned: a delivery goes to the stored URL as stored, with no per-event override and no redirect. To move a subscription, remove it and add the new URL.

### EVENTS_ALLOW_PRIVATE_TARGETS

`EVENTS_ALLOW_PRIVATE_TARGETS` is a Gateway setting for self-hosted Gateways (`pnpm everyapp secret set EVENTS_ALLOW_PRIVATE_TARGETS`, value `true`; `false` or unset is off, and `secret set` takes nothing else). The Gateway turns it on for exactly `true`; `events add` can read only whether the setting exists, not its value, and checks as if it were on when it does. On, it lets `http:` URLs, IP literals and the private names above (bare labels included) through, for an operator wiring an internal n8n or the like. The Gateway Worker runs with `global_fetch_strictly_public`, so a name that resolves to a private address still won't be reached from Cloudflare's edge, and an RFC 1918 or loopback address isn't routable from there in any case: in practice the setting buys `http:` and internal names that resolve publicly, such as a host behind Cloudflare Tunnel. The Gateway's own hosts and the apps' hosts are refused even with it on, so a subscription can never loop back into the Gateway. Listed with the other Gateway settings on [/docs/agent/secrets](/docs/agent/secrets#events-out).

## The email sink

A subscription with sink `email` mails each event to the organization's live owners (recipients `owners`) or owners and admins (`admins`), each recipient once per delivery, through the Gateway's own sender ([/docs/agent/email](/docs/agent/email); it needs `EMAIL_FROM` and a provider). It never takes an address: recipients are always members, so the Gateway never mails outside the organization (`apps/every-app-gateway/src/server/events/email-sink.ts`). The subject is `[<organization>] <summary>`; the body is the summary, the fields a person reads (the member, the app, the cap and the month's calls, the tool, the unmet settings, the token's name, by name; an app's own event lists its top-level strings and numbers) and one link: `/admin/usage` for `cap.*` and `app.paused_cap`, `/admin/users` for `member.*`, `/admin/activity` for `tool.*`, `/admin/tokens` for `token.*`, `/settings/connections` for `connection.*`, `/admin/apps` for the other `app.*` types (an app's own events too) and `mcp_app.*`, `/admin/events` for the rest (`ping`, `access.changed`, `provider.*`). It ends: "You get this because you are an owner or admin of <organization>. Change it under Manage workspace, Events."

Event mail is its own kind, `notice`, with daily budgets of its own: 50 per recipient address and 2,000 per Gateway self-hosted; 20 and 2,000 hosted.

**Who was mailed is remembered per delivery**: a marker per recipient (`events:mailed:<delivery>:<HMAC of the address>` in `rate_limit_counters`, kept three days, past the whole schedule), so a retry mails only the recipients still owed it and nobody twice. The delivery is `delivered` once every recipient has it, and its `last_status_code` is the number of recipients mailed. When some are mailed and some aren't, the attempt fails with `last_error` `partial: <n> of <m> mailed; <code>` and retries on the webhook schedule for the rest. The codes:

| `last_error`             | When                                                                        | Then           |
| ------------------------ | --------------------------------------------------------------------------- | -------------- |
| `email_not_configured`   | the Gateway can't send at all (no `EMAIL_FROM`, or no provider it can use)  | `dead` at once |
| `no_recipients`          | the organization has no live owner (or admin) to mail; `last_status_code` 0 | `dead` at once |
| `email_budget_exhausted` | a `notice` budget is spent for the day                                      | retried        |
| `email_send_failed`      | the provider refused the mail                                               | retried        |

`events add --email` warns [`EVENT_EMAIL_NOT_CONFIGURED`](/docs/agent/errors#event_email_not_configured) when the Gateway has no `EMAIL_FROM`, and adds the subscription all the same.

### Cap alerts

When an owner or admin sets a monthly cap on an app, or a default cap for every app (Manage workspace → Usage, the `everyapp_workspace_app_cap` and `everyapp_workspace_cap_default` tools, or `everyapp workspace app cap` and `everyapp workspace cap default` from the terminal), the Gateway or the CLI creates one built-in subscription if the organization doesn't have it yet: name "Cap alerts", sink `email`, recipients `admins`, events `cap.warning` and `cap.reached`, `builtin` `cap_alerts`. So owners and admins get an email at 80% of a cap and at the cap, by default. Turning it off is disabling it (the Events tab's switch, or `events disable <id>`). Removing it disables it instead of deleting it, so it is never recreated behind the person's back. The CLI writes the cap straight into D1 and makes the same row, and queues `cap.raised`, in the cap's own batch. For Slack as well, add a webhook for `cap.*`.

## The catalogue

Every type the Gateway emits, its version and its `data`. The list is `EVENT_TYPES` in `@every-app/sdk/internal`; the `data` builders and the summary line are `apps/every-app-gateway/src/server/events/catalogue.ts` (`catalogue`, `summarize`), and the summaries below are examples of the one line each type carries. Ids are never alone where a name exists. `everyapp events types` prints the same list. A field marked `?` is left out when it has no value (never `null`, except where a type says so).

### Members

| Type                          | v   | Summary                                        | `data`                                                                                          |
| ----------------------------- | --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `member.invited`              | 1   | "Ada invited jo@acme.com as member"            | `{ invitation: { id, email, role, expiresAt }, emailSent: boolean }`; never the invitation link |
| `member.joined`               | 1   | "jo@acme.com joined as member"                 | `{ user, role, via: "invitation" \| "access" \| "sign_in" \| "setup" \| "member_add" }`         |
| `member.role_changed`         | 1   | "jo@acme.com is now admin"                     | `{ user, role, previousRole }`                                                                  |
| `member.deactivated`          | 1   | "jo@acme.com was deactivated"                  | `{ user, reason?: string }`                                                                     |
| `member.reactivated`          | 1   | "jo@acme.com was reactivated"                  | `{ user }`                                                                                      |
| `member.removed`              | 1   | "jo@acme.com was removed"                      | `{ user, accountDeleted: boolean }`                                                             |
| `member.password_reset`       | 1   | "jo@acme.com reset their password"             | `{ user, by: "self" \| "admin_link" \| "admin_email" }`; never the reset link                   |
| `member.invitation_cancelled` | 1   | "Ada cancelled the invitation for jo@acme.com" | `{ invitation: { id, email, role } }`; never the link                                           |

`via` says how the person joined: an accepted invitation, Cloudflare Access auto-join, the setup claim (the first owner), or an admin adding them directly. A `reason` on `member.deactivated` is a code such as `deleted_with_access_auto_join` (deleting a user while Access auto-join would let them straight back in deactivates them instead). `member.password_reset` fires when a reset completes (Better Auth's `onPasswordReset`), to every organization the person belongs to; `by` is `admin_link` or `admin_email` when an admin started it within the link's hour, else `self`.

The Gateway's pages and its MCP tools emit the `member.*` types, and so do the CLI's `everyapp workspace` commands (`invite`, `uninvite`, `role`, `deactivate`, `reactivate`, `remove`), queued in the D1 batch that writes the row with `actor.kind` `operator`. `member.invitation_cancelled` is Admin → Users → Cancel, `everyapp workspace uninvite` and the `everyapp_workspace_uninvite` tool.

### Workspace

| Type                   | v   | Summary                                  | `data`                   |
| ---------------------- | --- | ---------------------------------------- | ------------------------ |
| `organization.renamed` | 1   | "Ada renamed the workspace to Acme Corp" | `{ name, previousName }` |

From Manage workspace → Rename, `everyapp workspace rename` and the `everyapp_workspace_rename` tool; the slug stays, so the event carries the names only.

### Apps

| Type                   | v   | Summary                                       | `data`                                                                                                                                                                                                              |
| ---------------------- | --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.installed`        | 1   | "crm was installed"                           | `{ app, version?: string, hostname?: string, scope: "org" \| "shared", source: "cli" \| "browser" \| "release" }`                                                                                                   |
| `app.updated`          | 1   | "crm was redeployed (version 5f0c…)"          | `{ app, version?: string, previousVersion?: string }`                                                                                                                                                               |
| `app.live`             | 1   | "crm is live"                                 | `{ app, version?: string, trigger: "request" \| "list" \| "scheduled" }`: what made the Gateway probe the app's Worker and mark it active                                                                           |
| `app.removed`          | 1   | "crm was removed"                             | `{ app, purged: boolean }`                                                                                                                                                                                          |
| `app.needs_setup`      | 1   | "crm needs setup: OPENROUTER_API_KEY"         | `{ app, unmet: string[] }`: setting names only, never values                                                                                                                                                        |
| `app.ready`            | 1   | "crm is ready"                                | `{ app }`                                                                                                                                                                                                           |
| `app.paused_cap`       | 1   | "crm is paused: monthly cap of 1,000 reached" | `{ app, kind: "calls", cap, calls, month, source: "app" \| "default" }`, or for the dollar cap `{ app, kind: "cost", costCap, cost, calls, month, source }` ("crm is paused: monthly dollar cap of $20.00 reached") |
| `app.tools_changed`    | 1   | "crm's tools changed: 12 tools (was 11)"      | `{ app, kind: "app" \| "builtin" \| "remote", toolCount, previousToolCount, added: string[], removed: string[] }`: names only, 50 each at most                                                                      |
| `app.renamed`          | 1   | "Old CRM was renamed to CRM"                  | `{ app, previousName?, description? }`: the name after is `app.name`; `previousName` when it changed, `description` when it did                                                                                     |
| `app.settings_changed` | 1   | "crm's settings set: OPENROUTER_API_KEY"      | `{ app: EventApp \| null, settings: string[], action: "set" \| "unset", target: "gateway" \| "app" }`: setting names only, never a value; `app` is null for a Gateway setting set outside any app                   |
| `app.access_changed`   | 1   | "crm's access changed: 2 granted, 1 revoked"  | `{ app, granted: user[], revoked: user[], grantedCount, revokedCount, everyone?: boolean }`: the first 50 each way, the counts exact; `everyone` when "Available to everyone" was switched                          |
| `app.email_changed`    | 1   | "crm's email changed: 1 sender, 1 inbound"    | `{ app, senders: string[], inbound: string[] }`: the address names as stored now, never a mail                                                                                                                      |

The upload record is the event, from the CLI and the Gateway's deploy paths alike: `app.installed` fires on the first recorded upload of a `pending` registry row (a new app, or a removed one coming back), so a registration whose first build or upload fails announces nothing; `app.updated` fires on a later upload that records a new version. `version` and `previousVersion` are Worker version ids (`apps.version_id`), not a version the app declares. `app.live` fires once per deploy that goes through `binding`, when the Gateway first reaches the app's Worker over its service binding and marks the row `active` (`activateApp`, `apps/every-app-gateway/src/server/app-activation.ts`), with the gateway as actor and `trigger` saying what made it probe: `request` (a request on the app's host, the CLI's live wait included), `list` (the Gateway's home page or Admin → Apps listing a deploying app) or `scheduled` (the per-minute cron's sweep, what finishes a deploy behind Cloudflare Access). A redeploy of an active app fires `app.updated` alone: its row never leaves `active`. `source` on `app.installed`: `cli` for `everyapp deploy` (and the Gateway's deploy API under a deploy key), `browser` for Admin → Apps → Install app (a release installed there included), `release` for `everyapp install <url>`. `app.removed` comes from `everyapp delete` (`purged` is `--purge`: the Worker and its data went too) and from removing the app in Admin → Apps (`purged` false). `app.needs_setup` and `app.ready` fire on a transition of the app's setup state (`apps.setup_state`: `ready`, `needs_setup`, or null before the first evaluation), wherever the Gateway or the CLI evaluates it (opening the app, `configure`, `secret set|unset`, `deploy`); the first evaluation emits only `needs_setup`, never `ready`. `app.tools_changed` fires when a catalog sync stores tool names that differ from the previous snapshot, for an app's tools and for MCP apps of both kinds. `app.renamed` is Admin → Apps → Edit, `everyapp workspace app set --name|--description` and the `everyapp_workspace_app_set` tool; `app.access_changed` is the same places' access list and "Available to everyone" (`workspace app access`, `--everyone on|off`), with the people the change granted and revoked; `app.settings_changed` is `everyapp secret set|unset` and `everyapp configure` (the setup dialog runs the latter), naming what was set and whether it went to the Gateway Worker or the app's own; `app.email_changed` is `everyapp email set|unset`. `month` is `YYYY-MM` in UTC; `source` on cap types says whether the cap is the app's own or the organization's default.

### Caps

| Type          | v   | Summary                                           | `data`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cap.warning` | 1   | "crm is at 80% of its monthly cap (800 of 1,000)" | `{ app, kind: "calls", cap, calls, month, threshold: 80, source }`; for the dollar cap `{ app, kind: "cost", costCap, cost, calls, month, threshold: 80, source }` ("crm is at 80% of its monthly dollar cap ($16.00 of $20.00)")                                                                                                                                                                                                                                                                                                       |
| `cap.reached` | 1   | "crm reached its monthly cap (1,000)"             | `{ app, kind: "calls", cap, calls, month, source }`; for the dollar cap `{ app, kind: "cost", costCap, cost, calls, month, source }` ("crm reached its monthly dollar cap ($20.00)")                                                                                                                                                                                                                                                                                                                                                    |
| `cap.raised`  | 1   | "crm's cap raised from 1,000 to 5,000"            | `{ app: EventApp \| null, cap: number \| null, previousCap: number \| null, costCap?: number \| null, previousCostCap?: number \| null, source: "app" \| "default" }`; `cap: null` is no cap; `costCap` and `previousCostCap` (dollars) are there only when the dollar cap changed; `app` is null and `source` is `"default"` when a workspace default is set, raised or removed (#621); a lowered cap or default emits nothing, an app made unlimited under a default counts as a removal, and a cap set under the default is no raise |
| `cap.changed` | 1   | "crm's cap lowered from 1,000 to 500"             | the same fields as `cap.raised` (`costCap` and `previousCostCap` when the dollar cap changed): a cap lowered, set under the default, or an app's own row changed while the caps that bind it stayed                                                                                                                                                                                                                                                                                                                                     |

`kind` says which cap: `calls` (the number of provider calls; `cap` and `calls` as before) or `cost` (dollars of provider-reported cost; `costCap` and `cost` in US dollars with cents, `calls` the month's count beside them). The dollar cap moves only on calls whose provider reports a price (OpenRouter's `usage.cost`, DataForSEO's `cost`). `cap.warning` and `cap.reached` fire once per app, month, kind and cap (their dedupe key, `<type>:<org>:<app row>:<month>:<kind>:<cap>`, the cap in calls or micro-dollars), from the cap check on an app's brokered calls and on an MCP app's tool calls; `app.paused_cap` fires with `cap.reached`. The two kinds are announced each on its own, so an app near both gets two warnings. A raised cap starts over, since its key changes. `cap.raised` fires when the Gateway sets a cap of either kind that is higher than before, new, or removed, not when it is lowered; its summary is "crm's cap set to 5,000" when there was none, "crm's cap was removed (was 1,000)" when it goes, and names the dollar cap when that is what changed ("The default dollar cap raised from $20.00 to $50.00").

`cap.warning` and `cap.reached` fire once per app, month and cap (their dedupe key), from the cap check on an app's brokered calls and on an MCP app's tool calls; `app.paused_cap` fires with `cap.reached`. A raised cap starts over, since its key changes. `cap.raised` fires when the Gateway sets a cap that is higher than before, new, or removed; its summary is "crm's cap set to 5,000" when there was none and "crm's cap was removed (was 1,000)" when it goes. `cap.changed` is its counterpart for every other change a person makes (a lowered cap or default, a cap set under the default), so the two together are every cap write from Admin → Usage, `everyapp workspace app cap`, `cap default` and the cap tools. Both carry `cap` and `previousCap` as the caps that bind the app after and before.

### Groups

| Type                    | v   | Summary                                                 | `data`                                                                  |
| ----------------------- | --- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `group.created`         | 1   | "Ada created the group Sales"                           | `{ group: { id, name }, description? }`                                 |
| `group.updated`         | 1   | "The group Sales was renamed to Sales EMEA"             | `{ group, previousName?, description? }`                                |
| `group.removed`         | 1   | "The group Sales was removed"                           | `{ group }`                                                             |
| `group.members_changed` | 1   | "The group Sales's members changed: 1 added, 0 removed" | `{ group, added: user[], removed: user[], addedCount, removedCount }`   |
| `group.apps_changed`    | 1   | "The group Sales's apps changed: 1 granted, 0 revoked"  | `{ group, granted: app[], revoked: app[], grantedCount, revokedCount }` |

From Admin → Groups, `everyapp workspace group *` and the `everyapp_workspace_group_*` tools. The lists name the first 50 each way; the counts are exact. A write that changes nothing (the same members again) emits nothing.

### The default model provider

| Type                 | v   | Summary                                                                                             | `data`                                                                                                                                                                                                                                                                                          |
| -------------------- | --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.default_changed` | 1   | "The default model provider is now openrouter (anthropic/claude-haiku-5.5) (was the shipped order)" | `{ aiDefault: { provider, model: string \| null } \| null, previous: { provider, model } \| null }`; `null` on either side is the shipped order (OpenRouter → Workers AI → OpenAI → …, the first whose key is set); `model` is the provider's chat model setting, `null` for the catalog's seed |
| `ai.model_changed`   | 1   | "openrouter's default models are now chat anthropic/claude-sonnet-5.5, embeddings the seed"         | `{ provider, models: { chat: string \| null, embeddings: string \| null }, previous: { chat, embeddings } }`; `null` is the catalog's seed                                                                                                                                                      |

`ai.default_changed` fires from Manage workspace → Usage → AI default, `everyapp ai default` and the `everyapp_ai_default` tool when the stored choice changes (never on a write that leaves it as it was). `ai.model_changed` fires from `everyapp ai model` and the `everyapp_ai_model` tool when one provider's model settings change (a choice with a model, `ai default <provider>/<model>`, fires `ai.default_changed` only). Both carry provider ids and model ids only, never a key. See [/docs/agent/ai](/docs/agent/ai).

### Tool calls

| Type           | v   | Summary                                                        | `data`                                                                      |
| -------------- | --- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `tool.blocked` | 1   | "Claude's call to crm_delete_contact was blocked: destructive" | `{ tool, app?, user, client?: { kind, name?, id }, risk?, reason, callId }` |
| `tool.error`   | 1   | "crm_list_contacts failed for Claude: app_error"               | `{ tool, app?, user, client?, risk?, outcome, callId, durationMs }`         |

From the same audit that writes Admin → Activity (`mcp_tool_calls`): `tool.blocked` for a call the Gateway refused, `tool.error` for an allowed call whose outcome wasn't `ok`. `callId` finds the Activity row. `client.kind` is the credential: `oauth`, `pat`, `session`, `access` or `dev`; `client.id` its id. Never the tool's arguments or result.

### Connections and tokens

| Type                 | v   | Summary                                         | `data`                                                                        |
| -------------------- | --- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `connection.created` | 1   | "Ada connected Claude (read & write, all apps)" | `{ connection: { id, clientName, clientDomain?, access, appScope }, user }`   |
| `connection.revoked` | 1   | "Ada's Claude connection was revoked (user)"    | `{ connection: { id, clientName }, user, reason }`                            |
| `token.created`      | 1   | "Ada created the token ci-deploy"               | `{ id, name, scopes, appId?, expiresAt?, user }`; never the value or its hash |
| `token.revoked`      | 1   | "Ada revoked the token ci-deploy"               | `{ id, name, user }`                                                          |

`connection.revoked`'s `reason`: `user` (the person revoked it), `operator` (`everyapp workspace connections revoke`), `superseded` (a new consent replaced it), `expired` (idle too long), `ended` or `failed` (its grant ended or its authorization failed), `member_removed` or `user_deactivated`. `token.revoked` comes from the person's own Settings → Tokens and from `everyapp workspace tokens revoke`; from the CLI the operator is the `actor` and the token's owner stays `user`, so the log says who revoked whose. The token types are flat: `id` and `name` are the token's, and no key is named `token`, since the credential-key rule (below) refuses that name in every event's `data`, the Gateway's own included.

### Access

| Type             | v   | Summary                           | `data`                                                                    |
| ---------------- | --- | --------------------------------- | ------------------------------------------------------------------------- |
| `access.changed` | 1   | "Cloudflare Access was turned on" | `{ access: "on" \| "off", teamDomain?: string, emailDomains?: string[] }` |

From `everyapp access on` and `access off` ([/docs/agent/access](/docs/agent/access)), queued with the record of the Gateway settings it wrote, to the install organization.

### Sign-in providers

| Type                      | v   | Summary                      | `data`                                    |
| ------------------------- | --- | ---------------------------- | ----------------------------------------- |
| `signin_provider.added`   | 1   | "Google sign-in was added"   | `{ provider: "google", label: "Google" }` |
| `signin_provider.removed` | 1   | "Google sign-in was removed" | `{ provider: "google", label: "Google" }` |

From `everyapp signin add` and `signin remove` ([/docs/agent/secrets](/docs/agent/secrets), "Sign-in providers"), queued once the Gateway Worker holds the new settings, to the install organization, actor the operator. `added` only when the provider goes on (a rerun that rotates a secret queues nothing), `removed` only when one that was on goes off. `provider` is the catalog id (`google`, `microsoft`, `github`, `apple`, `cloudflare`, `oidc`) and `label` its button's (`SSO` for `oidc`); never a setting's name or value. There is no event per sign-in.

### MCP apps

| Type                   | v   | Summary                                                             | `data`                                                                                                                                         |
| ---------------------- | --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp_app.added`        | 1   | "DataForSEO was added as an MCP app"                                | `{ app, kind: "builtin" \| "remote" }`                                                                                                         |
| `mcp_app.removed`      | 1   | "DataForSEO was removed"                                            | `{ app, kind }`                                                                                                                                |
| `mcp_app.enabled`      | 1   | "DataForSEO is being served again"                                  | `{ app, kind }`                                                                                                                                |
| `mcp_app.disabled`     | 1   | "DataForSEO stopped being served"                                   | `{ app, kind }`                                                                                                                                |
| `mcp_app.updated`      | 1   | "DataForSEO was changed: risk"                                      | `{ app, kind, changed: ("risk" \| "name" \| "description" \| "tools")[], risk? }`: the fields by name; the risk default after, when it changed |
| `mcp_app.tool_changed` | 1   | "DataForSEO's tool delete_row was changed (off) (risk destructive)" | `{ app, kind, tool, risk?, enabled?, cleared? }`: one tool's override after the change; `cleared` when the override went                       |

`added` is a new MCP app (`everyapp mcp on` the first time, or `mcp add <url>` for a remote one); `enabled` and `disabled` are `mcp on` and `mcp off` on an existing one (access is kept while it is off); `removed` is `mcp remove` ([/docs/agent/mcp](/docs/agent/mcp)). They come from the CLI, from Admin → MCP apps and from the `everyapp_mcp_*` tools alike. `mcp_app.updated` and `mcp_app.tool_changed` are the Edit dialog and `everyapp_mcp_update` (a remote app's risk default, name, description or tool list; one tool's risk or on/off override), from the Gateway; the CLI's `everyapp mcp tool` writes the same override and queues `mcp_app.tool_changed` too.

### Providers

| Type                          | v   | Summary                                                              | `data`                                                                          |
| ----------------------------- | --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `provider.added`              | 1   | "Resend was registered"                                              | `{ provider: { id, name, kind? } }`                                             |
| `provider.removed`            | 1   | "Resend was removed"                                                 | `{ provider: { id, name, kind? } }`                                             |
| `provider.updated`            | 1   | "GitHub's OAuth client was replaced"                                 | `{ provider, change: "spec" \| "client" }`                                      |
| `provider.connected`          | 1   | "ben@example.com connected GitHub"                                   | `{ provider, account: { kind, user?, label? }, scopeSets: [...], reconnected }` |
| `provider.disconnected`       | 1   | "ben@example.com's GitHub account was disconnected"                  | `{ provider, account, revoked }`                                                |
| `provider.connection_expired` | 1   | "ben@example.com's GitHub connection expired and needs reconnecting" | `{ provider, account }`, deduped per connection until it is connected again     |

`provider.kind` is `api_key` or `oauth`. `account.kind` is `user` (with `user: { id, email?, name? }`) or `organization` (the workspace's own account, the one background work uses); `label` is how the provider names the account ("ben" at GitHub). `scopeSets` lists the scope set names the connection was asked for, never a token or a scope string. `provider.added` and `provider.removed` are emitted by `everyapp provider add` and `provider remove` (in their D1 batch) and by the provider tools; the OAuth ones by the Gateway-owned flow ([providers](/docs/agent/providers); the design is docs/design/2026-10-oauth-providers.md). Through the `everyapp_provider_add` and `everyapp_provider_remove` tools the agent is the actor.

### Subscriptions

| Type                       | v   | Summary                                  | `data`                                                                                                                         |
| -------------------------- | --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `subscription.created`     | 1   | "Ada added the subscription Slack"       | `{ subscription: { id, name, sink }, events: string[], host?, recipients? }`: the URL's host only, never the secret or the URL |
| `subscription.updated`     | 1   | "The subscription Slack was paused"      | `{ subscription, changed: ("enabled" \| "events" \| "name" \| "description")[], enabled?, events? }`                           |
| `subscription.removed`     | 1   | "The subscription Slack was removed"     | `{ subscription, disabled: boolean }`: `disabled` when a built-in one was turned off instead                                   |
| `subscription.redelivered` | 1   | "Ada redelivered member.joined to Slack" | `{ subscription, delivery: { id, eventId, eventType } }`                                                                       |

The bus's own housekeeping, from Admin → Events, `everyapp events add|remove|enable|disable|redeliver` and the `everyapp_events_*` tools. A catch-all (`*`) subscription does not receive them, so a new hook's first delivery is the event it was made for; name `subscription.*` to get them.

### Test

| Type   | v   | Summary                    | `data`                                    |
| ------ | --- | -------------------------- | ----------------------------------------- |
| `ping` | 1   | "Test event from EveryApp" | `{ subscription: { id, name }, message }` |

Sent by `events test`, **Send test** or the test MCP tool, to that one subscription only, paused or not. `message` is a sentence saying the subscription works; the CLI's says it came from `everyapp events test`.

### Not in the catalogue

On purpose: anything that would carry a secret (an invitation or reset link, a token value, an OAuth code), a tool's arguments or result, an email's body, a provider's response, and sign-ins (a session is the chattiest thing on a Gateway and nobody has asked to wire it). The Gateway's `data` builders are the only writers of a gateway event's `data`, and the same credential-key rule an app's events meet ([below](#the-rules)) is checked on them in tests.

## App events: emit()

An app emits its own events with `emit` from `@every-app/sdk/server`. Nothing is declared in `everyapp.config.ts`: an app that emits is like an app that logs, and the subscriber chooses `app.<id>.*`.

```ts
import { GatewayRefusalError, emit } from "@every-app/sdk/server";

const { id, type } = await emit({
  env,
  // No `for`: the request everyApp() is serving; a cron, a Workflow step or
  // email() runs under withOrganization(organizationId, fn) instead.
  event: "invoice.paid", // delivered as app.<app id>.invoice.paid
  data: { invoiceId: "inv_42", total: 1200 },
});
```

| Option  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`   | The Worker env: the `EVERY_APP_GATEWAY` service binding deployed; `EVERYAPP_DEV` under `everyapp dev`.                                                                                                                                                                                                                                                                                                                              |
| `for`   | Whom the event is for, as for `sendEmail()` ([attribution](/docs/agent/identity#attribution)): left out, the request `everyApp()` is serving (its user becomes the `actor`) or the organization `withOrganization()` named; outside both, `RequestContextError`. Explicitly, the inbound request or `{ background: true, organizationId }`. A shared app's Worker must end up with one or the other (`AttributionError` otherwise). |
| `event` | The app's name for it. The Gateway prefixes `app.<app id>.`, so an app can't emit a Gateway type such as `member.joined`.                                                                                                                                                                                                                                                                                                           |
| `data`  | A JSON object, the event's `data` as delivered.                                                                                                                                                                                                                                                                                                                                                                                     |

It posts `{ event, data }` (`EmitEventRequest`) to the Gateway's `POST /api/events/emit` (`EVENTS_EMIT_PATH`) over the binding (`apps/every-app-gateway/src/server/events/app-emit.ts`), which answers `202` with `{ id, type }` (`EmitEventResult`): the event's `evt_…` id and the delivered type. The rows are written before the answer; deliveries run after it, so a subscriber that is down never slows or fails the app. An env with neither the binding nor `EVERYAPP_DEV` throws `ConfigurationError`. The envelope's `summary` is the app and the event's name (`crm: invoice.paid`); `actor` is `{ kind: "user", id, email, name }` when a signed-in person is behind the call, else `{ kind: "app", id: <app id> }`; `version` is 1. An app that changes a payload's shape incompatibly names a new event (`invoice.paid_v2`).

### The rules

The Gateway checks, and the SDK checks the same way before sending (`appEventNameProblem`, `checkEventData` in `@every-app/sdk/internal`):

- `event`: matches `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` (`APP_EVENT_NAME_PATTERN`): lowercase letters, digits and underscores, in segments joined by dots; at most 64 characters (`APP_EVENT_NAME_MAX`).
- `data`: a JSON object (not an array or a scalar), at most 8 KiB serialized (`APP_EVENT_DATA_MAX_BYTES` = 8,192 bytes), nested at most 8 deep (`EVENT_DATA_MAX_DEPTH`). The Gateway reads at most 16 KiB of the request body before parsing it, and takes a missing or `null` `data` as `{}`.
- No key, at any depth, may read like a credential: `CREDENTIAL_KEY_PATTERN` is `/secret|token|password|passwd|authorization|api[_-]?key|private[_-]?key|credential|cookie|session/i`. So `sessionId`, `apiKey` and `csrfToken` are refused too; rename them (`visitId`). A payload can't carry a credential by accident.
- At most 600 emits per app per hour (`APP_EVENT_RATE_PER_HOUR`), counted in `rate_limit_counters` under `events:emit:<app row>:<hour>`. Emits are not provider calls: not counted in Admin → Usage and not capped by the monthly cap.

### Refusals

A refusal is `{ error, code, message }` with the code in the `x-everyapp-error` header, as for every capability call; the SDK throws it as `GatewayRefusalError` with `status`, `code` and `message`.

| Code                   | Status               | When                                                                                                                               |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `event_name_invalid`   | 400                  | `event` is missing, too long or not the shape above; the message says which                                                        |
| `method_not_allowed`   | 405                  | not a `POST` (the SDK always posts)                                                                                                |
| `event_data_invalid`   | 400                  | the body isn't JSON, or `data` isn't a JSON object, doesn't serialize, or nests deeper than 8                                      |
| `event_data_too_large` | 413                  | `data` is over 8 KiB serialized (the message gives the size), or the request body is over 16 KiB                                   |
| `event_data_refused`   | 400                  | a key reads like a credential; the message names the key                                                                           |
| `event_rate_limited`   | 429                  | the app has emitted 600 events this hour; `Retry-After` says when to try again                                                     |
| `caller_*`             | 401/403              | the attribution refusals every Gateway call can get (a shared app that named no organization, an app not registered or not active) |
| `event_emit_failed`    | the Gateway's status | SDK-side: the Gateway answered a non-2xx without a refusal (no `x-everyapp-error` header); the message gives the status            |

### In development

Under `everyapp dev` there is no binding and no bus. `emit()` checks the name and data the same way, so a refusal in dev is the one production gives, prints `[everyapp dev] event app.<id>.<name> (not delivered: no Gateway)` and returns `{ id: "dev-…", type }`. Nothing is delivered. The starter emits `todo.completed` when a todo is marked done.

## everyapp events

A top-level command group, like `email`, `access` and `mcp`. It writes straight into the Gateway's D1 under the Cloudflare login, with the same checks the Gateway's services make (`packages/cli/src/lib/gateway/events.ts`, the commands in `packages/cli/src/commands/events/`); the Gateway reads a new or changed subscription on the next event, with no cache, and the CLI never calls a receiver itself. Every command but `events types` takes `--org <slug|id|name>` for the organization (the install organization by default), `--gateway`, `--account-id`, `--json` and `--verbose` like the other Gateway commands; `events types` takes only `--json` and `--verbose` and needs no Gateway. The exact text of each is `pnpm everyapp events <command> --help` and [the CLI reference](/docs/agent/cli). On a Gateway whose D1 predates events (no `events` table, migration `0012_events.sql`), every command but `types` refuses with [`GATEWAY_OUTDATED`](/docs/agent/errors#gateway_outdated) (run `pnpm everyapp update`), and other commands' event inserts are skipped silently.

| Command                                                                                      | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `events add <url> [--events <types>]… [--name <text>] [--secret \| --secret-from-env <VAR>]` | Adds a webhook subscription. `--events` is a comma list of types and patterns, and may be repeated; none means everything (`*`). `--name` defaults to the URL's host. Without `--secret` the CLI generates a secret and prints it once (`data.secret` under `--json`, never in a message; `data.secretGenerated`). `--secret` reads one from a hidden prompt at a terminal, or from what is piped in; `--secret-from-env <VAR>` reads it from a variable. A value typed after `--secret` is refused unshown (`VALUE_ON_COMMAND_LINE`). Everything typed is checked before anything connects, the URL against the [target rules](#targets) before the secret is asked for. Refuses the 26th subscription and an unknown type. `data.next` names `events test <id>`. |
| `events add --email owners\|admins [--events <types>]… [--name <text>]`                      | Adds an email subscription: no URL, no secret (`--secret` with `--email` is `EVENT_SINK_CONFLICT`). `--name` defaults to "Email owners and admins" (or "Email owners"). Warns `EVENT_EMAIL_NOT_CONFIGURED` when the Gateway has no `EMAIL_FROM`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `events list` (alias `ls`)                                                                   | The organization's subscriptions, oldest first: id, name (a built-in one marked), target (a URL's host and path, never its query or secret, or "email → owners and admins" / "email → owners"), events ("everything" for `*`), on or off, the last delivery and its status, failures in a row. `data.subscriptions`, `data.max` (25).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `events remove <id>`                                                                         | Removes one; its delivery log stays for 30 days. A built-in one (Cap alerts) is disabled instead, and the output says so (`data.outcome`: `removed` or `disabled`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `events enable <id>`, `events disable <id>`                                                  | Resume or pause one. A paused subscription gets no deliveries for events that happen while it is paused, and the Gateway drops what is already queued for it (`dead`, `subscription_gone`). Safe to repeat (`data.changed`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `events test <id> [--no-wait]`                                                               | Queues a `ping` to that subscription (the event and its one delivery, due now) and waits up to 90 seconds, looking every 3, for the per-minute sweep to send it; then reports delivered (with the receiver's HTTP status, or how many were mailed) or failed (with the code or the start of the answer), and a failed one retries like any delivery. `--no-wait` returns once it is queued (`data.outcome`: `queued`, `delivered` or `failed`). Refuses a paused subscription (`EVENT_SUBSCRIPTION_DISABLED`; the Gateway's **Send test** reaches a paused one).                                                                                                                                                                                                   |
| `events deliveries [<subscription id>] [--dead] [--limit <n>]`                               | The latest deliveries (30 days), newest first, of one subscription or all: when, delivery id, event type, subscription, state (queued, sending, delivered, failed and retrying, dead), tries, next attempt, last error. `--dead` shows dead ones only; `--limit` is 1 to 200 (default 20).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `events redeliver <delivery id>`                                                             | Takes a pending or dead delivery back to pending, due now, its attempts reset to 0, so it gets the whole schedule again; the sweep sends it within a minute. A delivered one is left alone, as is one being sent right now (`data.outcome`: `queued`, `delivered` or `attempting`). Refuses one whose subscription was removed or is paused.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `events types`                                                                               | Prints the catalogue (type, version, description) and how patterns read, for `--events`. Takes only `--json` and `--verbose`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The flags, together: `--events`, `--name`, `--secret`, `--secret-from-env`, `--email`, `--no-wait`, `--dead`, `--limit`, `--org`, `--gateway`, `--account-id`, `--json`, `--verbose`. Quote patterns in a shell (`--events 'cap.*,member.*'`), or the shell may expand the `*`.

Driving it as an agent: never invent a secret for the person and never put one on the command line; leave `--secret` out to have one generated, and hand `data.secret` to the person once, for their receiver. It is not shown again by any surface. To give a secret the receiver already has, pipe it in (`printf %s "$SECRET" | pnpm everyapp events add <url> --secret --json`) or name its variable with `--secret-from-env`.

### Error codes

The codes `everyapp events` raises; each has its entry on [the error codes page](/docs/agent/errors).

| Code                           | Means                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENT_TARGET_REFUSED`         | The URL breaks a [target rule](#targets); the message names the rule.                                                                                                                               |
| `EVENT_SUBSCRIPTIONS_LIMIT`    | The organization already has 25 subscriptions (`EVENT_SUBSCRIPTIONS_MAX`), built-in and paused ones included; remove one first.                                                                     |
| `EVENT_SUBSCRIPTION_NOT_FOUND` | No subscription with that id in this organization; `events list` shows the ids. From `events redeliver`, the delivery's subscription was removed.                                                   |
| `EVENT_SUBSCRIPTION_DISABLED`  | `events test` or `events redeliver` on a paused subscription, whose queued deliveries the Gateway drops; `events enable <id>` first.                                                                |
| `EVENT_DELIVERY_NOT_FOUND`     | No delivery with that id in this organization in the last 30 days; `events deliveries` shows the ids.                                                                                               |
| `EVENT_TYPE_UNKNOWN`           | An `--events` entry is neither a type nor a pattern that matches one; `events types` lists them. Every refused entry is named.                                                                      |
| `EVENT_SECRET_INVALID`         | The given secret is shorter than 16 or longer than 128 characters, or isn't printable ASCII without spaces.                                                                                         |
| `EVENT_SINK_CONFLICT`          | Both a URL and `--email` were given, `--secret` came with `--email`, or neither a URL nor `--email` was given.                                                                                      |
| `EVENT_TEST_TIMEOUT`           | `events test` waited 90 seconds and the ping hadn't settled; it stays queued, and `events deliveries <id>` shows it later. The Gateway's per-minute trigger may be missing: `pnpm everyapp update`. |
| `VALUE_ON_COMMAND_LINE`        | A value was typed after `--secret`; rotate it if it was real.                                                                                                                                       |
| `SECRET_VALUE_REQUIRED`        | `--secret` with no terminal and nothing piped in.                                                                                                                                                   |
| `SECRET_EMPTY`                 | The variable `--secret-from-env` names is empty or unset.                                                                                                                                           |
| `ORGANIZATION_NOT_FOUND`       | `--org` names no organization (or, without it, the Gateway has none yet).                                                                                                                           |
| `ORG_AMBIGUOUS`                | `--org` gave a name two organizations share; give the slug or id.                                                                                                                                   |
| `GATEWAY_OUTDATED`             | The Gateway's D1 has no event tables yet; `pnpm everyapp update`.                                                                                                                                   |

And one warning: `EVENT_EMAIL_NOT_CONFIGURED`, from `events add --email` on a Gateway without `EMAIL_FROM` (the subscription is added; its deliveries are `dead` with `email_not_configured` until a sender is set).

## The admin MCP tools

Not on `/mcp` yet: once the twins PR lands, the Gateway connector's `everyapp` tools gain the same operations as seven workspace tools on #614's seam, for owners and admins, through the same services as the Events tab (`apps/every-app-gateway/src/server/events/subscriptions.ts`). Each call is an audited tool call under `appId: "everyapp"`; writes need a connection with write access. The names are fixed; the inputs below are the plan, and the tools' own descriptions on `/mcp` are the authority once they ship.

| Tool                                  | Role and kind              | Input                                                                           |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `everyapp_workspace_events`           | admin, read                | `{}`; answers the subscriptions with their last delivery                        |
| `everyapp_workspace_events_add`       | admin, write               | `{ url?, email?: "owners" \| "admins", events?: string[], name?, secret? }`     |
| `everyapp_workspace_events_remove`    | admin, write, irreversible | `{ subscription, confirm: true }`                                               |
| `everyapp_workspace_events_set`       | admin, write               | `{ subscription, enabled?, events?, name? }`                                    |
| `everyapp_workspace_events_test`      | admin, write               | `{ subscription }`; answers the delivery after the first attempt, paused or not |
| `everyapp_workspace_event_deliveries` | admin, read                | `{ subscription?, dead?: boolean, limit? }`                                     |
| `everyapp_workspace_event_redeliver`  | admin, write               | `{ delivery }`                                                                  |

When `url` is given without `secret`, `everyapp_workspace_events_add` generates one and returns it once in the result. It is the one credential a workspace tool returns, and only one it just made for a target the caller chose; no tool returns a credential that opens the Gateway.

## Audit log

The `events` table is also the workspace's audit log: every event the Gateway recorded for the organization, read back newest first as a trail, kept 90 days (`AUDIT_RETENTION_DAYS`, `packages/sdk/src/internal/events.ts`; the deliveries go after 30). Three surfaces read it, through the same rows and the same shaping (`packages/sdk/src/internal/audit.ts`; the Gateway's `apps/every-app-gateway/src/server/events/audit.ts` over `EventRepository.listForAudit`):

- **Admin → Activity → Audit** (`/admin/activity?view=audit`; the toggle beside the heading, the tool calls stay the default view): server functions `listAuditEvents` and `listAuditActors` in `apps/every-app-gateway/src/serverFunctions/audit.ts`, behind `organizationAdminMiddleware`. Columns When, Who, What (the type in plain words and the catalogue's summary), Subject; filters Who (whom the trail names), Type (grouped by the catalogue's groups, or `*`), and the range the tool calls use; **Load more** pages by cursor at 50.
- `pnpm everyapp workspace audit [--actor <who>] [--type <type>] [--since <time>] [--limit <n>] [--before <cursor>] [--json]` ([workspace](/docs/agent/workspace)): the same rows from D1 under the operator's login (`packages/cli/src/lib/gateway/workspace.ts`, `audit`). The CLI has no catalogue, so it prints the type's label and the subject, not the summary line. Refused on a Gateway from before migration `0015_audit_actor` ([`GATEWAY_OUTDATED`](/docs/agent/errors#gateway_outdated)).
- `everyapp_workspace_audit` on `/mcp` ([mcp](/docs/agent/mcp)): `{ actor?, type?, since?, limit?, before? }`, admin, read; the row shape of the UI (`id`, `time`, `type`, `label`, `summary`, `actor { kind, id, email, name }`, `subject`, `appEvent`) and `nextBefore`.

Each row: `time`; `type`; `label`, the type in plain words (the catalogue's description; `App event: <name>` for an app's own `app.<id>.<name>`); `summary`, the catalogue's one line (the Gateway surfaces only); `actor`, the stored actor with a member's current name and email from `users` (`kind` `user`, `agent`, `operator`, `app` or `gateway`; the UI shows a person by name, `agent · <AI app>`, `CLI · <operator>`, `app · <id>`, `Gateway`); `subject`, what it was about, picked from the data by the catalogue's keys (app, user, group, provider, MCP app, subscription, invitation, setting _names_, tool, client, token name); never the event's `data`. `ping` and `tool.*` rows stay out unless `type` names them (`tool.*`, `*`): Admin → Activity's default view lists every tool call. The filter by actor runs on the `actor_kind` and `actor_id` columns migration `0015_audit_actor` added and backfilled from the JSON (index `(organization_id, actor_id, time)`); a row an older CLI wrote without them still reads by its JSON. Owners and admins only; a member gets `UNAUTHORIZED` from the server function and does not see the tool.

## Limits

| Limit                                | Value                                                         | Constant                                                     |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Subscriptions per organization       | 25                                                            | `EVENT_SUBSCRIPTIONS_MAX`                                    |
| Subscription name                    | 100 characters                                                | `EVENT_SUBSCRIPTION_NAME_MAX`                                |
| Webhook URL                          | 2,048 characters                                              | `EVENT_URL_MAX_LENGTH`                                       |
| Signing secret                       | 16 to 128 characters                                          | `EVENT_SECRET_MIN_LENGTH`, `EVENT_SECRET_MAX_LENGTH`         |
| An event's `data`                    | 16 KiB serialized                                             | `EVENT_DATA_MAX_BYTES`                                       |
| An app's event `data`                | 8 KiB serialized, 8 levels deep                               | `APP_EVENT_DATA_MAX_BYTES`, `EVENT_DATA_MAX_DEPTH`           |
| An app's event name                  | 64 characters                                                 | `APP_EVENT_NAME_MAX`                                         |
| App emits                            | 600 per app per hour                                          | `APP_EVENT_RATE_PER_HOUR`                                    |
| An app's emit request body           | 16 KiB, read before parsing                                   |                                                              |
| Delivery timeout                     | 10 seconds                                                    | `EVENT_DELIVERY_TIMEOUT_MS`                                  |
| Attempts                             | 7, over about 35 hours                                        | `EVENT_DELIVERY_MAX_ATTEMPTS`                                |
| Signature tolerance (the receiver's) | 300 seconds                                                   | `EVENT_SIGNATURE_TOLERANCE_SECONDS`                          |
| Answer read on failure, kept         | 1 KiB, 200 characters                                         | `EVENT_RESPONSE_READ_MAX_BYTES`, `EVENT_RESPONSE_KEEP_CHARS` |
| Deliveries kept                      | 30 days                                                       | `EVENT_RETENTION_DAYS`                                       |
| Events kept (the audit log)          | 90 days                                                       | `AUDIT_RETENTION_DAYS`                                       |
| `workspace audit --limit`            | 1 to 200, default 50                                          | `AUDIT_PAGE_MAX`                                             |
| Event email                          | 50 per address, 2,000 per Gateway a day (hosted 20 and 2,000) |                                                              |
| `events deliveries --limit`          | 1 to 200, default 20                                          |                                                              |
| `events test` wait                   | 90 seconds                                                    |                                                              |

Deliveries are not provider calls: not counted in Admin → Usage, not capped.

## Security

- **Nothing secret in an event.** No credential, invitation or reset link, token value or hash, OAuth code, tool argument or result, mail body or provider response. The catalogue's builders are the only writers of a Gateway event's `data`; a credential-named key is refused in an app's event and checked against the Gateway's own in tests. A delivery's payload ("Show payload" in the Deliveries sheet) holds nothing secret by construction.
- **Signed with a timestamp.** Every webhook delivery carries `X-EveryApp-Signature`; a webhook subscription without a secret can't exist. The secret protects the receiver against forged deliveries, not the Gateway.
- **The secret is shown once.** A generated secret is returned once (the CLI's output, the Add dialog's reveal, the MCP tool's result) and never listed again by any surface. It is stored as written in the Gateway's D1, which the operator's Cloudflare login can read like everything else there; wrapping it with a Gateway-held key is a later step.
- **Targets.** `https:`, a public hostname, not the Gateway's or an app's host, no redirect followed, 10-second timeout, at most 1 KiB of the answer read, checked at add and on every attempt. `EVENTS_ALLOW_PRIVATE_TARGETS` lets through `http:`, IP literals and private names, never the Gateway's own hosts.
- **Organization-scoped and admin-only.** Subscriptions, events and deliveries are read and written under the acting organization only: an admin of one can't list, test or redeliver another's, and the CLI's statements carry the organization id. Members and read-only agent connections get nothing.
- **The email sink mails members only**: the organization's live owners and admins, each once per delivery, from the Gateway's sender, within the `notice` budgets. It takes no address, and logs name a recipient by an HMAC of the address.
- **Logs.** The Gateway logs delivery outcomes by id and code, never a body, a secret or an address.

The invariants (`events.no-secrets-no-tool-io`, `events.signed-with-timestamp`, `events.target-rules`, `events.no-redirect-pinned-url`, `events.org-scoped`, `events.admin-only`, `events.app-emit-attributed-and-bounded`, `events.email-sink-members-only`, `events.retention`, `events.secret-shown-once`) are the threat model's boundary B9, with `events.emit-route-attributed-like-a-capability` in B4, once the threat-model PR (#647) lands ([/docs/agent/repo/threat-model](/docs/agent/repo/threat-model)).

## Open decisions

From `docs/design/2026-10-events-out.md`, "Defaults for Ben", taken without him and listed in `TODO.md` ("Events out (2026-10-25)"):

- The scheduler is D1 plus a per-minute cron, not a Durable Object or a Queue; a per-subscription Durable Object with alarms is the upgrade path, with the same tables.
- The signing secret is stored as written in D1.
- Cap alerts are a built-in email subscription created with the first cap, on by default.
- 30 days of retention (since the audit log of 2026-10-25: 30 for deliveries, 90 for the events themselves), 25 subscriptions per organization, 600 app emits an hour, 8 KiB per app event, seven attempts over about 35 hours.
- Apps declare nothing to emit; an `events` list in `everyapp.config.ts` the UI could show is the walk-back.
- `everyapp events` is a top-level group, not `workspace events`.
- Targets are `https:` to a public hostname; `EVENTS_ALLOW_PRIVATE_TARGETS` is the self-hosted escape.
- The envelope carries a top-level `summary`, for receivers that map only top-level strings.
- No event for sign-ins.
- `everyapp_workspace_events_add` returns a freshly generated secret once, the one credential a workspace tool returns, because it opens nothing on the Gateway.

## Sources

`packages/sdk/src/internal/events.ts`
`apps/every-app-gateway/src/db/events.schema.ts`
`apps/every-app-gateway/drizzle/0012_events.sql`
`apps/every-app-gateway/src/server/events/catalogue.ts`
`apps/every-app-gateway/src/server/events/bus.ts`
`apps/every-app-gateway/src/server/events/deliver.ts`
`apps/every-app-gateway/src/server/events/signing.ts`
`apps/every-app-gateway/src/server/events/target.ts`
`apps/every-app-gateway/src/server/events/subscriptions.ts`
`apps/every-app-gateway/src/server/events/email-sink.ts`
`apps/every-app-gateway/src/server/events/app-emit.ts`
`apps/every-app-gateway/src/serverFunctions/events.ts`
`packages/sdk/src/server/emit.ts`
`packages/cli/src/lib/gateway/events.ts`
`packages/cli/src/lib/gateway/eventTarget.ts`
`packages/cli/src/commands/events/command.ts`
`docs/design/2026-10-events-out.md`
