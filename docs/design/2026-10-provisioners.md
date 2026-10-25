# Provisioners: every Cloudflare-native resource as one declared kind

Written 2026-10-24 for the launch on Monday 2026-10-27. Ben's mandate: "assume we want all of this and build the best, most robust thing we're going to want long term, so that when we launch on Monday people can just run with it and they're not waiting on us for PRs... so they're not waiting on us to support certain Cloudflare things." Scope he set: "we definitely want to support all of the Cloudflare-native things"; Neon or Turso Postgres "maybe too far unless you can do that through the Cloudflare CLI (Hyperdrive), in which case okay"; "I wonder if we should just use Alchemy for that; look at the alchemy thread; don't get too bogged down with all of these resources since the things we currently cover do cover a lot." This document is the contract the build lanes read: the interface, the kinds, what each does in a deploy, in `everyapp dev`, in `delete --purge`, in `status` and in the docs, the Alchemy decision, the tests, and the defaults chosen for Ben (also in TODO.md, "Provisioners (2026-10-24)").

**Scope change, 2026-10-24, later the same evening (Ben):** "Resource provisioners is the lowest priority of those. It doesn't need to be generic. As long as we support as much of Cloudflare's developer-platform surface area as possible, that's fine." So the registry interface of section 1 is **not built**; each kind lands in the shape the existing six use (a module per kind where that is the simplest path), as one small PR per kind so partial progress ships, in the order people will ask: Queues, Workers AI, Vectorize, AI Gateway, Hyperdrive (the Postgres answer), Browser Rendering, Email sending, Images, Analytics Engine, Secrets Store. Whatever is not green by Sunday evening 2026-10-26 waits. Section 2 (what each kind is, does and refuses) and the rules under it stay the contract; section 1 is kept below as the shape to grow into later, section 10 is the per-kind recipe the lanes follow.

## 0. Summary

Today the CLI provisions six kinds of Cloudflare resource for an app (D1, KV, R2, Durable Objects, Workflows, Hyperdrive) plus its helper Workers, each with its own code path spread over the manifest schema (`packages/perimeter/src/manifest/manifest.ts`), the SDK's Worker builder (`packages/sdk/src/cloudflare/worker.ts`), the deploy (`packages/cli/src/lib/app/resources.ts`, `buckets.ts`, `workflows.ts`), the install rewrite, the policy, the purge, the teardown and the docs. Adding a kind touches eleven places and three packages.

The plan before the scope change was **one module per kind in each of the three packages that must know it**, found through one registry per package, with a drift test that fails CI when a kind exists in one and not the others or is undocumented. The perimeter declares the kind (its manifest schema fragment and its naming rule), the SDK binds it (the production placeholder and the development shape), the CLI provisions it (`ensure`, `destroy`, `status`, the policy rule, the teardown listing, the docs text). Ten new kinds ride on it: Queues, Vectorize, Workers AI, AI Gateway, Browser Rendering, Images, Analytics Engine, Email sending, Secrets Store, and Hyperdrive as a declared resource whose origin is a required setting. Every kind's `ensure` goes through Cloudflare's `cf` CLI exactly as D1 does today, never Alchemy (section 6). Every deploy output the six existing kinds produce is pinned byte for byte before the refactor and stays identical after it (section 8).

## 1. The interface (deferred by the scope change; kept as the shape to grow into)

Three packages, one registry each, the same kind ids throughout. A kind id is the manifest key under `resources` (`d1`, `kv`, `r2`, `durableObjects`, `workflows`, `hyperdrive`, `queues`, `vectorize`, `ai`, `aiGateway`, `browser`, `images`, `analyticsEngine`, `sendEmail`, `secretsStore`), plus `worker` for the helper Workers the top-level `workers` field declares (the one kind whose schema is not under `resources`; it is in the CLI registry for claiming, purging and status, and in no other).

### 1.1 Perimeter: `declare`

`packages/perimeter/src/manifest/resources/<kind>.ts`, collected by `packages/perimeter/src/manifest/resources/index.ts` into `RESOURCE_KINDS` (an ordered, frozen list) and the two schemas the package already exports:

