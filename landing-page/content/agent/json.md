---
title: The --json protocol
description: What an everyapp command prints with --json (NDJSON events), its exit codes, and what an agent does with each event, action and error.
---

Every command takes `--json`. With it, stdout is one JSON event per line, nothing prompts, and the exit code says how the run ended. Commands are on [cli](/docs/agent/cli), codes on [errors](/docs/agent/errors).

## The stream

- Each line is `{ "v": 1, "ts": "<ISO time>", "type": "<type>", … }`. Nothing else is written to stdout: child processes (pnpm, builds, git) write to a log under `$TMPDIR/everyapp/`, and a failure names that log.
- `--json` is read before the arguments are parsed, so an unknown command or flag is an `error` event too.
- `--help` and `--version` print text, not events.
- Under Bun or Node older than 22.18 the run is one `error`, `UNSUPPORTED_RUNTIME`.

## Event types

| `type` | Fields | Meaning |
|---|---|---|
| `step` | `step`, `status` (`start`, `ok`, `skip`, `fail`), `message?`, `data?` | A named piece of work (`setup.gateway`, `app.register`, `app.migrations`, `app.live`). |
| `progress` | `step`, `message`, `data?` | A line while a step runs (waiting for a lease or a certificate). |
| `warning` | `code`, `message`, `step?`, `data?` | Something to know; the run goes on. |
| `action_required` | `action`, `message`, `step?`, `data?` | Only a person can go on (below). |
| `error` | `code`, `message`, `retryable`, `step?`, `data?` | The run failed. Always last. |
| `done` | `message?`, `data?` | The run finished. Always last. |

A `message`'s first line is the headline; the lines after it are detail.

## Exit codes

| Code | When |
|---|---|
| `0` | Ended with `done`. |
| `1` | An `error` was emitted. A declined prompt is `CANCELLED`, exit 1. |
| `2` | Stopped on an `action_required` (or ran out of time waiting for one). Do the action, then run `data.rerun` or one of `data.choices`. |
| `130` | Ctrl-C. Running cf children are stopped and cleanups run. |
| `251` | No such command (`UNKNOWN_COMMAND`, with `data.didYouMean`). |
| `252` | Bad arguments: `UNKNOWN_FLAG`, `INVALID_VALUE`, `MISSING_ARGUMENT`, `MISSING_FLAG_VALUE`, `TOO_MANY_ARGUMENTS`, `REPEATED_FLAG`, with `data.usage`, `data.help` or `data.didYouMean`. |

## What to do next: `fix`, `rerun`, `authorize`

On `error` and `action_required` events, `data` may carry:

- `fix`: a remedy in words. Do it; there is no command.
- `rerun`: the exact command to run next, `--json` kept when this run had it. Run it as it is; never rebuild it. `rerunNote` says when ("once it's done", "in a terminal").
- `authorize: true`: `rerun` adds a flag that takes something over. Show the error to the person and ask before running it. Never add these flags on your own:
  - `--force-dns` for `DNS_RECORD_CONFLICT`, `DNS_UNREADABLE` and `CAA_BLOCKS_ISSUANCE`;
  - `--allow-delete-durable-object-data` for `DURABLE_OBJECT_REMOVED`;
  - `--allow-delete-workflows` for `WORKFLOW_REMOVED`;
  - `--enable-email-routing` for `EMAIL_ROUTING_DISABLED`;
  - `--yes` for `CONFIRMATION_REQUIRED`.
- `needsTerminal: true`: only a person at a terminal can run `rerun`, so it has no `--json`. Hand it over; don't add `--json`.
- `choices`: instead of `rerun`, when the way on is one of several commands. It's an array of `{ rerun, label, … }`. Pick one with the person.
- `url`: a page that helps. `rollbackCommand`: cf's command to put back a database this run migrated. `stack`: on `UNEXPECTED`.

`retryable: true` means the same `rerun` can succeed with nothing changed (`NETWORK_ERROR`, `CF_TIMEOUT`, `LEASE_HELD`, `APP_CHANGING`). Retry it a few times. `retryable: false` with a `rerun` means something must happen first.

## Actions a person must take

| `action` | What the person does | Notes |
|---|---|---|
| `cloudflare_login` | Opens `data.url` and approves the Cloudflare login, entering `data.code` if asked. | With `data.waiting: true` the run goes on by itself once approved. Unattended runs set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead. |
| `claim_owner` | Opens the one-time setup link (`data.url`) and creates the owner account. | It waits up to 15 minutes. The link works once, expires in 24 hours and is a password. Rerun `setup` for a new one. Under `CI` the link is never shown: `done` with the warning `OWNER_NOT_CLAIMED`. |
| `upgrade_workers_paid` | Subscribes the account to Workers Paid at `data.url`. | Then rerun. |
| `register_workers_subdomain` | Picks a workers.dev subdomain in the dashboard (`data.url`). | Then rerun. |
| `add_domain` | Adds a domain to the account, or finishes activating one (`data.url`). | Then rerun. |
| `choose_account` | Picks one of `data.choices` (several accounts or Gateways). | Each choice's `rerun` adds `--account-id` or `--gateway`. |
| `install_gateway` | Runs `everyapp setup`: no account has a Gateway. | `data.accounts` lists the accounts the login sees. |
| `rerun_interactive` | Runs `data.rerun` in a terminal to confirm replacing a Worker changed outside everyapp. | `needsTerminal: true`; `--yes` doesn't skip it. |

