# Capabilities the gateway holds

An app often needs a third-party API that isn't AI: DataForSEO for SEO data,
Context.dev for rendering pages, later GitHub, Google or Slack. The gateway
holds the credential once, an app lists the capability in its manifest, and
the app calls through the gateway. No app holds the key, and a deploy needs
no per-app settings.

This is phase 0 of the integrations design (branch
`research/app-integrations`, `docs/research/2026-10-integrations-hub/app-integrations.md`):
**API-key providers whose key the gateway holds.** OAuth providers,
per-organization accounts and admin approval come in later phases and keep
the same manifest entry, binding route and SDK call.

AI providers stay separate: `providers: ["openai", "openrouter"]` and the
`/api/ai/<provider>` proxy, with their model and route allowlists.

What comes next is designed, not built: the October 2026 redesign review
([docs/design/2026-10-redesign-review.md](design/2026-10-redesign-review.md))
folds AI providers into this model behind one route and one SDK fetch, and the
Google design ([docs/design/2026-10-google-integration.md](design/2026-10-google-integration.md))
adds organization-held OAuth accounts under an operator-held client. Both were
re-aligned on 2026-10-16 with the hosted-platform research
(`docs/research/2026-10-hosted-platform/` on `research/hosted-platform`, PR
#299): in hosted, first-party apps share one Worker per app and third-party
apps get one Worker per organization on Workers for Platforms, and the gateway
learns the organization per call. Both documents were written when the
manifest key was `integrations` with `as` and `background` on each entry; read
them with this document's `capabilities` and `{ access, why }`.

## For an operator

Set the key once on the gateway:

```bash
pnpm everyapp secret set DATAFORSEO_API_KEY --for gateway
```

DataForSEO takes the API login and password, as `login:password` or the
base64 of it. The command redeploys the live gateway release with the key;
every app that lists DataForSEO can use it from then on.

| Capability   | Gateway secret       | Hosts the key may reach                        | Access |
| ------------ | -------------------- | ---------------------------------------------- | ------ |
| `dataforseo` | `DATAFORSEO_API_KEY` | `api.dataforseo.com`, `sandbox.dataforseo.com` | `read` |
| `context`    | `CONTEXT_API_KEY`    | `api.context.dev`                              | `read` |

`OPENROUTER_API_KEY` is set the same way and serves the AI proxy
(`/api/ai/openrouter`), beside `OPENAI_API_KEY`.

## For an app

List it in `everyapp.config.ts`:

```ts
capabilities: {
  dataforseo: {
    access: "read",
    why: "Keyword and SERP data for rank tracking.",
  },
},
```

`everyapp deploy` refuses a capability the gateway doesn't offer and an
access level it doesn't offer (`write`, for both providers today).

Call the provider's real URLs with the SDK's fetch:

```ts
import {
  gatewayRefusal,
  integrationFetch,
  integrationStatus,
} from "@every-app/sdk/server";

const dataforseo = integrationFetch({
  env,
  provider: "dataforseo",
  for: request,
});
const response = await dataforseo(
  "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
  {
    method: "POST",
    body: JSON.stringify([{ keyword: "seo tools", location_code: 2840 }]),
  },
);
// The gateway's own refusals, as opposed to DataForSEO's errors:
const refused = await gatewayRefusal(response);

// Show "the gateway's operator needs to set up DataForSEO" before a task fails:
const { ready } = await integrationStatus({ env, provider: "dataforseo" });
```

- Approval is of the app: listing the capability is the grant, for every
  call the app makes. Pass `for: request` and the gateway attributes the
  call to the request's user; for background work (crons, Workflows,
  queues) an organization's own app omits it (or passes
  `{ background: true }`) and the call is the app's. A shared app's Worker
  serves every organization, so its background work passes
  `for: { background: true, organizationId }`, sent as `x-everyapp-org`;
  the gateway accepts it for an active organization with a live member and
  attributes the call to that organization. A shared Worker's call that
  names neither throws `AttributionError`.
- In local dev (`everyapp dev`, no binding) the fetch calls the provider
  directly with the developer's own key from `.dev.vars`, under the same
  name as the gateway secret.

## What the gateway checks

`AppGateway` serves `/api/integrations/<capability>/<host>/<path>` over the
app's private binding (`apps/every-app-gateway/src/server/integration-proxy.ts`):

1. The caller is a registered, active app (the binding's props, as for AI).
2. Its registry row's manifest lists this capability; otherwise
   `capability_not_requested` (403).
3. The host is one of the provider's, over https, with no path that could
   leave it; otherwise `invalid_integration_route` (400).
4. The path isn't one that lists or describes the whole provider account
   (DataForSEO's `tasks_ready`, `id_list`, `errors`, `appendix/user_data`,
   `appendix/webhook_resend`): one key serves every app in every
   organization; otherwise `integration_path_not_allowed` (403).
5. The method is one the provider reads with; otherwise
   `integration_method_not_allowed` (405).
6. The gateway has a key; otherwise `integration_not_configured` (503), whose
   message names the secret and who sets it.

It then drops the app's `Authorization`, `x-api-key`, cookies and every
`x-everyapp-*` header, puts its own credential on the request, refuses to
follow redirects, and streams the body both ways. A provider it cannot reach
is `integration_upstream_failed` (502). Every call is logged
(`integration.proxy.call`) with the organization, app, path, status,
attribution, and DataForSEO's `cost` from the response. Refusals the gateway
makes, the AppGateway entrypoint's own included (`caller_not_registered`,
`invalid_gateway_route`, ...), carry their code in `x-everyapp-error` so an
app can tell them from the provider's own errors.

`GET /api/integrations/<capability>` answers
`{ capability, requested, configured, ready }` without calling the provider
(`integrationStatus`); `configured` is false for an app that doesn't list the
capability, so no app learns which keys the operator holds.

## Limits today

- One key per provider, shared by every app that lists it, with no spend
  caps. Whoever can deploy an app can list any capability, as for AI
  providers (deploying already takes credentials that can change the
  gateway).
- Calls are logged, not metered.
- The key lives in a gateway Worker secret, not encrypted in D1 with
  rotation in the UI, as the full design has it.