```ts
interface ResourceKindDeclaration<TEntry> {
  kind: ResourceKind;                      // "queues"
  label: { one: string; many: string };    // "Queue", "Queues"
  schema: z.ZodType<TEntry>;               // the tolerant entry schema (one array element)
  schemaStrict: z.ZodType<TEntry>;         // the strict one (binding names as identifiers, .strict())
  /** The binding name(s) an entry declares (one for every kind today). */
  bindingNames(entry: TEntry): string[];
  /** The account-wide name of the resource an entry stands for, from the app's Worker name. */
  nameFor(workerName: string, entry: TEntry): string | null;   // null for binding-only kinds
  /** Cloudflare's limit on that name, checked by validateManifestStrict once the Worker name is known. */
  maxNameLength?: number;
}
```

`ResourcesSchema` and `ResourcesSchemaStrict` are built from `RESOURCE_KINDS` (`z.object(Object.fromEntries(kinds.map(k => [k.kind, z.array(k.schema).optional()])))`, tolerant with `.passthrough()`, strict with `.strict()`), so the manifest's shape is the registry. `bindingNamesOf()` and the "declared twice" check iterate the registry instead of listing kinds. `manifestTierProblems()` (the dispatch tier) refuses every kind but `d1` and `durableObjects` with its existing sentence, from the registry's labels. The three naming helpers stay exported under their names (`resourceNameFor`, `bucketNameFor`, `workflowNameFor` moves here from the SDK and the SDK re-exports it); the general rule is `suffixedName`: `<worker>--<binding lowercased, _ as ->`, with the `DB`, `KV`, `R2` exceptions D1, KV and R2 keep.

### 1.2 SDK: `bind` and `dev`

`packages/sdk/src/cloudflare/resources/<kind>.ts`, collected by `packages/sdk/src/cloudflare/resources/index.ts` into `RESOURCE_BINDERS`:

```ts
interface ResourceBinder<TEntry> {
  kind: ResourceKind;
  /**
   * The bindings (and for class kinds the exports, for consumer kinds the triggers)
   * one of the app's Workers gets for an entry: `deploy` present means a production
   * build (placeholders from sentinelDeployTarget; the install rewrites them),
   * absent means development (local ids, `dev: { remote: true }` where Cloudflare
   * has no local emulation). `forWorker` is the helper Worker being built, or
   * undefined for the app's own; an entry's `worker` field decides which Workers
   * see it, as Hyperdrive's does today.
   */
  bind(entry: TEntry, ctx: BindContext): { env: Record<string, EveryAppBinding>; exports?: Exports; triggers?: Trigger[] };
  /** Which placeholder fields the install rewrites, by binding type (`installResource`). */
  placeholder?: { type: string; field: string };
}
```

`everyAppWorker()` and `everyAppAuxiliaryWorker()` call every binder in registry order, in place of `storageBindings`, `addDatabaseBindings` and `classBindings` (whose bodies move into the six binders unchanged). The typed `Env` (`EveryAppDeployEnv<M>`, `EveryAppDevEnv<M>`) gains one conditional type per new kind beside `D1Names<M>`, so `cf workers types` types `env.JOBS` as `Queue`, `env.AI` as `Ai`, `env.VECTORS` as `VectorizeIndex`, and so on, with `@cloudflare/config`'s structural shapes copied into `worker.ts` the way `D1Binding` is. `sentinelDeployTarget()` and `EveryAppDeployTarget.resources` gain one record per kind that the deploy provisions (section 2 says which).

### 1.3 CLI: `ensure`, `destroy`, `status`, policy, teardown, docs

`packages/cli/src/lib/provisioners/<kind>.ts`, collected by `packages/cli/src/lib/provisioners/index.ts` into `PROVISIONERS`, keyed by kind:

