---
title: "Email: senders, inbound and the email capability"
description: How an app sends mail through the Gateway with sendEmail(), receives mail at addresses routed to its email() handler, what everyapp email set, unset and show configure on an installation, and what the operator sets up once.
---

## The model

The Gateway holds the mail provider and the default sender. An app gets no `send_email` binding of its own (the deploy policy's allowlist of binding types, `ALLOWED_BINDINGS` in `packages/cli/src/lib/app/policy.ts`, leaves out the account-wide capabilities the Gateway brokers, email among them; a binding of another type is refused with "`<name>` is a `<type>` binding, which Every App apps can't use"); it lists `capabilities.email` in `everyapp.config.ts` and calls `sendEmail()` from `@every-app/sdk/server`, which posts the message to the Gateway's `POST /api/integrations/email/send` over the `EVERY_APP_GATEWAY` service binding. The Gateway checks the message, the sender and its daily budgets, sends it with its provider (Cloudflare Email Sending or Resend), and logs it.

Two lists are per installation, never in the manifest, so a release carries the declarations only and whoever installs it inherits no one's domain (`packages/cli/src/commands/email/index.ts`):

| List    | Set with                       | Stored on the Gateway             | Means                                                                                   |
| ------- | ------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------- |
| senders | `everyapp email set --sender`  | `apps.email_senders` (JSON array) | the `from` patterns the Gateway accepts from this app; empty: the Gateway's sender only |
| inbound | `everyapp email set --inbound` | `apps.email_inbound` (JSON array) | the addresses Email Routing delivers to the app's Worker; empty: none                   |

The manifest declares what the app does:

- `capabilities: { email: { access: "write" } }` says the app sends (`emailDeclarations(manifest).sends` is `capabilities.email.access === "write"`).
- `email: { inbound: true }` says its Worker exports an `email()` handler (`emailDeclarations(manifest).receives` is `email.inbound === true`).

`everyapp email set` writes the app's registry row and makes or removes Email Routing rules at once. Nothing is built or deployed. The Gateway caches an app's row with its caller for 30 seconds (`CALLER_CACHE_HIT_TTL_MS = 30_000` in `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`), so a changed sender list applies within that; the CLI says "The Gateway picks up the change within 30 seconds." and "on the Gateway", never "live".

`everyapp email show` prints the two lists against what the manifest declares and what the Gateway's ledger records as routed.

## Operator setup

The full procedure is the runbook [`docs/runbooks/email-sending-setup.md`](/docs/agent/repo/runbooks/email-sending-setup); the capability's contract is in [`docs/capabilities.md`, "Gateway services: email"](/docs/agent/repo/capabilities). Step by step for an agent: `packages/cli/skills/everyapp/setup/email.md`, in an app `.claude/skills/everyapp/setup/email.md`. The person's steps (onboard the domain in the dashboard, then `pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME`) are [/docs/people, "Send email"](/docs/people#send-email). In short:

1. **Set up the sending domain with one provider.** Cloudflare Email Sending: onboard the domain in the Gateway's Cloudflare account, `cf email-sending subdomains create -z <domain> --name <domain>` (or Compute & AI, Email Service, Email Sending, Onboard Domain in the dashboard); the zone must be on Cloudflare DNS in that account. Sending to arbitrary recipients with Cloudflare needs the Workers Paid plan, and a new account starts with a small daily quota that Cloudflare raises over time; when it runs out the Gateway answers `email_provider_limited` (429). Resend: add the domain at `https://resend.com/domains`, publish the DNS records it lists until it shows Verified, create an API key with sending access.
2. **Set the sender**, from any directory (the names are Gateway settings): `pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME`. `EMAIL_FROM` is an address (`noreply@example.com`) or `Name <address>`, and is required; a display name is required too, from `EMAIL_FROM_NAME` or embedded in `EMAIL_FROM` (`EMAIL_FROM_NAME` is optional only then, and wins when both are set). `parseEmailSender()` in `packages/sdk/src/internal/email.ts` returns null unless both an address and a name result, and then the Gateway can't send: `EMAIL_SENDER_NOT_CONFIGURED`, "Email sender is not configured. Set EMAIL_FROM and EMAIL_FROM_NAME." or, when `EMAIL_FROM` is set without a name, `Email sender is not configured. Set EMAIL_FROM and EMAIL_FROM_NAME, or use EMAIL_FROM="Name <email@example.com>".` Readiness is `isEmailConfigured()` in `apps/every-app-gateway/src/server/email/sendEmail.ts`: the sender parses and a provider is selectable (`configuredEmailProvider()`); without it, invitations and password resets hand the admin a link to share instead.
3. **Give the Gateway its transport.** A deployed Gateway Worker already has Cloudflare's `EMAIL` binding (declared in `apps/every-app-gateway/cloudflare.config.ts`). Resend needs `pnpm everyapp secret set RESEND_API_KEY`. A Gateway outside Workers (Docker self-hosting, whose local `EMAIL` binding only writes `.eml` files) uses Email Sending's REST API with `EMAIL_REST_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in its `.env`: `EMAIL_REST_API_TOKEN` is a Cloudflare API token with the **Email Sending** permission, `CLOUDFLARE_ACCOUNT_ID` the account that owns the onboarded sending domain, both required. On a deployed Worker the REST pair takes precedence over the binding, so set `EMAIL_REST_API_TOKEN` there only on purpose. `CLOUDFLARE_ACCOUNT_ID` is an install-owned setting, already set.
4. **Pin the provider when both are set up:** `pnpm everyapp secret set EMAIL_PROVIDER` with `cloudflare` or `resend`; `pnpm everyapp secret unset EMAIL_PROVIDER` returns to the automatic choice.
5. **Onboard every domain an app sends as.** `everyapp email set --sender` does not check that a domain is onboarded; the provider refuses at send time with `email_sender_not_verified` (422). Each sender domain must be onboarded to Email Sending in the Gateway's account, or verified in its Resend account, like the Gateway's own.
6. **For inbound mail**, the address's zone must be on Cloudflare DNS in the Gateway's account, and Email Routing must be on for the domain. Turning it on locks the domain's MX and SPF records to Cloudflare, so the CLI asks at a terminal and otherwise stops; `--enable-email-routing` says yes for the person. By hand: `cf email-routing enable -z <zone> --name <domain>`.
7. **Verify a domain is onboarded.** Cloudflare: `cf email-sending subdomains list -z <domain>` gives the domain's id, `cf email-sending subdomains dns get <id> -z <domain>` the DNS records it expects. Resend: the domain shows Verified.
8. **When a changed setting applies.** A value set with `everyapp secret set` changes the deployed Gateway Worker, which reads each value on its next request. A Docker Gateway reads `.env` at start: restart it after setting the sender or provider values.

### Which provider sends

One provider serves the whole Gateway, its own mail (verification, reset, invitation) and every app's. `chooseEmailProvider()` in `packages/sdk/src/internal/email.ts`, used by `apps/every-app-gateway/src/server/email/providers/index.ts`, picks it per send:

| Setting state                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER` set (trimmed, any case) to `cloudflare` or `resend` | that provider, which must be set up; otherwise the Gateway can't send (`not_configured`), it never falls back: "Email delivery is unavailable: EMAIL_PROVIDER picks Cloudflare Email Sending, which isn't set up on this gateway. Set EMAIL_REST_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or give the Worker its EMAIL binding." or "Email delivery is unavailable: EMAIL_PROVIDER picks Resend, which isn't set up on this gateway. Set RESEND_API_KEY." |
| `EMAIL_PROVIDER` set to anything else                                | `unknown_provider`: "Email delivery is unavailable: EMAIL_PROVIDER is "…", which isn't an email provider. Set it to cloudflare or resend, or unset it."                                                                                                                                                                                                                                                                                               |
| unset                                                                | the first provider in the order `cloudflare`, `resend` whose settings are set: `EMAIL_REST_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`, then `RESEND_API_KEY`                                                                                                                                                                                                                                                                                             |
| unset, no settings                                                   | the `EMAIL` binding (Cloudflare). Every Gateway Worker declares it, so it never outranks a `RESEND_API_KEY` the operator set                                                                                                                                                                                                                                                                                                                          |
| nothing set up                                                       | "Email delivery is unavailable: no email provider is set up. Give the gateway one transport: Cloudflare Email Sending (the EMAIL binding, or EMAIL_REST_API_TOKEN with CLOUDFLARE_ACCOUNT_ID) or Resend (RESEND_API_KEY); EMAIL_PROVIDER picks one when both are set"                                                                                                                                                                                 |

The capability registry (`packages/sdk/src/internal/capabilities.ts`) lists `email` as a `service` capability with `access: ["write"]`, route `send: ["POST"]`, `settings: ["EMAIL_FROM", "EMAIL_FROM_NAME"]` and `optionalSettings: ["EMAIL_REST_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "RESEND_API_KEY", "EMAIL_PROVIDER"]`. `everyapp secret set` accepts all of them but `CLOUDFLARE_ACCOUNT_ID` as Gateway settings (`SETTABLE_GATEWAY_SETTINGS` in `packages/sdk/src/internal/gatewaySettings.ts`).

Provider differences (`apps/every-app-gateway/src/server/email/providers/cloudflare.ts`, `resend.ts`): Cloudflare's REST answer gives `status: "queued"` when any recipient is queued, `delivered` otherwise, and fails when every recipient bounced permanently; the binding always answers `delivered`. Resend always answers `delivered` with Resend's id as `messageId`, generates a text part from HTML when a message has none (Cloudflare doesn't), has no attachment disposition (a `contentId` makes it inline), and sends with `User-Agent: every-app-gateway`.

## Manifest declarations

```ts
// everyapp.config.ts
export default {
  id: "inbox",
  capabilities: {
    email: {
      access: "write",
      why: "Sends replies from the organization's mailboxes.",
    },
  },
  email: { inbound: true },
};
```

- `capabilities.email` takes `access: "write"` only; the Gateway treats the deployed manifest listing it as the grant (`capability_not_requested` otherwise).
- `email.inbound` is a boolean or left out (`packages/perimeter/src/manifest/manifest.ts`, `EmailSchemaStrict`). An address list there, as manifests had before 2026-10-19, is refused by the strict validator: "inbound is true (the Worker exports an email() handler) or left out; the addresses moved out of the manifest: set them with `everyapp email set --inbound <address>` in the app's directory after its first deploy". A `senders` list under `capabilities.email` is refused likewise ("senders moved out of the manifest").
- The Gateway's registry reads a stored manifest's `email.inbound` leniently (`.catch(undefined)`); the CLI's `declaresInbound` counts `true` or an old address array as declared (`packages/cli/src/lib/gateway/registry.ts`), so a row deployed before the move keeps routing until its redeploy.
- A `cloudflare.config.ts` trigger of type `email` is refused by the deploy policy (`packages/cli/src/lib/app/policy.ts`: "it declares a trigger of type "email" (apps may only declare cron schedules)"): cf's own reconciliation of a Worker's addresses would fight the CLI's rules and need no ledger to take an address. The Email Routing rules the CLI makes are the only link.

The fixture `packages/cli/src/test/fixtures/manifests/agentic-inbox.ts` is the inbox's manifest without a `send_email` binding (the Gateway brokers it); its `capabilities.email` and `email: { inbound: true }` are not in the fixture yet (its header says they "come with PR 3"), and its addresses are set with `everyapp email set`.

## everyapp email set

```
pnpm everyapp email set [--sender <pattern>]... [--inbound <address>]... [--enable-email-routing] [--manifest <path>] [--gateway <url>] [--account-id <id>] [--json] [--verbose]
```

Run in the app's directory (its `everyapp.config.ts` names the app), or with `--manifest <path>` to a checkout's `everyapp.config.ts` for an app deployed from a release (`everyapp deploy <url>`). Each flag replaces its whole list; a list not named is kept. Defined in `packages/cli/src/commands/email/command.ts`, run by `setEmail()` in `packages/cli/src/commands/email/index.ts`.

| Flag                     | Value                                      | Meaning                                                                                                                                           |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--sender`               | `*@<domain>` or `<local>@<domain>`, repeat | Address the app may send as; up to 20. Needs `capabilities.email` in the manifest. Refused on a hosted Gateway.                                   |
| `--inbound`              | `*@<apex>` or `<local>@<domain>`, repeat   | Address whose mail goes to the app; up to 50, each at most 90 characters. Needs `email: { inbound: true }`; the domain must be on Cloudflare DNS. |
| `--enable-email-routing` | boolean                                    | Turn on Email Routing for inbound domains that don't route mail yet, without asking (locks their MX and SPF records to Cloudflare).               |
| `--manifest`             | path                                       | Path to `everyapp.config.ts`, if it isn't in this directory.                                                                                      |
| `--gateway`              | URL                                        | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: `EVERYAPP_GATEWAY_URL`).                                      |
| `--account-id`           | id                                         | The Cloudflare account of the Gateway, when your login sees several (default: `CLOUDFLARE_ACCOUNT_ID`).                                           |
| `--json`                 | boolean                                    | NDJSON events on stdout, never prompts (exit 0 done, 1 error, 2 action required).                                                                 |
| `--verbose`              | boolean                                    | Every step and progress line, the output of what everyapp runs, an unexpected error's stack.                                                      |

### Pattern rules

One validator for both lists, `emailListProblems()` in `packages/sdk/src/internal/email.ts` (the Gateway's `senderAllowed()` reads the same patterns):

- A sender matches `EMAIL_SENDER_PATTERN`: `*@<domain>` (any address on exactly that domain, not its subdomains) or `<local>@<domain>`, lowercase. At most `EMAIL_LIMITS.senders` = 20.
- An inbound address matches `EMAIL_INBOUND_PATTERN`: `*@<domain>` (a zone apex's catch-all) or `<local>@<domain>`, lowercase, at most `EMAIL_LIMITS.inboundAddressChars` = 90 characters (Email Routing's limit on a matcher value). At most `EMAIL_LIMITS.inbound` = 50 (Email Routing allows 200 rules a domain).
- No duplicates ("`<value>` is listed twice.").

### What set does, in order

1. No `--sender` and no `--inbound`: `EMAIL_NOTHING_TO_SET`, before the manifest or the network is touched.
2. Each list is validated: `EMAIL_SENDER_INVALID` or `EMAIL_INBOUND_INVALID`, with `data.problems`. One problem is the headline with its rule under it; several are "N problems with --inbound" and a bullet each. When lowercasing alone would fix it, `rerun` is the same command lowercased (`pnpm everyapp email set --sender ben@hi.openseo.so`).
3. The manifest is loaded (`MANIFEST_NOT_FOUND` with "No everyapp.config.ts in this directory", fix "run this from the app's directory, or pass `--manifest <path>`").
4. `--sender` with no `capabilities.email` of access `write`: `EMAIL_NOT_DECLARED`. `--inbound` with no `email: { inbound: true }`: `EMAIL_INBOUND_NOT_DECLARED`. Both carry `rerun: pnpm everyapp deploy`, `rerunNote: "then this command again"`.
5. Connect to the Gateway (cf login, its D1). `--sender` on a Gateway whose install is `deploymentMode: "hosted"`: `EMAIL_SENDERS_HOSTED`.
6. Read the app: `APP_NOT_FOUND` ("`<id>` isn't deployed to this Gateway yet") when no registered row has the id.
7. Take the app's lease (`app:<worker>`, purpose `app.email`; `packages/cli/src/lib/gateway/lease.ts`). A lease lasts `LEASE_TTL_MS` = 3 minutes past its last renewal (renewed every 30 s while its run holds it), so one left by a run that stopped without cleaning up is released within 3 minutes. While another run (a deploy, a secret change, another email change) holds it, the acquire is retried every `RETRY_MS` = 5 s for `WAIT_MS` = 5 minutes, each attempt a `progress` event on step `app.lease`, "Waiting for a deploy of `<id>` to finish (`<deployer>` on `<machine>`, started `<n>` ago)" with `data.holder`; when the deadline passes, `LEASE_HELD` (below). `LEASE_LOST` if the lease, once taken, goes to another run.
8. Read the row's current lists; the next lists are the named ones replaced, the other kept.
9. Deferred when the app's Worker isn't uploaded (`status: "pending"`) or its deployed manifest doesn't declare inbound (`RegisteredAppInfo.declaresInbound`) and the next inbound list isn't empty: no rule is made, the addresses are stored, the deploy that uploads the declaration checks and routes them. An emptied list still removes the routes there are.
10. Otherwise, when `--inbound` was given, `planEmailRoutes()` (`packages/cli/src/lib/app/emailRoutes.ts`) checks everything before any write: the ledger for addresses other apps hold, each domain's zone, catch-alls on an apex only, what rule is on each address now, and whether each domain routes mail, asking "Turn on Email Routing for `<domains>`?" at a terminal when one doesn't (declined: `CANCELLED`, "Cancelled. Nothing changed."). Refusals: `EMAIL_ADDRESS_TAKEN`, `EMAIL_ZONE_NOT_FOUND`, `EMAIL_CATCH_ALL_NOT_APEX`, `EMAIL_CATCH_ALL_TAKEN`, `EMAIL_ROUTING_DISABLED`. A refusal here leaves the row as it was.
11. `lease.check()`, then the row is written (`writeAppEmail()`): a shared app's lists are the platform organization's owners' and admins' to change, `SHARED_APP_FORBIDDEN` otherwise (checked at the write, after the Email Routing confirm).
12. `lease.check()`, then the routes are made from the plan (`applyEmailRoutes()`): Email Routing turned on where agreed (apex before subdomains), each route recorded in the ledger before it is created, created or updated, then the routes the list dropped deleted. A stop here (a rule that can't be made, the lease lost) is `EMAIL_ROUTES_PARTIAL`: the addresses are saved, `everyapp deploy` or the command again finishes from the same row.
13. One `done` event.

### The done event (--json)

```json
{
  "v": 1,
  "ts": "…",
  "type": "done",
  "message": "inbox sends as *@example.com, ceo@example.com. The Gateway picks up the change within 30 seconds.",
  "data": {
    "app": {
      "id": "inbox",
      "workerName": "every-acme-inbox",
      "status": "active"
    },
    "senders": {
      "value": ["*@example.com", "ceo@example.com"],
      "changed": true
    },
    "inbound": { "value": [], "changed": false, "routed": [], "removed": [] },
    "durationMs": 1234
  }
}
```

`data.next` is `["pnpm everyapp deploy"]` when inbound addresses were saved for a deferred app. `data.inbound.routed` lists the addresses routed by this run (the whole plan, adopted rules included), `removed` the addresses whose routes were deleted. `changed` compares the lists as sets, so reordering changes nothing. The human output is a ticked line per change and a dim "Nothing changed. …" line for what was already so; a `display` field carries it in the event only outside `--json`.

Messages, each a sentence in `message`:

| Case                                       | Message                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| senders changed                            | `<id> sends as <list>.`                                                               |
| senders emptied                            | `Senders cleared (sends as the Gateway's sender).`                                    |
| senders unchanged                          | `<id> already sends as <list>.` or `<id> already sends as the Gateway's sender only.` |
| inbound deferred                           | `Saved <list>. It's routed to <id> on the next deploy.`                               |
| inbound routed                             | `Mail to <list> goes to <id>.`                                                        |
| inbound dropped                            | `Stopped routing <list>.`                                                             |
| inbound emptied with nothing to remove     | `Inbound addresses cleared.`                                                          |
| inbound unchanged and every rule as wanted | `Mail to <list> already goes to <id>.` or `<id> already receives no mail.`            |
| a rule remade or mended with the same list | `Mail to <list> goes to <id>.` (not "already")                                        |
| senders changed                            | `The Gateway picks up the change within 30 seconds.` appended                         |

When this run routed addresses (the list changed, or a rule was remade) on a domain no sender covers, the app declares `capabilities.email` and the Gateway isn't hosted, the human output adds "To reply from `<domain>`, set it up for Email Sending, then:" and the full `pnpm everyapp email set --sender '<existing>' --sender '*@<domain>'` command (since `--sender` replaces the list).

### Codes

Every error is an `error` event with `code`, `message`, `retryable`, and `data` carrying `fix`, `rerun`, `rerunNote` and `authorize` when set (`packages/cli/src/lib/output/report.ts`).

| Code                         | When                                                                                                                 | Message / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_NOTHING_TO_SET`       | neither flag given                                                                                                   | "Name what to set: --sender, --inbound, or both"; `rerun: pnpm everyapp email set --help`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `EMAIL_SENDER_INVALID`       | a `--sender` fails the pattern, is uppercase, duplicated, or more than 20                                            | `"<value>" isn't a sender` with the rule under it, `A sender is "*@<domain>" or "<local>@<domain>", in lowercase.`; `data.problems`; `rerun` lowercased when that is all it needs                                                                                                                                                                                                                                                                                                                                           |
| `EMAIL_INBOUND_INVALID`      | an `--inbound` fails the pattern, is uppercase, duplicated, longer than 90 characters, or more than 50               | "At most 50 inbound addresses, not 51." / `"<value>" isn't an inbound address: …` / "`<value>` is longer than Email Routing's 90 characters."                                                                                                                                                                                                                                                                                                                                                                               |
| `MANIFEST_NOT_FOUND`         | no `everyapp.config.ts` here and no `--manifest`                                                                     | "No everyapp.config.ts in this directory"; fix "run this from the app's directory, or pass `--manifest <path>`"                                                                                                                                                                                                                                                                                                                                                                                                             |
| `EMAIL_NOT_DECLARED`         | `--sender` and the manifest doesn't list `capabilities.email` with `access: "write"`                                 | "`<id>` can't send mail yet\neveryapp.config.ts doesn't list email in its capabilities."; fix `add capabilities: { email: { access: "write" } } to everyapp.config.ts`; rerun `pnpm everyapp deploy` "then this command again"                                                                                                                                                                                                                                                                                              |
| `EMAIL_INBOUND_NOT_DECLARED` | `--inbound` and the manifest doesn't declare `email: { inbound: true }`                                              | "`<id>` can't receive mail yet\neveryapp.config.ts doesn't declare email: { inbound: true }."; fix "declare email: { inbound: true } and export email() from the app's Worker"                                                                                                                                                                                                                                                                                                                                              |
| `EMAIL_SENDERS_HOSTED`       | `--sender` on a hosted Gateway (`--inbound` alone is fine)                                                           | "This Gateway doesn't take app senders\nHosted Gateways send all app mail from their own sender for now."                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `APP_NOT_FOUND`              | the app has no registered row (never deployed, or deleted)                                                           | "`<id>` isn't deployed to this Gateway yet"; rerun `pnpm everyapp deploy` "in the app's directory"                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SHARED_APP_FORBIDDEN`       | a shared app and a login that isn't an owner or admin of the platform organization                                   | "Only `<org>` owners and admins can change the email of shared apps\n`<email>` isn't an owner or admin of `<org>`, the platform organization."                                                                                                                                                                                                                                                                                                                                                                              |
| `LEASE_HELD`                 | another run still held the app's lease after 5 minutes of retrying every 5 s                                         | "`<Activity>` is still running after 5m\nIt's from `<deployer>` on `<machine>`. If it stopped without cleaning up, it's released within `<n>`." (`<Activity>` is "A deploy of `<id>`", "An email change on `<id>`", "A secret change on `<id>`"…; "Couldn't take hold of `<id>` after 5m" when no lease row can be read); `retryable: true`; `rerunNote: "once it's done (pnpm everyapp status shows it)"`; `data.holder` the lease row: `id`, `holder`, `purpose`, `acquiredAt`, `expiresAt`, `app`, `deployer`, `machine` |
| `LEASE_LOST`                 | another run took the app's lease before the write                                                                    | nothing changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `EMAIL_ADDRESS_TAKEN`        | the Gateway's ledger records the address for another app's Worker                                                    | "`<address>` already goes to another app (`<id>`)" (no "(`<id>`)" when the holder's Worker has no app row); fix "pick another address, or run pnpm everyapp email unset inbound in `<id>`'s directory first" ("in that app's directory" without an id); `data: { address, workerName, appId }`, `workerName` the holder's, `appId` null without a row                                                                                                                                                                       |
| `EMAIL_ADDRESS_TAKEN`        | an Email Routing rule the app didn't make (not named `everyapp:<worker>`, not in the ledger) is on the address       | "`<address>` already forwards to `<to>`" (or "goes to another Worker", "drops mail", "sends mail to "`<type>`"") + "\nThe Email Routing rule "`<name>`" on `<zone>` delivers it." (the rule's id when it has no name); fix "remove that rule, or pick another address"; `data: { address, zone, ruleId, actions }`                                                                                                                                                                                                          |
| `EMAIL_ADDRESS_TAKEN`        | another app recorded the address in the ledger between this run's plan and its claim (`RESOURCE_OWNED` on the write) | "`<address>` was recorded for another app while this run was routing it"; fix "take another address, or remove it from that app first"; `data: { address }`                                                                                                                                                                                                                                                                                                                                                                 |
| `EMAIL_ZONE_NOT_FOUND`       | no zone in the Gateway's account holds the address's domain                                                          | "`<domain>` isn't on Cloudflare DNS in this account\nEmail Routing needs the domain's zone in the Gateway's Cloudflare account."; fix "add the domain (or its parent) to the account, or pick an address on another domain"; `data: { domain }`                                                                                                                                                                                                                                                                             |
| `EMAIL_CATCH_ALL_NOT_APEX`   | `*@<domain>` where the domain is a subdomain of its zone                                                             | "`<address>`: catch-alls only work on a zone's apex\n`<domain>` is a subdomain of `<zone>`."; fix "list each address instead, e.g. --inbound support@`<domain>`"; `data: { address, zone }`                                                                                                                                                                                                                                                                                                                                 |
| `EMAIL_CATCH_ALL_TAKEN`      | the zone's catch-all is on, does anything but drop, and isn't the app's                                              | "`<zone>`'s catch-all already forwards to `<to>`\n`<address>` would take it over." (or "goes to another Worker", "sends mail to "`<type>`""); fix "set the catch-all back to Drop (Email Routing → Routing rules), or list addresses one by one"; `data: { address, zone, actions }` (the catch-all's actions)                                                                                                                                                                                                              |
| `EMAIL_ROUTING_DISABLED`     | a domain doesn't route mail, no terminal to ask (`--json`, no TTY) and no `--enable-email-routing`                   | "Email Routing is off for `<domains>`\nTurning it on locks the domain's MX and SPF records to Cloudflare. Nothing was changed."; `data.domains`, `data.commands` (`npx cf email-routing enable -z <zone> --name <domain>`); `rerun` is this command with `--enable-email-routing`, `authorize: true`                                                                                                                                                                                                                        |
| `CANCELLED`                  | the Email Routing question answered no                                                                               | "Cancelled. Nothing changed." (exit 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EMAIL_ROUTES_PARTIAL`       | the row was written, then making the routes stopped (cf refused a rule, the lease was lost)                          | "Inbound addresses saved, but routing them stopped part-way\n`<cause>`"; `retryable: true`; `rerunNote: "again, or pnpm everyapp deploy, to finish"`; `data.saved` (the list), `data.cause` (the inner code, e.g. `LEASE_LOST`, or null)                                                                                                                                                                                                                                                                                    |

An `authorize: true` error is a takeover: an agent shows it and asks before running its `rerun`.

## everyapp email unset

```
pnpm everyapp email unset <senders|inbound>... [--manifest <path>] [--gateway <url>] [--account-id <id>] [--json] [--verbose]
```

At least one positional, `senders` or `inbound` (anything else: "Use senders, inbound, or both."). The same pipeline as `set` with the named lists emptied, `hostedCheck` off, so it works on a hosted Gateway and for a declaration the manifest dropped (a list may still need clearing). Clearing inbound addresses deletes their rules and sets a catch-all back to dropping mail (`enabled: false`, `actions: [{ type: "drop" }]`). Nothing is built or deployed.

Done messages: "Stopped routing `<list>`." (with `data.inbound.removed`), "Senders cleared (sends as the Gateway's sender). The Gateway picks up the change within 30 seconds.", or "`<id>` already sends as the Gateway's sender only. `<id>` already receives no mail." when nothing changed (no cf call is made). Codes: `MANIFEST_NOT_FOUND`, `APP_NOT_FOUND`, `SHARED_APP_FORBIDDEN`, `LEASE_HELD`, `LEASE_LOST`, `EMAIL_ROUTES_PARTIAL` (the same meanings as for `set`).

## everyapp email show

```
pnpm everyapp email show [--manifest <path>] [--gateway <url>] [--account-id <id>] [--json] [--verbose]
```

Reads the manifest, the app's row and the Gateway's ledger; it makes no Email Routing call (it doesn't check that a rule still exists; `everyapp status` does). Exit 0 in every case below.

Human output is a table `ADDRESS | ROLE | STATUS`, which `--json` carries verbatim in `message`:

| Role      | Status                  | Means                                                                                                                                       |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `sender`  | `allowed`               | listed, and the manifest declares `capabilities.email`                                                                                      |
| `sender`  | `not declared`          | listed, but the manifest no longer lists `capabilities.email`                                                                               |
| `inbound` | `routed`                | the ledger has an `email-route` row for it with its `resourceId` recorded (`<zone id>/<rule id>`, or `catch_all:<zone id>` for a catch-all) |
| `inbound` | `not routed yet`        | stored, no complete ledger row (a pending app, a deferred set, or a reconcile that stopped)                                                 |
| `inbound` | `not declared`          | stored, but the manifest no longer declares `email: { inbound: true }`; no deploy routes it                                                 |
| `inbound` | `removed, still routed` | the ledger has a route the list no longer names                                                                                             |

Below the table: "`<id>` sends as the Gateway's sender only." when it declares sending with no senders; "everyapp.config.ts no longer declares email: { inbound: true }, so this address isn't used." when addresses are stored under a dropped declaration.

The `done` data:

```json
{
  "app": {
    "id": "inbox",
    "workerName": "every-acme-inbox",
    "status": "active",
    "deployed": true
  },
  "declares": { "sends": true, "receives": true },
  "senders": ["*@example.com", "ceo@example.com"],
  "inbound": ["*@example.com", "support@mail.example.com"],
  "routed": ["*@example.com", "support@mail.example.com"],
  "durationMs": 321
}
```

`data.next`, when there is a next step: `[{ "command": "pnpm everyapp deploy", "note": "route the list as shown" }]` for an address not routed yet or a stale route; `[{ "command": "pnpm everyapp email unset inbound", "note": "clear the stored address" }]` for addresses under a dropped declaration; for empty lists on an app that declares sending or receiving, `{ "command": "pnpm everyapp email set --sender '*@<domain>'", "note": "send as your own domain" }` and `{ "command": "pnpm everyapp email set --inbound <address>", "note": "receive mail" }`.

Other messages: "`<id>` isn't deployed yet. Senders and inbound addresses can be set after its first deploy." with `data: { app: { id, deployed: false }, declares, next: ["pnpm everyapp deploy"] }`; "`<id>` doesn't send or receive email." plus the two declarations to add, when the manifest declares neither; "`<id>` sends as the Gateway's sender and receives no mail." when both lists are empty. `app.deployed` is false for a `pending` app (Worker not uploaded).

## sendEmail()

`packages/sdk/src/server/sendEmail.ts`; exported from `@every-app/sdk/server` (`packages/sdk/src/server/index.ts`) as `sendEmail` with its options type `SendEmailOptions`. Beside it: `AttributionError` and the type `GatewayCallFor` (`attribution.ts`); `GatewayRefusalError`, `gatewayRefusal()` and the types `GatewayRefusal`, `EmailIntegrationStatus` (`integrationFetch.ts`); the message types `SendEmailMessage`, `SendEmailResult`, `EmailAddressInput`, `EmailAttachmentInput` (from `@every-app/sdk/internal`).

```ts
import { GatewayRefusalError, sendEmail } from "@every-app/sdk/server";

const { messageId, status } = await sendEmail({
  env,
  for: request, // or { background: true, organizationId } from a cron, a Workflow or email()
  message: {
    to: "customer@example.net",
    subject: "Your order shipped",
    text: "It's on its way.",
    from: { address: "orders@mail.example.com", name: "Acme" },
  },
});
```

### Options

| Option    | Type                                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`     | the Worker env                                       | Deployed: the `EVERY_APP_GATEWAY` service binding; one present without a `fetch` function throws `ConfigurationError` "EVERY_APP_GATEWAY is configured but is not a valid service binding." Local dev: `EVERYAPP_DEV`, `EVERYAPP_EMAIL_SENDERS`, and optionally `EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `EMAIL_FROM` from `.dev.vars`. Neither binding nor `EVERYAPP_DEV`: `ConfigurationError` "Email is unavailable: deploy with the EVERY_APP_GATEWAY binding (everyapp deploy), or run under everyapp dev."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `for`     | `Request` or `{ background: true, organizationId? }` | Whom the mail is for (`GatewayCallFor`, `packages/sdk/src/server/attribution.ts`): the inbound request forwards its `x-everyapp-identity` header; background work names the organization in the `x-everyapp-org` header. An organization's own app (its Worker has `EVERY_APP_ORG_ID`, the owning organization's id, declared on every build) writes `for: { background: true }`: the Gateway knows its organization, and it may only name its own (`caller_org_mismatch`, 403, otherwise). A shared app's Worker (`EVERYAPP_SHARED` = `"1"`, added when it is installed, which drops `EVERY_APP_ORG_ID`) must pass the request or an `organizationId`, else `checkAttribution()` throws `AttributionError` (`code: "attribution_required"`) before any call: "sendEmail in a shared app's Worker serves every organization, so it must say whom the call is for: for: request, or for: { background: true, organizationId } for work no request started." A malformed `for` throws it in any app: "sendEmail: `for` is the inbound Request or { background: true, organizationId }." and "sendEmail: { background: true, organizationId } needs a non-empty organization id." The Gateway checks a named organization is active with a live member (`caller_org_not_attributable`). The app's own identity headers are never forwarded. |
| `message` | `SendEmailMessage`                                   | Below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Returns `SendEmailResult`: `{ messageId?: string; status: "delivered" | "queued" | "logged" }`. `logged` is local dev only: nothing was sent.

### The message

`SendEmailMessage` in `packages/sdk/src/internal/email.ts`, checked by `parseSendEmailMessage()` on the Gateway and in dev alike, so a refusal in `everyapp dev` is the one production gives. Unknown fields are refused ("Unknown field "reply_to"; a message takes to, cc, bcc, subject, text, html, from, replyTo, headers, attachments."). The body as sent over the binding is at most `EMAIL_LIMITS.bodyBytes` = 5 MiB, attachments included, counted as it streams.

| Field          | Type                            | Rule                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `to`           | address or `string[]`           | at least one; with `cc` and `bcc`, at most `EMAIL_LIMITS.recipients` = 50 recipients                                                                                                                                                                                                                                                                 |
| `cc`, `bcc`    | address or `string[]`           | plain addresses                                                                                                                                                                                                                                                                                                                                      |
| `subject`      | string                          | one line, at most `EMAIL_LIMITS.subjectChars` = 998 characters                                                                                                                                                                                                                                                                                       |
| `text`, `html` | string                          | at least one                                                                                                                                                                                                                                                                                                                                         |
| `from`         | address or `{ address, name? }` | absent: the Gateway's sender (`EMAIL_FROM`, `EMAIL_FROM_NAME`); present: must match one of the installation's senders                                                                                                                                                                                                                                |
| `replyTo`      | address or `{ address, name? }` | absent: replies go to the From (Cloudflare's REST body sets `reply_to` to the From; the binding and Resend set it only when given)                                                                                                                                                                                                                   |
| `headers`      | `Record<string, string>`        | at most `EMAIL_LIMITS.headers` = 20; names `[A-Za-z0-9-]+` of at most 100 bytes; values one line of at most 2,048 bytes; at most 16 KB together; reserved names refused: `From`, `Sender`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Return-Path`, `Date`, `MIME-Version`, `Content-Type`, `Content-Transfer-Encoding`, `DKIM-Signature` (any case) |
| `attachments`  | `EmailAttachmentInput[]`        | at most `EMAIL_LIMITS.attachments` = 32                                                                                                                                                                                                                                                                                                              |

An address is printable ASCII with one `@` and a dotted domain, at most 254 characters, trimmed. A display name is one line of at most 256 characters without control characters; blank names are dropped.

`EmailAttachmentInput`: `filename` (one line, at most 255 characters), `contentType` (a MIME type such as `application/pdf`), `content` (the bytes, base64), `disposition` (`"attachment"`, the default, or `"inline"`), `contentId` (required for `inline`, referenced as `cid:<contentId>` in the HTML; refused for an attachment). Attachments go to every provider as base64.

### Refusals

The Gateway answers a refusal as `{ error, code, message }` with the code also in the `x-everyapp-error` header (`apps/every-app-gateway/src/server/capabilities/refusal.ts`); the SDK turns it into a thrown `GatewayRefusalError` with `status`, `code` and `message`. A non-2xx answer without the header is thrown as `email_send_failed` ("The Every App gateway answered `<status>` to the send."). `handleEmailSend()` in `apps/every-app-gateway/src/server/capabilities/email.ts` checks in this order:

| Code                             | Status                                          | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration_method_not_allowed` | 405                                             | anything but `POST` on `send`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `capability_not_requested`       | 403                                             | the deployed manifest doesn't list `email` with `access: "write"`: "This app doesn't list email in its capabilities. Add capabilities: { email: { access: "write" } } to everyapp.config.ts and deploy again."                                                                                                                                                                                                                                                                                                                                                                        |
| `caller_*`                       | 401/403 (500 for `caller_registry_unavailable`) | the AppGateway entrypoint's attribution (`apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`): 401 `missing_caller_identity`, `caller_identity_invalid`; 403 `caller_not_registered`, `caller_not_active`, `caller_identity_mismatch`, `caller_identity_required` (a shared app's Worker named neither the request's identity nor an organization), `caller_org_not_attributable` (the named organization is unknown, suspended or has no active members), `caller_org_mismatch`; 500 `caller_registry_unavailable` when the app registry or the organization lookup failed |
| `integration_read_only`          | 403                                             | the caller is an agent's MCP connection without `mcp:write` (or `*`): "This agent connection is read-only, and sending email writes. Reconnect the agent with write access."                                                                                                                                                                                                                                                                                                                                                                                                          |
| `email_message_too_large`        | 413                                             | the body passes 5 MiB, by `content-length` or as it streams                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `email_invalid_message`          | 400                                             | the body isn't JSON, or breaks a rule above (the message is the rule, e.g. "A message goes to at most 50 recipients across to, cc and bcc (this one: 51).")                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `email_sender_not_allowed`       | 403                                             | `from` on a hosted Gateway ("This gateway sends app mail from its own sender only for now: leave from out, or ask the platform about sending from your own domain."), or `from` matching none of the installation's senders ("This app may not send as `<address>`: list it, or `*@<domain>`, among the app's senders with `everyapp email set --sender` in the app's directory.")                                                                                                                                                                                                    |
| `integration_not_configured`     | 503                                             | the Gateway has no sender or no selectable provider: "Email isn't set up on this gateway. Its operator sets up a sending domain, then sets EMAIL_FROM and EMAIL_FROM_NAME and one transport: … with everyapp secret set `<NAME>` (docs/runbooks/email-sending-setup.md)."; also the send's `EMAIL_SENDER_NOT_CONFIGURED` and `EMAIL_BINDING_UNAVAILABLE`                                                                                                                                                                                                                              |
| `email_budget_exhausted`         | 429                                             | a recipient or the Gateway has had its day's app mail; `retry-after` header in seconds until the next UTC midnight                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `email_budget_unavailable`       | 503                                             | the budget counters couldn't be read or written, so nothing was sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `email_sender_not_verified`      | 422                                             | the provider refused the From's domain: Email Sending's `E_SENDER_NOT_VERIFIED` or `E_SENDER_DOMAIN_NOT_AVAILABLE`; Resend's 403 or `validation_error` naming a domain. The message names the step: `cf email-sending subdomains create -z <domain> --name <domain>`, or `https://resend.com/domains`                                                                                                                                                                                                                                                                                 |
| `email_provider_limited`         | 429                                             | the provider's rate or daily limit: Email Sending's `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, REST `10004` or HTTP 429; Resend's 429, `rate_limit_exceeded`, `daily_quota_exceeded`, `monthly_quota_exceeded`                                                                                                                                                                                                                                                                                                                                                                |
| `email_invalid_message`          | 400                                             | the provider refused the message as malformed: Email Sending's `E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_TOO_MANY_RECIPIENTS`, `E_TOO_MANY_ATTACHMENTS`, `E_CONTENT_TOO_LARGE`, `E_HEADER_*`, `E_HEADERS_*`, REST `10001`, `10200`, `10202`; Resend's other 400s and 422s                                                                                                                                                                                                                                                                                                           |
| `email_send_failed`              | 502                                             | anything else the provider answered, a key Resend refused ("Resend refused the API key"), Resend unreachable, every recipient permanently bounced (REST)                                                                                                                                                                                                                                                                                                                                                                                                                              |

The mapping from provider codes to refusals is `emailProviderRefusal()` in `packages/sdk/src/internal/email.ts`; Resend's errors are mapped onto the same `E_*` names in `apps/every-app-gateway/src/server/email/providers/resend.ts`.

### The sender rule

`senderAllowed(address, patterns)`: a pattern `*@example.com` takes any address on exactly `example.com` (not its subdomains); any other pattern takes that one address; case never matters. The patterns are the app's `apps.email_senders`, passed to the capability as `RegisteredApp.emailSenders` and empty on a hosted Gateway or for an app without the grant (`effectiveSenders()`). A `senders` list left in a manifest snapshot is ignored. A hand-edited column that isn't a JSON array is read as a comma or whitespace list (`parseEmailList()`), so a word there allows no address.

### Status: GET /api/integrations/email

`integrationStatus({ env, provider: "email" })` from `@every-app/sdk/server` answers without sending. Its result is an `EmailIntegrationStatus` (`packages/sdk/src/server/integrationFetch.ts`: `IntegrationStatus` plus `sender`, `senders`, `provider`); the Gateway's wire body is the `EmailCapabilityStatus` of `@every-app/sdk/internal`:

| Field        | Meaning                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `requested`  | the deployed manifest lists `email` with `access: "write"`                                                                |
| `configured` | `isEmailConfigured()`: the Gateway has a sender and a selectable provider (only an app that lists `email` learns this)    |
| `ready`      | `requested && configured`                                                                                                 |
| `sender`     | `{ address, name }` a message without `from` gets; null unless configured                                                 |
| `senders`    | the `from` patterns the Gateway accepts from this app (its installation's); `[]` on a hosted Gateway or without the grant |
| `provider`   | `"cloudflare"` or `"resend"`; null unless configured                                                                      |

The Gateway's body also carries `capability: "email"`. Status requests need no attribution. A Gateway answer that isn't 2xx is never thrown: the call returns `{ requested: false, configured: false, ready: false, sender: null, senders: [], provider: null }`.

### Logging

Every send is logged as `email.app.send` with the caller (organization, app, Worker), `recipients` (count), `recipientHash` (an HMAC of the first `to` address, keyed with `BETTER_AUTH_SECRET`), `sender` (`"app"` or `"gateway"`), `attribution` (`"user"` or `"app"`), `userId` when a person is behind it, and `status` (`delivered`, `queued`, or `refused` with `reason` = the code). Never the subject, bodies, attachments or an address. A failed provider send is also logged as `email.send.failed` with `kind`, `provider`, `code`, `providerCode` and `message` (`apps/every-app-gateway/src/server/email/sendEmail.ts`).

## Budgets

App mail is the `app` kind of `platformPolicy(env).mailDaily` (`apps/every-app-gateway/src/server/platform-policy.ts`), spent in `spendMailBudget()` before the send, so a send that fails still counts:

| Mode                              | Per recipient address a day | Per Gateway a day |
| --------------------------------- | --------------------------- | ----------------- |
| `self_hosted`                     | 100                         | 5,000             |
| `hosted`                          | 20                          | 5,000             |
| invalid `GATEWAY_DEPLOYMENT_MODE` | 0                           | 0                 |

Counted once per distinct recipient (lowercased) across `to`, `cc` and `bcc`, in D1 `rate_limit_counters` under `mail:app:gateway:<day>` and `mail:app:to:<hmac>:<day>`, so the counters hold across isolates and never hold an address. A message is refused whole when the Gateway's count plus its recipients would pass the Gateway budget, or any recipient has reached the address budget; `retryAt` is the next UTC midnight. There is no per-organization budget.

## Receiving mail: the email() handler

Inbound mail is not a capability. The app's Worker exports an `email()` handler beside `everyApp()`'s `fetch`, declares `email: { inbound: true }`, and the installation's addresses are routed to the Worker by name with Email Routing rules.

```ts
export default {
  fetch: everyApp(app).fetch,
  async email(message, env, ctx) {
    // message.from, message.to (the envelope), message.headers, message.raw (a ReadableStream), message.rawSize
    // message.setReject(reason), message.forward(rcptTo, headers?), message.reply(message)
  },
};
```

The handler has Cloudflare's signature, `email(message: ForwardableEmailMessage, env, ctx)` (`@cloudflare/workers-types`). It runs with no identity: anyone can mail the address, so the app treats the message as untrusted, and its Gateway calls (`sendEmail()`, `integrationFetch()`, `listMembers()`) pass `for: { background: true }` from an organization's own app (its `env.EVERY_APP_ORG_ID` is the only organization it may name, and the Gateway fills it in) or `for: { background: true, organizationId }` from a shared app's Worker (`env.EVERYAPP_SHARED === "1"`, no `EVERY_APP_ORG_ID`), which must supply the id itself: neither `ForwardableEmailMessage` nor the SDK carries one. The same holds for a cron. `everyapp dev --help` says the same: "email() gets no identity." The platform's trust boundaries are catalogued in `docs/threat-model.md` (assets, actors, trust boundaries, one testable invariant per boundary; mirrored under /docs/agent/repo when it lands).

### The rules the CLI makes

`packages/cli/src/lib/app/emailRoutes.ts`, through `packages/cli/src/lib/cf/emailRouting.ts` (`cf email-routing …`, zone-scoped with `-z <zone id>`, bodies passed as `--body @<file>`):

- A literal address gets one rule: `{ "name": "everyapp:<worker>", "enabled": true, "matchers": [{ "type": "literal", "field": "to", "value": "<address>" }], "actions": [{ "type": "worker", "value": ["<worker>"] }] }`.
- `*@<apex>` sets the zone's catch-all to the same shape with `matchers: [{ "type": "all" }]`. A catch-all on a subdomain is refused (`EMAIL_CATCH_ALL_NOT_APEX`): Email Routing has catch-alls on an apex only.
- Each route is the app's when the Gateway's D1 ledger records it (`packages/cli/src/lib/app/ownership.ts`, kind `email-route`, `binding` and `name` the address, `resourceId` `<zone id>/<rule id>` or `catch_all:<zone id>`). The row is claimed with a null `resourceId` before the rule is created, so a retry after a create whose id went unrecorded finds the rule by its name and address.
- A rule named `everyapp:<worker>`, one that already sends the address to the Worker (the manual step the runbook documents), or one the ledger records is adopted and updated to the wanted shape; any other rule on the address refuses with `EMAIL_ADDRESS_TAKEN`, and a catch-all that is on and does anything but drop refuses with `EMAIL_CATCH_ALL_TAKEN`. Nothing is taken over.
- A domain routes mail when the zone's Email Routing setting is `enabled` (its apex) or the subdomain has MX records at `*.mx.cloudflare.net`. Enabling (`cf email-routing enable -z <zone> --name <domain>`) is done for the domains the addresses name, the apex before its subdomains, only after a yes at the terminal or `--enable-email-routing`.
- Addresses the list drops lose their rule in the same run (`email set`) or on the next deploy; a dropped catch-all goes back to `{ "enabled": false, "actions": [{ "type": "drop" }] }`.

The Worker's name, `every-<org>-<app>`, is printed by `everyapp deploy`, `everyapp status` and `everyapp email show` (`data.app.workerName`).

### Deploy keeps the rules in step

`packages/cli/src/commands/deploy/deployApp.ts` reads the stored lists under the app's lease, plans the routes before the upload and makes them after it (a rule may only name a Worker that exists), as step `app.email`:

- The deployed manifest no longer declares inbound while addresses are stored: warning `EMAIL_INBOUND_UNDECLARED` ("everyapp.config.ts no longer declares inbound email; removing the app's mail routes\nIts addresses (…) stay on the Gateway until you clear them.", `data.rerun: pnpm everyapp email unset inbound`); the routes go, the list stays.
- Step `app.email` `ok` with `data: { addresses, removed, enabled, replyHint? }` and the message from `describeMailRoutes()`: "Mail to `<list>` goes to `<worker>`." plus "Removed the routes for …" and, when a routed domain has no sender, the app declares `capabilities.email` and the Gateway isn't hosted (`sendersSettable: emailDeclarations(manifest).sends && install.deploymentMode !== "hosted"`; an inbound-only app gets no hint), "To reply from `<domain>`, onboard it to Email Sending and list it with `pnpm everyapp email set --sender` (docs/runbooks/email-sending-setup.md)." ("them" for several domains).
- The app declares inbound with no addresses: step `app.email` `skip`, "`<id>` receives no mail yet.", and `pnpm everyapp email set --inbound <address>` among the next commands.
- `everyapp deploy --enable-email-routing` has the same meaning as on `email set`.

`everyapp status` (`packages/cli/src/commands/status/problems.ts`) reads every recorded route live and prints an `EMAIL | SENDS AS | RECEIVES` table:

| Problem code               | Severity | When                                                                                                                                                                                                        | Fix                                                                           |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `EMAIL_INBOUND_UNDECLARED` | warning  | addresses stored for an app whose deployed manifest doesn't declare inbound                                                                                                                                 | declare it and `pnpm everyapp deploy`, or `pnpm everyapp email unset inbound` |
| `EMAIL_ROUTE_PENDING`      | warning  | an address is stored but not routed yet, or a route is still there for an address the list dropped                                                                                                          | `pnpm everyapp deploy` from the app's directory                               |
| `EMAIL_ROUTE_MISSING`      | warning  | a recorded route doesn't deliver: "its Email Routing rule is gone", "its rule is off", "the catch-all sends mail to …", "Email Routing is off for `<domain>`", "a deploy stopped before recording its rule" | `pnpm everyapp deploy` from the app's directory                               |
| `EMAIL_ROUTES_UNKNOWN`     | warning  | cf couldn't read the rules ("Couldn't check the apps' Email Routing rules"); the rest of the report stands                                                                                                  |                                                                               |

`everyapp delete` without `--purge` keeps the routes (like the Worker's crons and Workflows: "its Worker and data are kept, and any cron triggers, Workflows and mail routes keep running"); `everyapp delete --purge` deletes every route the app recorded first, so no rule names a Worker that is gone (a catch-all drops mail again), counted as "mail route" in `purged`. With or without `--purge`, the delete clears both lists: the registry's delete statements include `UPDATE apps SET email_senders = NULL, email_inbound = NULL` (`withoutAppData()` in `packages/cli/src/lib/gateway/registry.ts`; the Gateway's own delete does the same), and a revived app (the same id deployed again, under the same Worker name: `registryWorkerNameFor()` in `packages/perimeter/src/manifest/manifest.ts` is `every-<orgKey>-<appId>`, and `planRegistration()` in `packages/perimeter/src/registry/registration.ts` (which the CLI's `registry.ts` calls) reuses an existing row's name or derives that one through `appNames()`, refusing any other with `INVALID_WORKER_NAME`, so the ledger rows still match it) starts with none, so after its redeploy run `everyapp email set` again. Without `--purge` the Email Routing rules keep naming the deleted Worker and stay in the ledger; `everyapp email set` on a deleted app answers `APP_NOT_FOUND` (`readApp()` reads registered apps only), so nothing reconciles them until the app's redeploy, whose empty stored list makes every route the ledger still records a dropped one and deletes it, or `everyapp delete --purge`.

## Local dev

### Sending in dev

With no `EVERY_APP_GATEWAY` binding and `EVERYAPP_DEV` set, `sendEmail()` runs `sendInDev()` (`packages/sdk/src/server/sendEmail.ts`):

1. The message is checked by `parseSendEmailMessage()`; a problem throws `GatewayRefusalError` 400 `email_invalid_message`.
2. A `from` must match `EVERYAPP_EMAIL_SENDERS` from the app's `.dev.vars`: a comma- or whitespace-separated list, or a JSON array, standing in for the installation's senders. Unset, every `from` is refused, 403 `email_sender_not_allowed`: "This app may not send as `<address>`: in dev, list it, or `*@<domain>`, in EVERYAPP_EMAIL_SENDERS in .dev.vars; deployed, `everyapp email set --sender` sets the app's senders." `everyAppWorker()` (`packages/sdk/src/cloudflare/worker.ts`) declares `EVERYAPP_EMAIL_SENDERS` as a secret binding when the manifest lists `capabilities.email` and `.dev.vars` sets it; the dev `Env` type has `EVERYAPP_EMAIL_SENDERS?: SecretBinding`.
3. With `EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `EMAIL_FROM` in `.dev.vars` (`EMAIL_FROM_NAME` optional: a developer's address alone will do), the message really goes out through Email Sending's REST API from the developer's own account, From the message's `from` or `EMAIL_FROM`; provider errors map through `emailProviderRefusal()` like production.
4. Otherwise it prints `[everyapp dev] email to <n> recipient(s) subject "<subject>" (not sent: set EMAIL_REST_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and EMAIL_FROM in .dev.vars to send)` and answers `{ status: "logged", messageId: "dev-<uuid>" }`.

`integrationStatus()` in dev: `requested: true`; `configured` and `ready` when `EMAIL_FROM` is set; `sender` is `parseEmailSender(EMAIL_FROM, EMAIL_FROM_NAME)`, null when neither carries a name even though `configured` is true; `senders` from `EVERYAPP_EMAIL_SENDERS`; `provider` the one the Gateway would pick from the same `.dev.vars` (`cloudflare` for the REST pair, `resend` for `RESEND_API_KEY`, `EMAIL_PROVIDER` choosing). Only Cloudflare's REST API sends from dev: with `RESEND_API_KEY` alone the status names `resend` and `sendEmail()` still prints.

### Receiving in dev

`everyapp dev` delivers no real mail and does no routing. For an app whose manifest declares `email: { inbound: true }`, it prints an `Email` line (`packages/cli/src/commands/dev/ready.ts`) with miniflare's local delivery endpoint on the app's own dev port, not the Gateway's:

```
curl -X POST "http://127.0.0.1:<app port>/cdn-cgi/local/email?from=someone@example.net&to=hello@example.com" --data-binary @message.eml
```

Any `to` reaches the handler. The raw message needs `From`, `To`, `Subject` and `Message-ID` headers (`everyapp dev --help`).

## Hosted and self-hosted

| Aspect                    | Self-hosted Gateway                                                          | Hosted Gateway (`GATEWAY_DEPLOYMENT_MODE=hosted`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App senders               | `everyapp email set --sender`, per installation                              | refused: `EMAIL_SENDERS_HOSTED`; any `from` answers 403 `email_sender_not_allowed`; status `senders: []`; all app mail goes out as the platform's sender                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| App mail budgets          | 100 per address, 5,000 per Gateway a day                                     | 20 per address, 5,000 per Gateway a day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Inbound addresses         | `everyapp email set --inbound`, Email Routing rules in the Gateway's account | `email set --inbound` itself has no hosted check, but apps on the dispatch tier (third-party apps, which the Gateway's deploy API and the browser install register) don't receive mail: the Gateway's deploy API and the browser install (Admin → Apps → Install app) refuse `email: { inbound: true }` before any row is written (`manifestProblems` in `apps/every-app-gateway/src/server/deploy/metadata.ts`: "it declares inbound mail (email.inbound), which third-party apps can't receive"). `everyapp deploy` never deploys a dispatch-tier app: its registration passes no tier (`registerFromManifest` in `packages/cli/src/lib/gateway/registry.ts`), so `planRegistration` (`packages/perimeter/src/registry/registration.ts`) plans `service_binding` and refuses an existing dispatch row with 409 `APP_TIER_MISMATCH` before any upload |
| `everyapp email` commands | cf login with access to the Gateway's D1                                     | the same (the operator's); the shared app's lists are the platform organization's owners' and admins' to change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Open decisions

From `TODO.md`, "Email configuration on the gateway (2026-10-19)", still open:

- One list per installed app: a shared app has one sender list for every organization it serves (per-organization senders would need `GET /api/integrations/email` attributed before it answers).
- A hosted Gateway refuses every app sender in v1.
- The Gateway reads senders from the cached app row, up to 30 s stale; no D1 read per send.
- `set` replaces, `unset` clears; no `add`/`remove` verbs, no `--yes` (nothing asks but the Email Routing takeover).
- `email set --sender` doesn't check that the domain is onboarded; the provider refuses at send time.
- A literal address under another app's catch-all isn't refused: `email set --inbound ceo@example.com` in one app's directory carves the address out of another app's `*@example.com` without a word to that app.
- A non-JSON `email_senders`/`email_inbound` column is read as a word list by the Gateway and the CLI, as none by Admin → Apps; only `email set` writes the columns.
- Admin → Apps shows the lists read-only and names `everyapp email set`; inbound stays CLI-only until the Gateway holds a Cloudflare token for Email Routing.
- Follow-ups: dev `sendEmail()` through Resend; a live Resend send from a deployed Gateway; the deploy's hints assume the app's directory even on a release deploy, where `--manifest <path>` is needed.
- The runbook lists what no live account has verified yet: that a rule delivers to a Worker with no routes and no `workers.dev` subdomain, that it survives redeploys, the exact output of `cf email-routing rules create`, and whether Email Routing takes a subdomain while the apex has it off.

## Sources

`packages/cli/src/commands/email/command.ts`
`packages/cli/src/commands/email/index.ts`
`packages/cli/src/commands/email/index.test.ts`
`packages/cli/src/commands/flags.ts`
`packages/cli/src/lib/app/emailRoutes.ts`
`packages/cli/src/lib/cf/emailRouting.ts`
`packages/cli/src/lib/app/policy.ts`
`packages/cli/src/lib/gateway/registry.ts`
`packages/cli/src/lib/gateway/lease.ts`
`packages/cli/src/lib/output/time.ts`
`packages/cli/src/lib/errors.ts`
`packages/cli/src/lib/output/events.ts`
`packages/cli/src/lib/output/report.ts`
`packages/cli/src/lib/output/run.ts`
`packages/cli/src/commands/deploy/deployApp.ts`
`packages/cli/src/commands/deploy/command.ts`
`packages/cli/src/commands/status/problems.ts`
`packages/cli/src/commands/status/render.ts`
`packages/cli/src/commands/status/index.ts`
`packages/cli/src/commands/delete/index.ts`
`packages/cli/src/commands/dev/ready.ts`
`packages/cli/src/commands/dev/command.ts`
`packages/cli/src/test/fixtures/manifests/agentic-inbox.ts`
`packages/sdk/src/internal/email.ts`
`packages/sdk/src/internal/capabilities.ts`
`packages/sdk/src/internal/gatewaySettings.ts`
`packages/sdk/src/internal/protocol.ts`
`packages/sdk/src/server/sendEmail.ts`
`packages/sdk/src/server/integrationFetch.ts`
`packages/sdk/src/server/attribution.ts`
`packages/sdk/src/server/index.ts`
`packages/sdk/src/cloudflare/worker.ts`
`packages/perimeter/src/manifest/manifest.ts`
`packages/perimeter/src/registry/registration.ts`
`apps/every-app-gateway/src/server/capabilities/email.ts`
`apps/every-app-gateway/src/server/capabilities/refusal.ts`
`apps/every-app-gateway/src/server/email/sendEmail.ts`
`apps/every-app-gateway/src/server/email/errors.ts`
`apps/every-app-gateway/src/server/email/providers/index.ts`
`apps/every-app-gateway/src/server/email/providers/types.ts`
`apps/every-app-gateway/src/server/email/providers/cloudflare.ts`
`apps/every-app-gateway/src/server/email/providers/resend.ts`
`apps/every-app-gateway/src/server/integration-proxy.ts`
`apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`
`apps/every-app-gateway/src/server/platform-policy.ts`
`apps/every-app-gateway/src/server/deploy/metadata.ts`
`apps/every-app-gateway/src/server/app-email.sqlite.test.ts`
`docs/runbooks/email-sending-setup.md`
`docs/capabilities.md`
`landing-page/content/docs/people.mdx`
`TODO.md`
