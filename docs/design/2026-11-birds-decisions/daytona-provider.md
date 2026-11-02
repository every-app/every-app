# `daytona` catalog entry: assumptions (Agent-assumed, pending Ben's review)

Branch `birds/daytona-provider`, off main at `1f4382df`. The source is §1.12 of `docs/design/2026-11-birds-forcing-function.md` (on `birds-forcing-function`) and its entry in `docs/design/2026-11-birds-decisions/forcing-function.md` (on `birds/decisions-forcing-function`).

Every entry below is **Agent-assumed, pending Ben's review**.

## What landed

- A `daytona` API-key entry in `packages/sdk/src/internal/catalog/infra.ts`:
  - bearer `DAYTONA_API_KEY` on `app.daytona.io`;
  - `data: "account"`, so a hosted Gateway refuses it;
  - read and write;
  - `accountWidePaths`.
- A guide and category in `packages/cli/src/docs/providerGuides.ts`.
- The generated docs (`pnpm -C packages/cli docs:update`, plus `capabilitiesDoc` with `UPDATE_DOCS`): `docs/capabilities.md`, `providers.md`, `secrets.md`, `docs/providers/daytona.mdx`, the index and `meta.json`, the skill's `setup/providers.md`, and `catalogSettings.generated.ts`.
- Tests:
  - an SDK shape and path test in `capabilities.test.ts`;
  - the Gateway proxy in `integration-proxy.test.ts`: sandbox calls are served with the bearer, a hosted Gateway refuses with `integration_not_available_hosted`, account-wide paths get 403 `integration_path_not_allowed`, and the sandbox, snapshot and volume reads are served.

## Assumptions

1. **The host is `app.daytona.io`, and every path is under `/api`.** Verified 2026-11-01 from Daytona's docs:
   - every example uses `https://app.daytona.io/api` with `Authorization: Bearer <key>`;
   - the OpenAPI spec (`daytona.io/docs/openapi.json`) lists the paths, but its `servers` entry is `localhost`.

   The entry has no `hostSetting`, so a self-hosted Daytona isn't covered.
2. **The control plane only.**
   - The toolbox (exec, files) and preview URLs (`<port>-<id>.proxy.daytona.works`) are not hosts of this entry, as the brief says.
   - `GET /api/sandbox/{id}/ports/{port}/preview-url` and `signed-preview-url` are served, because they are per-sandbox control calls that return a URL. The traffic to that URL stays outside the Gateway.
3. **The account-wide paths (the one Ben should read most closely).** Matched as segments anywhere in the path, as the catalog does. Refused:
   - `organizations` and `organization`: members, roles, invitations, SSO, usage and spend, the organization's settings, and `/sandbox/{id}/organization`;
   - `billing`: not in the current spec, refused in case Daytona adds it;
   - `api-keys` and `users`;
   - `audit`;
   - `webhooks`: they would send every sandbox event to a URL the app picks, as with Granola;
   - `secret`: the organization's secret store;
   - `docker-registry` and `object-storage`: credentials and push access;
   - `regions`: these regenerate proxy, SSH-gateway and snapshot-manager keys. `shared-regions` is still served;
   - `runners`, `for-runner`, `jobs` and `warm-pools`: the organization's infrastructure;
   - `preview`: the preview proxy's own token checks;
   - `ssh-access/validate`.

   Served: `sandbox/*`, including `/sandbox/{id}/secrets`, which mounts organization secrets into a sandbox. That is gated by Daytona's `write:sandboxes`, and it's part of creating a working sandbox. Also served: `snapshots`, `volumes` and `config`.
4. **The methods:**
   - read is GET and HEAD;
   - write is POST, PUT, PATCH and DELETE (start, stop, create and delete are POSTs and DELETEs).
5. **The smoke check is `GET /api/sandbox`.** Daytona's docs say every key may read sandboxes. It lists the whole organization's sandboxes. That is account-wide in spirit, but it can't be refused: Birds needs the list, filtered by labels.
6. **The key-permission advice in the hint and guide:**
   - grant `write:sandboxes`/`delete:sandboxes` and the snapshot or volume permissions only as needed;
   - never `manage:api_keys`, `manage:secrets`, `manage:billing`, or the region or runner permissions.

   The guide also says to give the Gateway its own Daytona organization. Daytona's docs say any key of an organization reaches every running sandbox in it through the toolbox, whatever its permissions.
7. **Not recorded:** rate limits and cost. Daytona's limits page isn't specific enough to cite.
8. **The key's prefix isn't stated.** Daytona's docs don't name one, so the hint doesn't either.