```ts
interface Provisioner<TEntry, TProvisioned> {
  kind: ResourceKind;
  declaration: ResourceKindDeclaration<TEntry>;   // the perimeter's, re-exported for one import
  /** What the deploy must do before the build is installed; absent for binding-only kinds. */
  ensure?(ctx: ProvisionContext, entry: TEntry): Promise<TProvisioned>;
  /** The ledger kind this resource is recorded under (ownership.ts), or null for binding-only and name-only kinds. */
  ledgerKind: LedgerKind | null;
  /** Delete one recorded resource (`delete --purge`, the teardown); absent when nothing is made. */
  destroy?(ctx: DestroyContext, recorded: OwnedResource): Promise<void>;
  /** The account's resources of this kind that look like ours (`every-*`), for the teardown's inventory. */
  inventory?(cf: CfRunner): Promise<Array<{ name: string; id: string }>>;
  /** One short phrase for `everyapp status`'s RESOURCES cell and `data.apps[].resources`: "2 queues", "Vectorize". */
  status(entries: TEntry[]): string;
  /** The policy's judgement of one built binding (or trigger) of this kind's type(s). */
  policy: {
    bindingTypes: string[];                       // the @cloudflare/config `type` values this kind owns
    triggerTypes?: string[];
    problem(binding: Binding, inputs: PolicyInputs, name: string): string | null;
    triggerProblem?(trigger: Trigger, inputs: PolicyInputs): string | null;
  };
  /** What `everyapp dev` does for it: nothing, seed something, or say it is remote. */
  dev: { mode: "local" | "remote" | "none"; note: string; seed?(ctx: DevContext, entry: TEntry): Promise<void> };
  /** The generated documentation (section 7). Every field is required; the drift test fails on an empty one. */
  docs: ResourceDocs;
}
```

`ProvisionContext` is what `provisionAppResources` passes today: `cf`, `gatewayDb` (the ledger), the registration (`workerName`, the assigned names), the app's `.everyapp/secrets.env` values, `accountId`, and the three callbacks (`onCreated`, `onRecreated`, `onChanged`). The ledger pattern (`provisionOne` and `createClaimed` in `lib/app/resources.ts`) becomes `ensureRecorded(ctx, { kind, binding, name, find, create })`, which every ledger kind calls; Hyperdrive's adopt-when-the-origin-matches and reconcile stay its own, as today. `provisionAppResources` becomes a loop over `PROVISIONERS` in registry order, assembling `InstallTarget.resources`. `prepareAppBuildOutput` (policy.ts) looks each binding's `type` up in the registry (`ALLOWED_BINDINGS` is derived) and each trigger's type too. `purgeApp` (delete) and the teardown's inventory and delete call `destroy` and `inventory` per kind; `KINDS` in `lib/teardown/plan.ts` is derived from the registry plus the non-resource kinds (access, email, workers, certificates, dns). `everyapp status` adds a RESOURCES cell per app from the stored manifest and the registry (`status(entries)` joined with ", "), and `data.apps[].resources` as `[{ kind, binding, name }]`.

The fake Cloudflare account (`packages/cli/src/test/fakeCloudflare.ts`) learns each new kind's `cf` commands as the lane adds the kind, in the style of `r2Command` and `hyperdriveCommand`.

## 2. The kinds