## Prompts under `--json`

Nothing prompts. A yes/no question is `CONFIRMATION_REQUIRED` (pass `--yes` once the person agrees). A choice is `choose_account`, or `DOMAIN_REQUIRED` for `setup` without `--domain`. A secret's value comes from `--from-env <VAR>` or stdin, never the command line (`SECRET_VALUE_REQUIRED`). `configure <app>` reads `NAME=value` lines on stdin or `--from-env`. `teardown` needs `--confirm <account id>`.

## Results in `done.data`

`data.durationMs` is always there. `data.next` lists what to run next: command strings, or `{ command, note }`. `data.facts` holds the labelled lines a person sees. The command's own result:

- `status`: the whole report. It has `gatewayUrl`, `apps[]` (each with `status`, `publicRoutes` and `setup`), `access` (`{ on }`), `fixes[]` as `{ code, severity, message, run, note?, fix? }` ([status](/docs/agent/status)) and `next[]` as `{ code, command?, url?, note, why }`. The next-step codes are `AI_KEY`, `PROVIDER_OFFER`, `PROVIDER_KEY`, `ACCESS_OFF`, `INVITE`, `CONNECT_AI`, `CREATE_APP` and `EMAIL_UNSET`.
- `db query`: `{ database, results: [[row, …] per statement], meta: [{ duration, changes }] }`.
- `secret list`: names only, never values. The Gateway's names and settable names, and each app's `setup`.
- `secret set`: `gateway.bound` lists the provider rows (a remote MCP app's `<id>-mcp` among them) whose key is now bound to their hosts.
- `deploy`: `{ url, workerName, versionId, live, organization, publicRoutes, next }`.
- `workspace …`, `events …`, `ai show|default`, `call <tool>`: the Gateway tool's answer. With no stored sign-in and no `EVERYAPP_TOKEN`, the run first emits a `gateway.signin` progress event whose URL the person opens, and waits. A tool's refusal is `GATEWAY_TOOL_ERROR` (`data.code`, `data.tool`); a refused credential `GATEWAY_REFUSED`.
- `setup` and `update`: `{ gatewayUrl, adminUrl, organizationName, owner, release, gateway, accessOn, next }`. `gateway` is `installed`, `upgraded`, `repaired` or `up-to-date`.
- `mcp add`: `{ id, url, auth, credential, connect?, oauth?, verify?, probe, mcp, next }`. `credential.kind` is `none`, `bearer`, `header`, `query`, `basic`, `oauth` or `provider`; `connect.url` is where each member connects an OAuth server; `verify` is the static key's check.
- `create`: `{ appId, dir, next }`. `release`: `{ tarball, shown, version, sha256, next }`. `delete`: `{ appId, workerName, alreadyDeleted, purged }`.

An app's setup state (`status` as `apps[].setup`, `secret list` as `app.setup`, `configure` as `app.setup`) is:

```ts
{ ready: boolean,
  settings: Setting[],   // every setting, in manifest order
  unmet: Setting[],      // the ones that keep the app closed ("Needs setup")
  command: { command } | null }  // "everyapp configure <app>"; null once ready
Setting = { kind: "provider" | "capability" | "secret" | "setting" | "ai-default" | "remote-mcp",
  id, label, holder: "gateway" | "app", names: string[],
  need: { kind: "required" | "optional" | "anyOf", group? },
  set: true | false | null, blocking: boolean, why?, hint?, docs?, setup? }
```

To set an app up, show each `unmet` setting's `why`, `hint` and `setup` guide (`setup/<name>.md` in the everyapp skill, or for an app's own secret a path in the app such as `docs/setup/main-secret.md`). Then have the person run `everyapp configure <app>` at a terminal so values never pass through the chat.

## The loop an agent runs

1. Run the command with `--json`. Read each line as it comes and show the person the `message` headlines.
2. On `action_required`: tell the person exactly what to do (the URL, the code). If `waiting`, keep reading; otherwise wait for them, then run `data.rerun`.
3. On `error`: look up the code on [errors](/docs/agent/errors). Do `fix`, or run `rerun` (ask first when `authorize`). If `retryable`, retry.
4. On `done`: report `data`, and offer `data.next`.
