# The usage report receiver

`telemetry.everyapp.com`: the Worker a self-hosted Gateway sends its daily usage report to. What a Gateway sends, and how people turn it off, is on [everyapp.com/docs/telemetry](https://everyapp.com/docs/telemetry); the sender is `apps/every-app-gateway/src/server/telemetry/`.

It is small on purpose, so anyone can check what we keep:

- `src/index.ts` is all of it. `POST /v1/report` takes one JSON report and stores it in the D1 table in `migrations/0001_reports.sql`.
- It stores the report's body and nothing else: no address, no header, no time finer than the report's day.
- A report with a key the file doesn't name, a count that isn't rounded, or an app name that isn't one of ours is refused, so a field can't be added from either side without changing this file.
- Workers Logs are off (`wrangler.jsonc`), so Cloudflare keeps no line per request.
- Reports older than 25 months are deleted once a day.

`example-report.json` is a whole report. The Gateway's tests check that what it builds has exactly these keys.

## Deploy

On Every App's main Cloudflare account, from this folder. Once:

```sh
pnpm exec wrangler d1 create everyapp-telemetry
```

Then, the first time and after any change here:

```sh
pnpm migrate
pnpm deploy:worker
```

`deploy:worker` also makes `telemetry.everyapp.com` (a custom domain on the `everyapp.com` zone). The config names the database and not its id; if wrangler asks for one, add the `database_id` that `d1 create` printed to `wrangler.jsonc`.

Until this is deployed, Gateways that try to report fail quietly and try again the next day.

## Read the numbers

```sh
pnpm numbers
```

runs `numbers.sql`: Gateways and people per day, the last 7 days as one line, use per app, versions and new Gateways per month. Counts are rounded down before they are sent, so every sum is "at least".

A new catalog app is added to `APPS` here, and deployed, before a Gateway release names it (the Gateway's test checks the two lists match).
