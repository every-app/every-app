# Several Gateways in one Cloudflare account (2026-10-28)

Why: Ben's YouTube demo had to go on a separate Cloudflare test account, because a Gateway's Worker name was fixed (`every-app-gateway`) and so one account held one Gateway. Ben wants the demo, and a pre-release staging Gateway, in the main account next to everyapp.team: deploy the Gateway and run the CLI against it before a release goes public.

## The rule

A Gateway has a **name**: none for the one every install has today (the default), or 1 to 16 lowercase letters or digits (`everyapp setup --name demo`). Every account-wide name derives from it, in one module, `packages/perimeter/src/manifest/gatewayNames.ts` (`GatewayNames`, `gatewayNames(name)`, `belongsToGateway`):

| What               | Default (unchanged)         | Named `demo`                                     |
| ------------------ | --------------------------- | ------------------------------------------------ |
| Gateway Worker, D1 | `every-app-gateway`         | `every-app-gateway-demo`                         |
| OAuth KV title     | `every-app-gateway-OAUTH_KV`| `every-app-gateway-demo-OAUTH_KV`                |
| Activation queue   | `every-app-gateway-activate`| `every-app-gateway-demo-activate`                |
| App Worker         | `every-<orgKey>-<app>`      | `every-demo--<orgKey>-<app>`                     |
| App resource       | `<worker>--<binding>`       | `<worker>--<binding>` (same rule)                |
| App AI Gateway id  | `<worker>-<binding>`        | `every-app-gateway-demo-<orgKey>-<app>-<binding>`|
| Access apps/policy | `Every App gateway`, …      | `Every App gateway (demo)`, …                    |
| Hostnames          | `<host>`, `<app>.<host>`    | the same, under the host `--domain` names        |

The Gateway Worker learns its name from the text binding `EVERYAPP_GATEWAY_NAME` (empty for the default), patched in by the deploy with its Worker name, D1 name and queue name (`patchGatewayBuildOutput`); `apps/every-app-gateway/src/server/gateway-name.ts` reads it for registration and browser installs. An app's `GATEWAY` service binding is built as `every-app-gateway` and rewritten at install to the Gateway it deploys to (`installBuildOutput.ts`).

## Why the names can't collide

- A default app name is `every-` + org key + `-` + a letter or digit (org keys have no hyphen; app ids start with one of those). A named Gateway's app has `--` right after its name, so the character after the first segment is `-`: never a default app's, and never another named Gateway's (`every-a--` is a prefix of `every-b--…` only when a = b, since names have no hyphen).
- Everything under the root `every-app-gateway-…` is reserved from apps on every Gateway (`isReservedName`, unchanged). The default owns its three exact names there; a named Gateway owns `every-app-gateway-<name>` and `every-app-gateway-<name>-…`. AI Gateway ids may not hold `--`, which is why a named Gateway's go under this root.
- The default's scan is what it was (`every-*`) minus those two shapes, so nothing it owned before is lost but a legacy `every-<app>--<binding>` resource of a pre-org-scoped app, which the Gateway no longer binds and which the resource ledger still names.

`gatewayNames.test.ts` generates every kind of name for the default and three named Gateways, over org keys and app ids chosen to collide (`app` + `gateway-demo`, `demo` + `todo`, …), and checks each belongs to exactly one Gateway, and that no named Gateway's prefix matches another's names. The teardown's inventory uses the same predicate.

## The CLI

- `setup --name <name>` looks for a Gateway of that name only and installs one when there is none; without it, the default, as always. An existing install needs nothing: its names are the default's.
- `--gateway <url|name>` on every Gateway command picks among several: a URL by host, a name (`demo` or `every-app-gateway-demo`; `every-app-gateway` is the default). `update` and `status` take it too.
- Discovery (`discover.ts`) lists every `every-app-gateway*` D1 per account (`listGatewayDatabases`) and never guesses: one Gateway anywhere is the one; several and nothing to pick by is `choose_account` with one rerun per Gateway (`--account-id <id>` across accounts, `--account-id <id> --gateway https://<host>` inside one).
- `teardown --gateway <name>` tears down one named Gateway by its names alone, so it may run beside a production Gateway: the test-account allowlist isn't read, the typed confirmation is the Worker name `every-app-gateway-<name>`. `teardown --all` empties a test account of every Gateway. The default teardown keeps its guards.

## What is per-Gateway already

Hostnames, DNS records and certificate packs follow the Gateway's host; Access applications are found by the hosts they cover (and now by name); provider keys, `EMAIL_FROM`, `CF_DEPLOY_TOKEN` and browser installs are the Gateway Worker's own secrets and install organization; the ledger of app resources is in the Gateway's D1. Email Routing rules are matched by the Worker they send to.

## Decided for Ben

- Named Gateways share the Zero Trust team with the default; only the applications and policy are new.
- A Gateway name is at most 16 characters, so an app id keeps 31 characters under the 63-character Worker limit.
- `app`, `gateway` and `activate` are refused as names.
- A deploy that installs a Gateway on the way (`deploy` with none found) installs the default one; a named one is `setup --name`'s.

- The staging/demo Gateway lives at `demo.everyapp.dev`, not `demo.everyapp.team` (Ben's answer carried a question mark; the orchestrator decided 2026-10-28): production's session cookie covers `everyapp.team` and would reach `demo.everyapp.team`, and production's Access application for apps covers `*.everyapp.team`, which would take the demo's host too. Nothing overlaps on `.dev`; the mail records at the `everyapp.dev` apex stay. Easy to switch if Ben says so.
- AI Gateway ids keep a single hyphen between the Gateway name and the org key (`every-app-gateway-demo-<orgKey>-<app>-<binding>`): Cloudflare refuses `--` in an id (`[7001] not valid ID format`, seen live 2026-10-24, `isAiGatewayId`). No other Gateway can make that id: names have no hyphen, so the segment after `every-app-gateway-` is the name and nothing else, and the default Gateway can't register an app whose Worker starts with `every-app-gateway-` (reserved). Within one Gateway the id alone doesn't say whose it is (org `x` app `a-b` or org `x` app `a` binding `b`), as today for the default; the resource ledger does, and the deploy refuses an id it didn't record.