For every kind: the manifest entry, the account-wide name, the binding in production and in development, what `ensure` does, what the ledger records, what `delete --purge` and `teardown` delete, what the policy allows, and what `everyapp dev` does. `W` is the app's Worker name (`every-<orgKey>-<appId>`), `B` the binding, `suffix(B)` the binding lowercased with `_` as `-`. "Ledger" means the ownership model of D1 (`resources.ledger-is-ownership`): an existing resource under the app's name is used only when the ledger records it as the app's; otherwise `RESOURCE_NAME_TAKEN`; a new one is recorded before it is created. "Named" means R2's model (#611): the name is the app's by convention, an existing one is bound as it is, never recorded, never purged.

| Kind | Manifest entry (strict) | Name | Binding (production) | `ensure` through `cf` | Ownership | Purge and teardown | Development |
|---|---|---|---|---|---|---|---|
| `d1` | `"DB"` | `W` for `DB`, else `W--suffix(B)` | `{ type: "d1", name, id }` | `d1 list`, `d1 create` (unchanged) | ledger | `d1 delete` | local, fixed id (`localD1Id`) |
| `kv` | `"KV"` | `W` for `KV`, else `W--suffix(B)` | `{ type: "kv", id }` | `kv namespaces list`, `create` (unchanged) | ledger | `kv namespaces delete` | local |
| `r2` | `"R2"` | `W` for `R2`, else `W--suffix(B)` | `{ type: "r2", name }` | `r2 buckets list`, `create` after the build is installed (unchanged, #611) | named | kept (unchanged) | local |
| `durableObjects` | `{ name, className, worker? }` | the class, on its Worker | `{ type: "durable-object", worker, exportName }` + the export | none (cf creates the class with the upload) | with the Worker | with the Worker | local |
| `workflows` | `{ name, className, worker? }` | `W--suffix(B)` (max 64) | `{ type: "workflow", name, worker, exportName }` + the export | none; `assertOwnWorkflows` before the upload (unchanged) | with the Worker | `workflows delete` (unchanged) | local |
| `hyperdrive` | `{ name, worker?, caching? }` | `W--suffix(B)` | `{ type: "hyperdrive", id }` | `hyperdrive list`, `create`, `update` from `<B>_ORIGIN_URL` in `.everyapp/secrets.env` (unchanged); the origin is the required setting: without it the deploy stops with `HYPERDRIVE_ORIGIN_MISSING`, which names the variable and the file, and `status` says the app needs it | ledger, adopt when the origin matches | `hyperdrive delete` | `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<B>` in `.dev.vars`, else absent |
| `queues` | `{ name, consumer?: true \| { worker?, maxBatchSize?, maxBatchTimeout?, maxRetries?, maxConcurrency?, retryDelay?, deadLetterQueue? } }` | `W--suffix(B)` (max 63) | producer `{ type: "queue", name }` on every Worker of the app; with `consumer`, a trigger `{ type: "queue", name, ...settings }` on the consuming Worker (the app's own, or the helper `worker` names); `deadLetterQueue` is another queue binding of the app's, resolved to its name | `queues list` (by `queue_name`), `queues create --queue-name`; the consumer: cf's upload publishes the trigger (the lane verifies live; if cf does not, `queues consumers create <id> --script-name --type worker` after the upload, in the provisioner's `afterUpload`) | ledger (`queue_id`) | `queues delete <id> --force` | local (Miniflare); producer and consumer both |
| `vectorize` | `{ name, dimensions, metric }` or `{ name, preset }` | `W--suffix(B)` (max 64) | `{ type: "vectorize", name }` | `vectorize get <name>` (not found → `vectorize create --name --config-dimensions --config-metric` or `--config-preset`); an index of the name whose dimensions or metric differ from the manifest is `VECTORIZE_CONFIG_MISMATCH` (an index can't be reshaped: rename the binding) | ledger (the name) | `vectorize delete <name> --force` | remote (`dev: { remote: true }`; needs `cf auth login`; the ready block says so) |
| `ai` | `"AI"` | none | `{ type: "ai" }` | none (account-wide; Workers Paid) | none | nothing | remote by Cloudflare's own default (the binding calls the account's Workers AI; needs a login); the ready block says so |
| `aiGateway` | `{ name, collectLogs?, cacheTtl? }` | `W--suffix(B)` as the gateway id (max 64) | `{ type: "json", value: { id, accountId, url } }` with `url` = `https://gateway.ai.cloudflare.com/v1/<accountId>/<id>`; the install rewrites a `json` binding whose `value.id` is the binding's placeholder | `ai-gateway gateways get <id>` (not found → `create --id` with `--collect-logs` and `--cache-ttl` as declared); the library (`lib/cf/aiGateway.ts`: `findAiGateway`, `ensureAiGateway`, `deleteAiGateway`) is also what the Model providers thread calls for the Gateway's own `everyapp` gateway and `AI_GATEWAY_ID` (agreed 2026-10-24; that thread writes the setting) | ledger (the id) | `ai-gateway gateways delete <id>` | present with `url: ""` and `accountId: ""` (no gateway in development: an app treats an empty `url` as "call the provider directly") |
| `browser` | `"BROWSER"` | none | `{ type: "browser" }` | none (Workers Paid) | none | nothing | remote (`dev: { remote: true }`) |
| `images` | `"IMAGES"` | none | `{ type: "images" }` | none | none | nothing | local (Miniflare) |
| `analyticsEngine` | `{ name, dataset? }` | `dataset`, else `W--suffix(B)` | `{ type: "analytics-engine-dataset", name }` | none (a dataset exists once written to) | none | nothing (Cloudflare has no delete; data expires after 90 days) | local (Miniflare's no-op) |
| `sendEmail` | `{ name, allowedSenderAddresses?, destinationAddress?, allowedDestinationAddresses? }` | none | `{ type: "send-email", ...the lists }` | none; the sender addresses must be on a domain whose Email Routing is on, which is the operator's (`everyapp email set --sender` documents the Gateway path; this binding is Cloudflare's native one, for `message.reply()` from an inbound handler and apps that want the binding) | none | nothing | local (Miniflare logs the message) |
| `secretsStore` | `{ name }` | `W--suffix(B)` as the secret's name, in the account's store | `{ type: "secrets-store-secret", storeId, secretName }` | `secrets-store stores list` (no store → `SECRETS_STORE_MISSING`: cf 1.0.0-beta.14 has no `stores create`, so the person makes one once in the dashboard); `secrets list --store-id --search <name>` (missing → `secrets create <store> --body @file` with `[{ name, value, scopes: ["workers"] }]`, the value from `<B>` in `.everyapp/secrets.env`, never argv; no value → `SECRETS_STORE_VALUE_MISSING`); an existing secret of the name recorded as the app's is bound as it is (its value changes in the dashboard, or with `everyapp secret set <B>` once the follow-up routes it there) | ledger (`<storeId>/<secretId>`) | `secrets-store secrets delete <id> --store-id --force` | the same binding shape; `everyapp dev` seeds the local store from `<B>` in `.dev.vars` with `cf secrets-store secrets create --local` (the lane verifies; the fallback is a documented `cf` command the ready block prints) |
| `worker` (helpers) | top-level `workers: [{ name, binding?, limits? }]` | `W--<name>` | `{ type: "worker", worker }` from the app's Worker | `claimAppWorker` (unchanged) | ledger | `workers delete` (unchanged) | local |

Rules that hold for every kind:

- **Names are the app's.** Every account-wide name carries the Worker name and the `--` separator, so the policy's `isOwnResourceName` holds for the new kinds as it does for R2 and Workflows, and the teardown's `every-*` scan finds them.
- **Ledger kinds follow D1, not R2.** A queue holds messages, an index vectors, a gateway logs, a store secret a credential: binding one the app didn't create would hand it someone else's data. So `RESOURCE_NAME_TAKEN` on a name that exists unrecorded, `RESOURCE_REPLACED` when the recorded one was deleted and another took the name, and the claim-before-create retry rule. The brief's "create-or-adopt like R2" is kept only for R2, whose bucket model #611 settled. This is a default for Ben (section 9).
- **Binding-only kinds are allowed only when declared.** The policy refuses an `ai`, `browser`, `images`, `send-email` or `analytics-engine-dataset` binding that `everyapp.config.ts` doesn't declare under `resources`, by binding name, so a `cloudflare.config.ts` can't quietly add account-wide capabilities (today's `policy.binding-allowlist` reason). A `queue` or `vectorize` binding must name a provisioned resource; a `queue` trigger must name one of the app's own queues, its dead-letter queue too; a `secrets-store-secret` binding must be the provisioned `storeId` and `secretName`.
- **Every Worker of the app gets the storage and producer bindings** (D1, KV, R2, Hyperdrive without `worker`, queue producers, Vectorize, AI, AI Gateway, Browser, Images, Analytics Engine, Email sending, Secrets Store); classes, consumer triggers and Hyperdrive with `worker` go to the Worker named. The helper Worker policy is the app Worker policy minus the service bindings, as today.
- **Secret values never touch argv.** Secrets Store values travel in a private temp file (`--body @file`), as Hyperdrive's origin does. Nothing a provisioner logs or records carries a value.
- **The hosted deployer refuses what it can't make.** The Gateway's own deployer (browser installs, the deploy API; `apps/every-app-gateway/src/server/deploy/metadata.ts`) refuses a manifest with any of the new kinds in the sentence it uses for R2 and Hyperdrive ("which the browser deployer can't provision; use the CLI"), from the registry's labels; its bundle allowlist already refuses the binding types. Teaching it the kinds is a follow-up.
- **Dispatch tier** (`manifestTierProblems`): every new kind is refused there, as Hyperdrive and R2 are.

## 3. Deploy order

Unchanged in shape; the resources step runs the provisioners in registry order under the app's lease: Workers claimed; D1, KV, Hyperdrive, Queues, Vectorize, AI Gateway and Secrets Store ensured (each recorded first); the build installed with their names and ids; R2 buckets made from the installed bindings (#611); the policy checked; Workflows' names checked; migrations; the uploads (helpers first); then the provisioners' `afterUpload` hooks (today none; a queue consumer if cf's upload doesn't publish the trigger); then Workflows dropped, mail routes, the registry record. A deploy that stops before the upload leaves what it created recorded and finds it again on the retry, as today.

## 4. `everyapp dev`

No new flags. The SDK's binders give each kind its development shape (section 2's last column). `everyapp dev`'s ready block gains one line when the manifest declares a remote kind: `Remote bindings: AI, VECTORS (they reach your Cloudflare account; run cf auth login once)`, and one when a Secrets Store binding has no local value: the `cf secrets-store secrets create --local` line to run. `dev.md` documents every kind's development behaviour from the generated block (section 7).

## 5. `everyapp status`, `delete --purge`, `teardown`

- `status`: a RESOURCES cell per app (`D1, KV, 2 queues, Vectorize, AI`), from the stored manifest, no Cloudflare calls; `data.apps[].resources` for scripts. A Hyperdrive app whose origin was never given shows nothing new here: the deploy refused it.
- `delete --purge`: deletes every recorded resource of every ledger kind in registry order after the Workers, keeps the named ones (R2) and says so, as today; `RESOURCES_KEPT` lists what has the app's names unrecorded, now for every kind with an `inventory`.
- `teardown`: inventories every kind with an `inventory` by the `every-` prefix (queues by `queue_name`, Vectorize by index name, AI Gateways by id with `--search every-`, Secrets Store secrets by name with `--search every-` in every store) and deletes them in `KINDS` order after the Workers; the plan's `data.plan` gains the kinds.

## 6. Alchemy or `cf`: the decision

**Provisioners call `cf` through the CLI's `CfRunner`, never Alchemy, and not a REST client of their own.** The brief's "cf-rest" is the Gateway's in-Worker client (`apps/every-app-gateway/src/server/deploy/cf-rest/`), which exists because a Worker has no Node to spawn `cf` and which the CLI can't import; the CLI's one way to Cloudflare is `cf` (`lib/cf/runner.ts`: the pinned binary, the private directories, the token through the environment, the watchdog, the error taxonomy), and every kind here has a `cf` command for what it needs on cf 1.0.0-beta.14 (checked 2026-10-24: `queues create|list|get|delete`, `queues consumers create|list`, `vectorize create|get|list|delete`, `ai-gateway gateways create|get|list|delete`, `secrets-store stores list`, `secrets-store secrets create|list|get|delete`), except `secrets-store stores create`, so a store is the person's to make once, as R2 is to enable. Alchemy is not used because, per [the assessment](2026-10-alchemy-research.md) (#657), its Worker provider replaces the whole binding set on every upload (the secrets `everyapp secret set` puts on a Worker, and the Gateway's keypair, would go), its service-binding props arrive snake-cased (`appId` as `app_id`, which `AppGateway` refuses), and it adopts D1, KV, R2 and Hyperdrive by name against `resources.ledger-is-ownership`; wrapping `cf queues create` in an Alchemy resource would pull Effect and 87 packages into the CLI for nothing. Flip: the assessment's T1 to T3 together on its dates (2026-12-01, 2027-02-01), or three kinds without a working `cf` command (today one); then a thin REST client behind the same seam and fake for those kinds, still not Alchemy.

## 7. Docs

Hand-written, held by the drift tests that exist (`packages/cli/src/docs/agentDocs.test.ts`: every manifest field and enum value from the strict schema must appear in `manifest.md`; every error and warning code in `errors.md`; `repoDocs.test.ts`: every cited path exists; the patterns page is generated from the skill's `patterns.md`). Each kind's PR adds, in the same PR: its rows in `manifest.md` (`## resources`'s table and a subsection with an example, the name rule, the binding, what the deploy does and what `delete --purge` does), `deploy.md`'s `app.resources` table, `dev.md`'s development behaviour, `errors.md` for its codes, one row in the build skill's `patterns.md` under a "Cloudflare resources" section (then `pnpm -C packages/cli docs:update` for the generated patterns page), and `docs/threat-model.md` B7 plus `docs/threat-model-invariants.md` for the policy rule it adds. The page for people (`landing-page/content/docs/resources.mdx`: what you can declare, what the deploy makes, what costs money, the Postgres answer through Hyperdrive, Turso as an app secret) comes once the first kinds are on main.

## 8. Tests

- **The pin, before the refactor** (`packages/cli/src/commands/deploy/deployApp.pinned.test.ts`): the six kinds' deploys through the fake account (the todo app with D1, KV and a Durable Object; the same with a Workflow; Postiz with a helper Worker, R2 and a Workflow; agentic-inbox; the Hyperdrive app of `deployApp.hyperdrive.test.ts`): the NDJSON events, every uploaded `worker.config.json`, the cf calls in order and the ledger rows, as file snapshots generated on main before any provisioner code exists. Every kind PR leaves the snapshots unchanged (the six kinds' output is the pin; a kind PR that changes it is wrong). The pattern is the provider registry's `provider-migration.test.ts`: literals captured before, never derived after.
- **Per kind, offline**: the fake account answers the kind's `cf` commands; a deploy of a starter-sized manifest declaring the kind produces the binding, records the ledger row, is idempotent on a redeploy, refuses a name taken unrecorded, purges on `delete --purge`, and the policy refuses the binding when undeclared or misnamed.
- **Per kind, live** (`packages/cli/test/provisioners/`, run with `EVERYAPP_LIVE_PROVISIONERS=1`, skipped otherwise, never in CI): against test account loop-1 only. The account file `~/.config/everyapp/onboarding-loop/accounts.json` is read in-process (mode 600, the loop's parser rules), the token goes only into the child `cf`'s environment, never printed, and the suite refuses to run unless `cf auth whoami` with that environment reports the token as its source and exactly one account whose id is not on the forbidden list. For each kind: `ensure` creates, `ensure` again creates nothing, a prebuilt Worker named `every-provisioners-<kind>` binding the resource uploads through `cfDeploy` and its settings read back show the binding, `destroy` deletes it, the Worker is deleted. Hyperdrive is the exception (its create needs a reachable Postgres; none on loop-1; a default for Ben). Results and the token permissions each kind needed go into `docs/runbooks/onboarding-loop-test-accounts.md`'s table.
- **End to end**: once the kinds are on main, one app declaring every kind deploys to a Gateway on loop-1 through `everyapp deploy` and is removed with `delete --purge`, then the account's teardown finds nothing of it; recorded in the runbook's live facts.

## 9. Defaults for Ben (also in TODO.md)

- **Ledger, not adopt, for queues, Vectorize, AI Gateways and store secrets** (section 2). Walk-back: an `adopt: true` per entry, recorded on first use.
- **Binding-only kinds must be declared in the manifest** before the policy lets the binding through. Walk-back: allow `ai`, `browser`, `images` by binding type alone.
- **A Secrets Store is the person's to make once** (cf has no create). Walk-back: a REST call for that one endpoint (section 6, T9).
- **AI Gateway binds as a `json` of `{ id, accountId, url }`**, not a text URL. Walk-back: a text binding with the URL.
- **Email sending is a binding beside the Gateway's email capability**, not instead of it; the docs point to the capability first.
- **Hyperdrive's origin stays in `.everyapp/secrets.env`** on the deploying machine and is the required setting the deploy stops on; `everyapp configure` doesn't write it (follow-up).
- **No Hyperdrive live test** (no Postgres on loop-1). Walk-back: a Neon free database for the loop account, its URL in `providers.env`.
- **The hosted deployer refuses the new kinds** (section 2's rules); teaching it is a follow-up.
- **`cf`, not Alchemy and not a REST client** (section 6).

## 10. Lanes and order (after the scope change)

One PR per kind, in Ben's order: queues, ai, vectorize, aiGateway, hyperdrive (the required-setting wording and the Postgres docs), browser, sendEmail, images, analyticsEngine, secretsStore. Each lane works in its own worktree from main, merges main before its last push, resolves the additive conflicts in the shared files itself, and merges its PR on green. The recipe, in the shape the existing six use:

1. **Perimeter** (`packages/perimeter/src/manifest/manifest.ts`): the entry schema in `ResourcesSchema` (tolerant) and `ResourcesSchemaStrict` (binding names as identifiers, `.strict()`), the binding names in `bindingNamesOf()` and the declared-twice check, the kind in `manifestTierProblems()` (refused on the dispatch tier), the name rule beside `bucketNameFor` when the kind has an account-wide name, with its length limit; `manifest.test.ts` cases.
2. **SDK** (`packages/sdk/src/cloudflare/worker.ts`, `sentinel.ts`): the binding interface (a structural copy of `@cloudflare/config`'s), the manifest field on `EveryAppWorkerManifest`, the bindings in production (placeholders from `sentinelDeployTarget` for anything the deploy provisions) and in development (section 2's last column), on the app's Worker and on helpers as the kind's rule says, the typed `Env` conditional beside `D1Names<M>`; `worker.test.ts` cases. Every existing export keeps its name: apps pinned to 0.3.0-rc.1 keep building.
3. **CLI**: `packages/cli/src/lib/cf/<kind>.ts` (the `cf` calls, with their output shapes in `lib/cf/schemas.ts` and any new error kind in `lib/cf/errors.ts`), `lib/app/resources.ts` (`provisionAppResources`: the kind's `ensure`, through `provisionOne`/`createClaimed` for a ledger kind, with the kind added to `ownership.ts`'s `ResourceKind` and `RESOURCE_LABELS`), `lib/app/installBuildOutput.ts` (its placeholder, when the deploy provisions it), `lib/app/policy.ts` (its binding and trigger types, allowed as section 2 says), `commands/delete/index.ts` (`purgeApp`: its delete), `lib/teardown/{inventory,plan,delete}.ts` (its listing by `every-`, its `KINDS` entry and `PLACES` line), `commands/status` (the RESOURCES cell is a one-time addition the first lane makes: a count per kind from the stored manifest; later lanes add their kind to it), `commands/dev` (the ready block's remote-bindings line, the first lane that needs it), `src/test/fakeCloudflare.ts` (the kind's `cf` commands, as `r2Command` and `hyperdriveCommand`), tests: a deployApp test file for the kind (`deployApp.<kind>.test.ts`: provision, bind, idempotent redeploy, name taken, purge, policy refusals), the pin unchanged.
4. **Live** (`packages/cli/test/provisioners/<kind>.live.test.ts`, section 8's rules): ensure twice, a prebuilt Worker upload binding it, read-back, destroy.
5. **Docs** (section 7) and the threat-model rows, in the same PR.
