import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { DEV_ISSUER, DEV_ORG_ID, DEV_PUBLIC_KEY_PEM } from "../dev/keypair.js";
// The catalog's settings, generated from ../internal/capabilities.ts, which
// this file must not import (see ./index.ts: the Vite plugin hides whatever
// cloudflare.config.ts imports from the Worker).
import { DEV_GATEWAY_KEYS } from "./catalogSettings.generated.js";
import {
  sentinelDeployTarget,
  type AiGatewayValue,
  type EveryAppDeployTarget,
} from "./sentinel.js";

/** A Durable Object or Workflow class, and the helper Worker defining it. */
interface ClassResource {
  readonly name: string;
  readonly className: string;
  /** A helper Worker (`workers`) that defines the class; the app's own when unset. */
  readonly worker?: string;
}

/** A Hyperdrive config, and the helper Worker that alone binds it. */
interface HyperdriveResource {
  readonly name: string;
  /** A helper Worker (`workers`) that alone binds it; every Worker when unset. */
  readonly worker?: string;
  /** Whether Hyperdrive caches its reads (the deploy's concern; "off" by default). */
  readonly caching?: "off" | "default";
}

/**
 * How a queue's consumer takes its messages (`@cloudflare/config`'s
 * `QueueConsumerTriggerOptions` but the name), and the helper Worker that
 * consumes, when not the app's own.
 */
interface QueueConsumerSettings {
  /** A helper Worker (`workers`) that consumes; the app's own when unset. */
  readonly worker?: string;
  readonly maxBatchSize?: number;
  readonly maxBatchTimeout?: number;
  readonly maxRetries?: number;
  readonly maxConcurrency?: number | null;
  readonly retryDelay?: number;
  readonly visibilityTimeoutMs?: number;
  /** Another of the manifest's queue bindings, which takes the messages that ran out of retries. */
  readonly deadLetterQueue?: string;
}

/** A queue every Worker of the app produces to, and the Worker that consumes it. */
interface QueueResource {
  readonly name: string;
  /** `true`: the app's own Worker consumes; settings, maybe naming a helper Worker. */
  readonly consumer?: true | QueueConsumerSettings;
}

/**
 * A Vectorize index: `dimensions` and `metric`, or a `preset` (the
 * deploy's concern; the Worker only binds it by name).
 */
interface VectorizeResource {
  readonly name: string;
  readonly dimensions?: number;
  readonly metric?: string;
  readonly preset?: string;
}
/** An AI Gateway of the app's own, which every one of its Workers binds. */
interface AiGatewayResource {
  readonly name: string;
  /** Whether the gateway logs each request (the deploy's concern; on by default). */
  readonly collectLogs?: boolean;
  /** How long the gateway caches a response, in seconds (the deploy's concern; 0 by default). */
  readonly cacheTtl?: number;
}

/**
 * A Cloudflare `send_email` binding and the addresses it may use: the
 * senders, and one destination or a list of them (never both).
 */
interface SendEmailResource {
  readonly name: string;
  readonly allowedSenderAddresses?: readonly string[];
  readonly destinationAddress?: string;
  readonly allowedDestinationAddresses?: readonly string[];
}

/** An Analytics Engine dataset, by binding, and its name when not the default. */
interface AnalyticsEngineResource {
  readonly name: string;
  readonly dataset?: string;
}

/** Cloudflare's limits for one of the app's Workers. */
interface WorkerLimits {
  readonly cpuMs?: number;
}

/** The fields of `everyapp.config.ts` the Worker definition is built from. */
export interface EveryAppWorkerManifest {
  id: string;
  compatibilityDate?: string;
  resources?: {
    d1?: readonly string[];
    kv?: readonly string[];
    /**
     * R2 buckets every one of the app's Workers binds: `R2` named after the
     * app's Worker, any other binding `<app worker>--<binding>`.
     */
    r2?: readonly string[];
    durableObjects?: readonly ClassResource[];
    workflows?: readonly ClassResource[];
    /** Hyperdrive configs, named `<app worker>--<binding>` by the deploy. */
    hyperdrive?: readonly HyperdriveResource[];
    /**
     * Cloudflare Queues, named `<app worker>--<binding>`: every Worker of
     * the app binds each one to produce, and the consumer's Worker gets
     * its trigger.
     */
    queues?: readonly QueueResource[];
    /**
     * Workers AI, by binding (`["AI"]`), which every one of the app's
     * Workers binds: nothing to create, billed to the account. In
     * development it reaches the account only once the app's Vite config
     * turns `remoteBindings` on (see {@link AiBinding}).
     */
    ai?: readonly string[];
    /**
     * Browser Rendering, by binding (`["BROWSER"]`), which every one of the
     * app's Workers binds: nothing to create (Workers Paid). Local in
     * development (see {@link BrowserBinding}).
     */
    browser?: readonly string[];
    /**
     * Cloudflare Images, by binding (`["IMAGES"]`), which every one of the
     * app's Workers binds: nothing to create. Local in development (see
     * {@link ImagesBinding}).
     */
    images?: readonly string[];
    /**
     * Vectorize indexes every one of the app's Workers binds, named
     * `<app worker>--<binding>`. Cloudflare has no local Vectorize: in
     * development each binding reaches the account's index (`dev.remote`),
     * once the Vite plugin's `remoteBindings` is on and `cf auth login` ran.
     */
    vectorize?: readonly VectorizeResource[];
    /**
     * AI Gateways of the app's own, each `<app worker>-<binding>` in the
     * account, bound on every Worker as `{ id, accountId, url }`.
     */
    aiGateway?: readonly AiGatewayResource[];
    /**
     * Cloudflare `send_email` bindings every one of the app's Workers
     * gets, with their addresses; nothing is made in the account.
     */
    sendEmail?: readonly SendEmailResource[];
    /**
     * Secrets Store secrets, by binding (`[{ name: "STRIPE_KEY" }]`), which
     * every one of the app's Workers binds: each a secret in the account's
     * store named `<app worker>--<binding>`, made by the deploy (see
     * {@link SecretsStoreSecretBinding}).
     */
    secretsStore?: readonly { readonly name: string }[];
    /**
     * Analytics Engine datasets every one of the app's Workers writes to, by
     * binding: `dataset` as written, else `<app worker>--<binding>`.
     * Nothing to create; `writeDataPoint()` does nothing in development.
     */
    analyticsEngine?: readonly AnalyticsEngineResource[];
  };
  /**
   * Helper Workers deployed beside the app's Worker as
   * `<app worker>--<name>`, built with {@link everyAppAuxiliaryWorker}.
   * `binding` names the app Worker's service binding to one.
   */
  workers?: readonly {
    readonly name: string;
    readonly binding?: string;
    readonly limits?: WorkerLimits;
  }[];
  /**
   * The database the app's code talks to, which its Workers read as
   * DATABASE_PROVIDER; deployed Workers run near `region`.
   */
  database?: { readonly provider: "d1" | "postgres"; readonly region?: string };
  /** Cloudflare's limits for the app's own Worker. */
  limits?: WorkerLimits;
  /**
   * AI providers the app calls through the gateway (`createGatewayFetch()`):
   * each by id, or as `{ id, optional, anyOf, why, docs }` (the manifest's
   * settings model, `@every-app/sdk/internal` appSettings).
   */
  providers?: ReadonlyArray<string | { readonly id: string }>;
  /** Capabilities the app calls through the gateway (`integrationFetch()`). */
  capabilities?: { readonly [id: string]: unknown };
  /**
   * The app's own secrets, e.g. an API key it calls out with. A deployed
   * Worker gets them from `everyapp secret set <NAME>`, and later deploys
   * keep them, so production builds don't declare them. In development each
   * one that is set locally is declared, read as the Vite plugin reads
   * secrets (`.dev.vars[.<mode>]` alone when present, otherwise the `.env`
   * files and the environment), so the plugin passes it through. Type them
   * as optional in `src/env.d.ts`.
   *
   * The keys of `providers` and `capabilities` need no listing: there's no
   * gateway in development, so each one set locally under the gateway
   * secret's name (OPENAI_API_KEY, DATAFORSEO_API_KEY, …) is declared for
   * the SDK's direct fallback.
   *
   * Each by name, or as `{ name, optional, anyOf, why, docs }`: whether the
   * app opens without it, and why it is needed.
   */
  secrets?: ReadonlyArray<string | { readonly name: string }>;
  /**
   * The app's plain settings: values that aren't secrets and differ per
   * install (a PostHog host, a region), as `{ name, why, type, values,
   * default, optional }`. A deployed Worker holds them like its secrets
   * (`everyapp configure <app>` sets them; the deploy writes each
   * default nobody has set), so production builds don't declare them. In
   * development each one set locally (`.dev.vars`, `.env`, as for
   * secrets) is declared as a secret, and one that isn't, but has a
   * default, as text with its default.
   */
  settings?: ReadonlyArray<{
    readonly name: string;
    readonly default?: string;
  }>;
}

/** The names of the manifest's `secrets`, whichever form each took. */
function manifestSecretNames(manifest: EveryAppWorkerManifest): string[] {
  return (manifest.secrets ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.name,
  );
}

/** The ids of the manifest's `providers`, whichever form each took. */
function manifestProviderIds(manifest: EveryAppWorkerManifest): string[] {
  return (manifest.providers ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.id,
  );
}

/** The context cf passes to a `defineConfig((ctx) => …)` factory. */
export interface EveryAppConfigContext {
  mode: string | undefined;
  isPreview?: boolean;
}

export interface EveryAppWorkerOptions<
  TManifest extends EveryAppWorkerManifest,
  TEntrypoint,
> {
  /** The default export of `everyapp.config.ts`, declared `as const`. */
  manifest: TManifest;
  /** The Worker entry, usually a `cf-worker` namespace import of `src/entry.worker.ts`. */
  entrypoint: TEntrypoint;
  ctx: EveryAppConfigContext;
  /** App root holding `.dev.vars` and `.env` files. Defaults to the working directory. */
  root?: string;
  /**
   * Cron schedules (UTC) that run the Worker's `scheduled` handler, e.g.
   * `"0 6 * * *"` (daily at 06:00). Deploys keep them; an app can't declare
   * routes.
   */
  crons?: readonly string[];
  /**
   * Compatibility flags beyond `nodejs_compat`, which every Every App Worker
   * has, e.g. `["global_fetch_strictly_public"]` so the Worker's `fetch()`
   * reaches only the public internet. Appended to `nodejs_compat`, without
   * duplicates. The compatibility date is the manifest's.
   */
  compatibilityFlags?: readonly string[];
}

// Structural copies of the `cf/config` binding and export shapes this helper
// emits, so the SDK needs no `cf` dependency. The app's own `defineConfig()`
// call type-checks the result against the real ones, and `cf` infers the
// Worker's `Env` from these types, so each binding keeps its own key. The
// Vite plugin's `auxiliaryWorkers` take `@cloudflare/config`'s
// `InputWorkerConfig`, the schema's input, which is narrower: there a
// binding names another Worker by name only (packages/cli's
// sdkWorkerConfig.test.ts pins both).
export interface TextBinding {
  type: "text";
  value: string;
}
export interface SecretBinding {
  type: "secret";
}
export interface D1Binding {
  type: "d1";
  name: string;
  id?: string;
}
export interface KvBinding {
  type: "kv";
  id?: string;
}
export interface R2Binding {
  type: "r2";
  name: string;
}
export interface HyperdriveBinding {
  type: "hyperdrive";
  id: string;
  dev?: { connectionString?: string };
}
/** A producer binding to one of the app's queues. */
export interface QueueBinding {
  type: "queue";
  name: string;
}
/** A JSON value the Worker reads as it is: `env.<NAME>` is `value`. */
export interface JsonBinding<T = unknown> {
  type: "json";
  value: T;
}
/**
 * An AI Gateway of the app's own (`resources.aiGateway`): its id, account
 * and URL, which the Worker reads as `env.<NAME>.id` and `env.<NAME>.url`.
 */
export type AiGatewayBinding = JsonBinding<AiGatewayValue>;
/**
 * Workers AI (`env.AI.run()`), which cf types as `Ai`. Deployed, it calls
 * the account's Workers AI. Miniflare has none locally: in development the
 * binding is marked remote, so it reaches the account once the app's Vite
 * config sets `remoteBindings: true` (the starter sets it false) and
 * `cf auth login` has run; until then every call throws `Binding AI needs
 * to be run remotely`.
 */
export interface AiBinding {
  type: "ai";
  dev?: { remote?: boolean };
}
/**
 * Browser Rendering (`env.BROWSER`, for `@cloudflare/puppeteer` or
 * `@cloudflare/playwright`), which cf types as `BrowserRun`. Deployed, it
 * drives a headless Chrome on Cloudflare (Workers Paid). In development
 * the same binding reaches Miniflare's local stand-in: the first session
 * downloads a Chrome into the global `.wrangler` cache and starts it.
 */
export interface BrowserBinding {
  type: "browser";
}
/**
 * Cloudflare Images (`env.IMAGES.input(stream).transform(…).output(…)`,
 * `env.IMAGES.info(stream)`), which cf types as the runtime's
 * `ImagesBinding`. Deployed, it runs on Cloudflare and bills the account's
 * Images transformations. In development Miniflare answers it locally with
 * sharp, which ships with it.
 */
export interface ImagesBinding {
  type: "images";
}
/**
 * A Vectorize index, by name. `dev.remote` sends development calls to the
 * account's index: Cloudflare has no local Vectorize.
 */
export interface VectorizeBinding {
  type: "vectorize";
  name: string;
  dev?: { remote?: boolean };
}
/**
 * A `send_email` binding (cf's `SendEmailBindingOptions`): one destination,
 * a list of them, or neither, and the senders it may use.
 */
type SendEmailDestination =
  | { destinationAddress: string; allowedDestinationAddresses?: never }
  | { destinationAddress?: never; allowedDestinationAddresses: string[] }
  | { destinationAddress?: never; allowedDestinationAddresses?: never };
export type SendEmailBinding = SendEmailDestination & {
  type: "send-email";
  allowedSenderAddresses?: string[];
};
/**
 * A Secrets Store secret (`await env.STRIPE_KEY.get()`), which cf types as
 * `SecretsStoreSecret`. Deployed, the secret the deploy made in the
 * account's store; in development, the local store `local` that Miniflare
 * keeps under `.cloudflare/state`, where `get()` throws `Secret "<name>"
 * not found` until the secret is seeded there (`.dev.vars` doesn't reach
 * this binding).
 */
export interface SecretsStoreSecretBinding {
  type: "secrets-store-secret";
  storeId: string;
  secretName: string;
}
/**
 * An Analytics Engine dataset (`env.EVENTS.writeDataPoint({ blobs,
 * doubles, indexes })`), which cf types as `AnalyticsEngineDataset`.
 * Deployed, the dataset exists once written to. In development Miniflare
 * accepts every write and keeps none. cf's shape takes no `dev` options.
 */
export interface AnalyticsEngineDatasetBinding {
  type: "analytics-engine-dataset";
  name: string;
}
/**
 * The app's own Worker, as the bindings of the Durable Objects it defines
 * name it when its entrypoint is a `cf-worker` module import. cf reads each
 * class from that module, so the `Env` it generates types the namespace
 * with it (`DurableObjectNamespace<UserSyncDO>`) and RPC calls on a stub
 * type-check, and it resolves the reference to the Worker's name.
 */
export interface EveryAppWorkerReference<TEntrypoint extends object> {
  name: string;
  compatibilityDate: string;
  entrypoint: TEntrypoint;
}
/**
 * A Durable Object binding. `worker` names the Worker defining the class:
 * the app's own Worker by its definition (see
 * {@link EveryAppWorkerReference}), or a Worker by name, which cf types as
 * an untyped `DurableObjectNamespace`.
 */
export interface DurableObjectBinding<
  TWorker extends string | EveryAppWorkerReference<object> = string,
  TClassName extends string = string,
> {
  type: "durable-object";
  worker: TWorker;
  exportName: TClassName;
}
export interface WorkflowBinding {
  type: "workflow";
  name: string;
  worker: string;
  exportName: string;
}
export interface GatewayBinding {
  type: "worker";
  worker: string;
  exportName: string;
  props: Record<string, string>;
}
/** The app's service binding to one of its helper Workers. */
export interface ServiceBinding {
  type: "worker";
  worker: string;
}
export interface VersionMetadataBinding {
  type: "version-metadata";
}
/**
 * A binding of any Worker these helpers build, each one `InputWorkerConfig`
 * accepts, so a helper Worker's definition passes as the Vite plugin's
 * `auxiliaryWorkers` config. A Durable Object binding names its Worker by
 * name; only the app's own Worker names itself by definition (see
 * {@link EveryAppWorkerReference}), in its typed `env`, which
 * `defineConfig()` takes.
 */
export type EveryAppBinding =
  | TextBinding
  | SecretBinding
  | D1Binding
  | KvBinding
  | R2Binding
  | HyperdriveBinding
  | QueueBinding
  | AiBinding
  | BrowserBinding
  | ImagesBinding
  | VectorizeBinding
  | AiGatewayBinding
  | JsonBinding<JsonValue>
  | SendEmailBinding
  | SecretsStoreSecretBinding
  | AnalyticsEngineDatasetBinding
  | DurableObjectBinding
  | WorkflowBinding
  | GatewayBinding
  | ServiceBinding
  | VersionMetadataBinding;

export interface DurableObjectExport {
  type: "durable-object";
  storage: "sqlite";
}

export interface WorkflowExport {
  type: "workflow";
  name: string;
}

type D1Names<M> = M extends { resources: { d1: readonly (infer B)[] } }
  ? B & string
  : never;
type KvNames<M> = M extends { resources: { kv: readonly (infer B)[] } }
  ? B & string
  : never;
type R2Names<M> = M extends { resources: { r2: readonly (infer B)[] } }
  ? B & string
  : never;
type AiNames<M> = M extends { resources: { ai: readonly (infer B)[] } }
  ? B & string
  : never;
type BrowserNames<M> = M extends {
  resources: { browser: readonly (infer B)[] };
}
  ? B & string
  : never;
type ImagesNames<M> = M extends {
  resources: { images: readonly (infer B)[] };
}
  ? B & string
  : never;
type VectorizeNames<M> = M extends {
  resources: { vectorize: readonly (infer V)[] };
}
  ? V extends { name: infer N extends string }
    ? N
    : never
  : never;
type AiGatewayNames<M> = M extends {
  resources: { aiGateway: readonly (infer G)[] };
}
  ? G extends { name: infer N extends string }
    ? N
    : never
  : never;
type AnalyticsEngineNames<M> = M extends {
  resources: { analyticsEngine: readonly (infer A)[] };
}
  ? A extends { name: infer N extends string }
    ? N
    : never
  : never;
type DurableObjects<M> = M extends {
  resources: { durableObjects: readonly (infer D)[] };
}
  ? D
  : never;
type Workflows<M> = M extends {
  resources: { workflows: readonly (infer W)[] };
}
  ? W
  : never;

type QueueNames<M> = M extends {
  resources: { queues: readonly (infer Q)[] };
}
  ? Q extends { name: infer N extends string }
    ? N
    : never
  : never;

type SendEmailNames<M> = M extends {
  resources: { sendEmail: readonly (infer S)[] };
}
  ? S extends { name: infer N extends string }
    ? N
    : never
  : never;

type SecretsStoreNames<M> = M extends {
  resources: { secretsStore: readonly (infer S)[] };
}
  ? S extends { name: infer N extends string }
    ? N
    : never
  : never;

type HelperWorkers<M> = M extends { workers: readonly (infer H)[] } ? H : never;

/** The Hyperdrive bindings the app's own Worker has: those no helper alone takes. */
type AppHyperdriveNames<M> = M extends {
  resources: { hyperdrive: readonly (infer H)[] };
}
  ? H extends { worker: string }
    ? never
    : H extends { name: infer N extends string }
      ? N
      : never
  : never;

type DatabaseEnv<M> = M extends { database: object }
  ? { DATABASE_PROVIDER: TextBinding }
  : unknown;

type DevProviderKeys = typeof DEV_GATEWAY_KEYS.providers;
type DevCapabilityKeys = typeof DEV_GATEWAY_KEYS.capabilities;

/** The gateway keys a developer may set locally for the manifest's providers and capabilities. */
type DevGatewayKeys<M> =
  | (M extends { providers: readonly (infer P)[] }
      ? P extends keyof DevProviderKeys
        ? DevProviderKeys[P][number]
        : never
      : never)
  | (M extends { capabilities: infer C }
      ? keyof C extends infer K
        ? K extends keyof DevCapabilityKeys
          ? DevCapabilityKeys[K][number]
          : never
        : never
      : never);

/**
 * A manifest Durable Object's binding: named after the app's own Worker by
 * its definition when that Worker defines the class and its entrypoint is a
 * module import, so cf types the namespace with the class; a helper
 * Worker's class, or any class behind a path entrypoint, by name.
 */
type DurableObjectBindingFor<D, TEntrypoint> = D extends { worker: string }
  ? DurableObjectBinding
  : TEntrypoint extends object
    ? D extends { className: infer C extends string }
      ? DurableObjectBinding<EveryAppWorkerReference<TEntrypoint>, C>
      : DurableObjectBinding
    : DurableObjectBinding;

type ResourceEnv<M, TEntrypoint> = { [B in D1Names<M>]: D1Binding } & {
  [B in KvNames<M>]: KvBinding;
} & {
  [B in R2Names<M>]: R2Binding;
} & {
  [B in QueueNames<M>]: QueueBinding;
} & {
  [B in AiNames<M>]: AiBinding;
} & {
  [B in BrowserNames<M>]: BrowserBinding;
} & {
  [B in ImagesNames<M>]: ImagesBinding;
} & {
  [B in VectorizeNames<M>]: VectorizeBinding;
} & {
  [B in AiGatewayNames<M>]: AiGatewayBinding;
} & {
  [B in SendEmailNames<M>]: SendEmailBinding;
} & {
  [B in SecretsStoreNames<M>]: SecretsStoreSecretBinding;
} & {
  [B in AnalyticsEngineNames<M>]: AnalyticsEngineDatasetBinding;
} & {
  [D in DurableObjects<M> as D extends { name: infer N extends string }
    ? N
    : never]: DurableObjectBindingFor<D, TEntrypoint>;
} & {
  [W in Workflows<M> as W extends { name: infer N extends string }
    ? N
    : never]: WorkflowBinding;
} & {
  [H in HelperWorkers<M> as H extends { binding: infer B extends string }
    ? B
    : never]: ServiceBinding;
};

// Object type aliases rather than interfaces: cf's `env` is a
// Record<string, Binding>, which only implicitly-indexable types satisfy.
/** A JSON value, as cf's JSON bindings take one. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** `M` without `readonly`, as cf's JSON bindings take their value. */
type JsonValueOf<M> = M extends readonly (infer E)[]
  ? JsonValueOf<E>[]
  : M extends object
    ? { -readonly [K in keyof M]: JsonValueOf<M[K]> }
    : M;

type SharedEnv<M> = {
  EVERYAPP_APP_ID: TextBinding;
  EVERYAPP_MANIFEST: JsonBinding<JsonValueOf<M>>;
  CF_VERSION_METADATA: VersionMetadataBinding;
  GATEWAY_URL: TextBinding | SecretBinding;
};

/**
 * Hyperdrive in production; in development only where a local connection
 * string is set, so `Env` marks each optional.
 */
type HyperdriveEnv<M> = { [B in AppHyperdriveNames<M>]: HyperdriveBinding };

/** In dev, an app that lists `email` may get the installation's stand-in senders from .dev.vars. */
type DevEmailEnv<M> = M extends { capabilities: { email: unknown } }
  ? { EVERYAPP_EMAIL_SENDERS?: SecretBinding }
  : unknown;

/**
 * Bindings in development: the well-known dev identity, as plain text, and
 * the developer's own gateway keys (when set).
 */
export type EveryAppDevEnv<M, TEntrypoint = string> = ResourceEnv<
  M,
  TEntrypoint
> &
  SharedEnv<M> &
  DatabaseEnv<M> &
  DevEmailEnv<M> & {
    EVERYAPP_DEV: TextBinding;
    EVERYAPP_DEV_CAPABILITIES: TextBinding;
    /** The specs in `.everyapp/providers/*.json`, when the app has any: providers registered on a gateway, for integrationFetch()'s dev fallback. */
    EVERYAPP_DEV_PROVIDERS?: TextBinding;
    EVERYAPP_IDENTITY_PUBLIC_KEYS: TextBinding;
    EVERYAPP_IDENTITY_ISSUER: TextBinding;
    /** The stub dev gateway's organization (`dev-org`), so `withOrganization(env.EVERY_APP_ORG_ID, …)` works in development as deployed. */
    EVERY_APP_ORG_ID: TextBinding;
  } & { [K in DevGatewayKeys<M>]: SecretBinding };

/** Bindings in production: the deployed identity and the gateway binding. */
export type EveryAppDeployEnv<M, TEntrypoint = string> = ResourceEnv<
  M,
  TEntrypoint
> &
  SharedEnv<M> &
  DatabaseEnv<M> &
  HyperdriveEnv<M> & {
    EVERYAPP_AUDIENCE: TextBinding;
    EVERYAPP_IDENTITY_PUBLIC_KEYS: TextBinding;
    EVERYAPP_IDENTITY_ISSUER: TextBinding;
    EVERY_APP_GATEWAY: GatewayBinding;
    /**
     * The owning organization. The build always declares it; installing a
     * shared app, which serves every organization, drops it.
     */
    EVERY_APP_ORG_ID?: SecretBinding;
    /**
     * `1` on a shared app's Workers, added when it is installed: gateway
     * calls say whom they are for.
     */
    EVERYAPP_SHARED?: TextBinding;
  };

/** The classes the app's own Worker defines: none a helper Worker does. */
export type EveryAppExports<M> = {
  [E in DurableObjects<M> | Workflows<M> as E extends { worker: string }
    ? never
    : E extends { className: infer C extends string }
      ? C
      : never]: E extends Workflows<M> ? WorkflowExport : DurableObjectExport;
};

export interface EveryAppObservability {
  enabled: boolean;
  headSamplingRate: number;
  redactQueryString: boolean;
  logs: {
    enabled: boolean;
    invocationLogs: boolean;
    persist: boolean;
    headSamplingRate: number;
  };
  traces: { enabled: boolean; persist: boolean; headSamplingRate: number };
  issues: { enabled: boolean };
}

/** Structural copy of cf's targeted placement: run near a cloud region. */
export interface EveryAppPlacement {
  region: string;
}

/** Structural copy of cf's scheduled (cron) trigger. */
export interface ScheduledTrigger {
  type: "scheduled";
  schedule: string;
}

/**
 * Structural copy of cf's queue consumer trigger: the Worker consumes the
 * named queue (its `queue(batch, env)` handler), with these settings.
 */
export interface QueueConsumerTrigger {
  type: "queue";
  name: string;
  deadLetterQueue?: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxConcurrency?: number | null;
  maxRetries?: number;
  retryDelay?: number;
  visibilityTimeoutMs?: number;
}

/** A trigger one of the app's Workers may have: its crons, the queues it consumes. */
export type EveryAppTrigger = ScheduledTrigger | QueueConsumerTrigger;

export interface EveryAppWorkerConfig<M, TEntrypoint> {
  name: string;
  entrypoint: TEntrypoint;
  compatibilityDate: string;
  compatibilityFlags: string[];
  workersDev: false;
  previewUrls: false;
  /** The `crons` option's schedules and the queues it consumes; absent without any. */
  triggers?: EveryAppTrigger[];
  /** Near the manifest's `database.region`, once deployed. */
  placement?: EveryAppPlacement;
  /** The manifest's `limits`. */
  limits?: { cpuMs?: number };
  observability: EveryAppObservability;
  /** Either branch, so `Env` marks dev-only and deploy-only bindings optional. */
  env: EveryAppDevEnv<M, TEntrypoint> | EveryAppDeployEnv<M, TEntrypoint>;
  exports: EveryAppExports<M>;
}

/**
 * Observability every Every App Worker ships with: logs (with invocation
 * logs), sampled traces and Workers Issues, with query strings redacted so
 * tokens and invitation ids in URLs stay out of logs.
 */
export const EVERYAPP_OBSERVABILITY: Readonly<EveryAppObservability> =
  Object.freeze({
    enabled: true,
    headSamplingRate: 1,
    redactQueryString: true,
    logs: Object.freeze({
      enabled: true,
      invocationLogs: true,
      persist: true,
      headSamplingRate: 1,
    }),
    traces: Object.freeze({
      enabled: true,
      persist: true,
      headSamplingRate: 0.1,
    }),
    issues: Object.freeze({ enabled: true }),
  });

const DEFAULT_COMPATIBILITY_DATE = "2026-06-01";
/** Set by `everyapp deploy` around the production build it installs. */
const BUILD_ENV = "EVERYAPP_BUILD";
/** Names the deploy sets itself (as `everyapp secret set` refuses). */
const RESERVED_SECRET_NAME =
  /^(GATEWAY_URL|CF_VERSION_METADATA|EVERYAPP_\w*|EVERY_APP_\w*|APP__\w*)$/i;
const GATEWAY_WORKER_NAME = "every-app-gateway";
const GATEWAY_ENTRYPOINT = "AppGateway";

/**
 * Where `everyapp dev` serves its launcher, which it passes to the app's dev
 * server in EVERYAPP_DEV_GATEWAY_URL; its default address otherwise. The
 * deployed Worker gets the Gateway's URL from the deploy instead.
 */
const DEV_GATEWAY_URL_ENV = "EVERYAPP_DEV_GATEWAY_URL";
const DEFAULT_DEV_GATEWAY_URL = "http://localhost:8787";

function devGatewayUrl(): TextBinding {
  return {
    type: "text",
    value: process.env[DEV_GATEWAY_URL_ENV] || DEFAULT_DEV_GATEWAY_URL,
  };
}

/**
 * The manifest's `capabilities` as the SDK's local-dev twin of the gateway
 * reads them: with no gateway to hold an OAuth client's calls to the scope
 * sets the app declares, `integrationFetch()` holds them to these.
 */
function devCapabilities(manifest: EveryAppWorkerManifest): TextBinding {
  return { type: "text", value: JSON.stringify(manifest.capabilities ?? {}) };
}

/**
 * The binding the dev Worker gets the specs of providers registered on a
 * gateway in (`DEV_PROVIDERS_ENV` in ../internal/devProviders.ts; a copy,
 * kept in step by a test, since this file may not import ../internal).
 */
const DEV_PROVIDERS_ENV = "EVERYAPP_DEV_PROVIDERS";

/** One `.everyapp/providers/<id>.json` as the binding carries it. */
interface DevProviderFile {
  file: string;
  /** The file's JSON, or its text when it isn't JSON (the SDK names the file when an app asks for it). */
  spec: unknown;
}

/**
 * The specs `everyapp provider add` (in an app directory) and `everyapp
 * provider show <id> --save` wrote under the app, in name order; none
 * without the directory. integrationFetch()'s dev fallback reaches a
 * provider outside the catalog from them, with the developer's own key.
 */
function devProviderFiles(root: string | undefined): DevProviderFile[] {
  const dir = path.join(root ?? process.cwd(), ".everyapp", "providers");
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    let spec: unknown;
    try {
      spec = JSON.parse(text);
    } catch {
      spec = text;
    }
    return { file: `.everyapp/providers/${name}`, spec };
  });
}

/** EVERYAPP_DEV_PROVIDERS, when the app has any spec files. */
function addDevProviders(
  env: Record<string, EveryAppBinding>,
  root: string | undefined,
): void {
  const files = devProviderFiles(root);
  if (files.length === 0) return;
  env[DEV_PROVIDERS_ENV] = { type: "text", value: JSON.stringify(files) };
}

/**
 * The Gateway settings the spec files name for the capabilities the
 * manifest lists outside {@link DEV_GATEWAY_KEYS} (a registered provider's
 * key, a Basic username held as a setting, its host setting), read
 * loosely: the SDK parses the spec when the app calls the provider.
 */
function devProviderKeys(
  manifest: EveryAppWorkerManifest,
  root: string | undefined,
): string[] {
  const listed = Object.keys(manifest.capabilities ?? {}).filter(
    (id) => !Object.hasOwn(DEV_GATEWAY_KEYS.capabilities, id),
  );
  if (listed.length === 0) return [];
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const names: string[] = [];
  for (const { file, spec } of devProviderFiles(root)) {
    const fields = record(spec);
    const id =
      typeof fields?.["id"] === "string"
        ? fields["id"]
        : file
            .split("/")
            .at(-1)!
            .replace(/\.json$/, "");
    if (!fields || !listed.includes(id)) continue;
    const auth = record(fields["auth"]);
    for (const name of [
      auth?.["secret"],
      record(auth?.["user"])?.["secret"],
      fields["hostSetting"],
    ]) {
      if (typeof name === "string" && /^[A-Z][A-Z0-9_]*$/.test(name)) {
        names.push(name);
      }
    }
  }
  return names;
}
/** Cloudflare's limit on a Workflow's name. */
const MAX_WORKFLOW_NAME_LENGTH = 64;
/**
 * The store development binds Secrets Store secrets in: Miniflare keeps
 * one per id under `.cloudflare/state`, and any id works locally.
 */
const LOCAL_SECRETS_STORE_ID = "local";
/** Cloudflare's limit on a Vectorize index's name. */
const MAX_VECTORIZE_NAME_LENGTH = 64;
/** Cloudflare's limit on a Worker's name. */
const MAX_WORKER_NAME_LENGTH = 63;
/**
 * Where a developer puts a local Postgres URL for a Hyperdrive binding
 * (`.dev.vars` or `.env`), the variable wrangler reads for the same.
 */
const LOCAL_HYPERDRIVE_PREFIX =
  "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_";

/**
 * Build the Worker definition for an Every App app from its manifest.
 *
 * - `development` (cf dev) and no mode (cf API commands, `cf workers types`):
 *   EVERYAPP_DEV is on, the identity keys and issuer are the well-known dev
 *   ones (`@every-app/sdk/dev`) as plain text, so nothing needs writing to
 *   `.dev.vars`, and each D1 database gets a fixed local id (see
 *   {@link localD1Id}) that `cf d1 … --local` can address.
 * - `production`: tenant-neutral. Everything install-specific (the Worker
 *   name, organization, gateway URL, identity keys, resource names and ids)
 *   is a placeholder from {@link sentinelDeployTarget}, which the installer
 *   rewrites (`everyapp deploy`, or a hosted gateway's deployer), so every
 *   build of an app is the same. Only with EVERYAPP_BUILD=1, which
 *   `everyapp deploy` sets: a bare `cf deploy` would upload the
 *   placeholders.
 */
export function everyAppWorker<
  const M extends EveryAppWorkerManifest,
  TEntrypoint extends string | object,
>(
  options: EveryAppWorkerOptions<M, TEntrypoint>,
): EveryAppWorkerConfig<M, TEntrypoint> {
  const { manifest } = options;
  const { deploy, name } = appWorkerName(options, "everyAppWorker");

  const env: Record<string, EveryAppBinding> = {
    EVERYAPP_APP_ID: { type: "text", value: manifest.id },
    // The manifest itself, for a page that shows what the app asked for:
    // the Worker can't import everyapp.config.ts (see ./index.ts).
    EVERYAPP_MANIFEST: {
      type: "json",
      value: manifest as unknown as JsonValue,
    },
    CF_VERSION_METADATA: { type: "version-metadata" },
  };
  if (deploy) {
    // The gateway mints every identity for the Worker's name (`aud`).
    env["EVERYAPP_AUDIENCE"] = { type: "text", value: name };
    env["EVERYAPP_IDENTITY_PUBLIC_KEYS"] = {
      type: "text",
      value: JSON.stringify(deploy.identityPublicKeys),
    };
    env["EVERYAPP_IDENTITY_ISSUER"] = {
      type: "text",
      value: deploy.gatewayUrl,
    };
    env["EVERY_APP_GATEWAY"] = gatewayBinding(deploy, manifest.id, name);
    // Sent by the deploy pipeline through `cf deploy --secrets-file`.
    env["GATEWAY_URL"] = { type: "secret" };
    env["EVERY_APP_ORG_ID"] = { type: "secret" };
  } else {
    env["EVERYAPP_DEV"] = { type: "text", value: "1" };
    env["EVERYAPP_DEV_CAPABILITIES"] = devCapabilities(manifest);
    env["EVERYAPP_IDENTITY_PUBLIC_KEYS"] = {
      type: "text",
      value: JSON.stringify([DEV_PUBLIC_KEY_PEM]),
    };
    env["EVERYAPP_IDENTITY_ISSUER"] = { type: "text", value: DEV_ISSUER };
    env["GATEWAY_URL"] = devGatewayUrl();
    // The stub gateway's organization, as the deploy's secret would be, so
    // background work's withOrganization(env.EVERY_APP_ORG_ID, …) runs
    // here too. Not a pin: under the dev opt-in everyApp() enforces none,
    // so `everyapp dev --mode mirror`'s real organizations still open.
    env["EVERY_APP_ORG_ID"] = { type: "text", value: DEV_ORG_ID };
    addDevProviders(env, options.root);
  }

  Object.assign(env, storageBindings(manifest, name, deploy));
  addQueueBindings(env, manifest, name, deploy);
  addAiBindings(env, manifest, deploy);
  addBrowserBindings(env, manifest);
  addImagesBindings(env, manifest);
  addAiGatewayBindings(env, manifest, name, deploy);
  addSendEmailBindings(env, manifest);
  addSecretsStoreBindings(env, manifest, name, deploy);
  addAnalyticsEngineBindings(env, manifest, name);
  addDatabaseBindings(env, options, name, undefined, deploy);
  // The app binds every class, a helper Worker's in that Worker, and
  // exports only its own.
  const { bindings, exports } = classBindings(manifest, name, undefined, env);
  Object.assign(env, bindings);
  for (const helper of manifest.workers ?? []) {
    if (!helper.binding) continue;
    if (env[helper.binding]) {
      throw new Error(
        `workers: ${helper.name}'s binding ${helper.binding} reuses a binding name the Worker already has.`,
      );
    }
    env[helper.binding] = {
      type: "worker",
      worker: helperWorkerName(name, helper.name),
    };
  }
  addSecrets(env, options, deploy);
  const triggers = [
    ...cronTriggers(options.crons),
    ...queueTriggers(manifest, name, undefined, deploy),
  ];
  const compatibilityDate =
    manifest.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;

  // cf types a Durable Object namespace with its class only when the binding
  // names the defining Worker by a definition whose module it can read, so
  // the classes this Worker defines name it that way; cf resolves the
  // reference to the Worker's name. A path entrypoint gives cf no module.
  // Only here: `EveryAppBinding` names Workers by name, as the Vite
  // plugin's `auxiliaryWorkers` require.
  const { entrypoint } = options;
  const ownClasses: Record<
    string,
    DurableObjectBinding<EveryAppWorkerReference<object>>
  > = {};
  if (typeof entrypoint === "object") {
    const self: EveryAppWorkerReference<object> = {
      name,
      compatibilityDate,
      entrypoint,
    };
    for (const durableObject of manifest.resources?.durableObjects ?? []) {
      if (durableObject.worker !== undefined) continue;
      ownClasses[durableObject.name] = {
        type: "durable-object",
        worker: self,
        exportName: durableObject.className,
      };
    }
  }

  return {
    name,
    entrypoint,
    compatibilityDate,
    compatibilityFlags: compatibilityFlags(options.compatibilityFlags),
    workersDev: false,
    previewUrls: false,
    ...(triggers.length ? { triggers } : {}),
    ...runtimeSettings(manifest, manifest.limits, deploy),
    observability: observability(),
    // Each class keeps its key's place in `env`: classBindings bound it by name.
    env: { ...env, ...ownClasses } as
      | EveryAppDevEnv<M, TEntrypoint>
      | EveryAppDeployEnv<M, TEntrypoint>,
    exports: exports as EveryAppExports<M>,
  };
}

export interface EveryAppAuxiliaryWorkerOptions<
  TManifest extends EveryAppWorkerManifest,
  TEntrypoint,
> extends EveryAppWorkerOptions<TManifest, TEntrypoint> {
  /** The helper Worker's name in the manifest's `workers`. */
  worker: string;
}

/** A helper Worker's definition, for the Vite plugin's `auxiliaryWorkers`. */
export interface EveryAppAuxiliaryWorkerConfig<TEntrypoint> {
  name: string;
  entrypoint: TEntrypoint;
  compatibilityDate: string;
  compatibilityFlags: string[];
  workersDev: false;
  previewUrls: false;
  triggers?: EveryAppTrigger[];
  placement?: EveryAppPlacement;
  limits?: { cpuMs?: number };
  observability: EveryAppObservability;
  env: Record<string, EveryAppBinding>;
  exports: Record<string, DurableObjectExport | WorkflowExport>;
}

/**
 * Build the definition of one of the app's helper Workers (the manifest's
 * `workers`), e.g. one that runs a memory-hungry job away from the app's
 * Worker. It is named `<app worker>--<worker>`, is private like the app, and
 * binds the app's  and Analytics Engine datasets, the classes it defines, and
 * binds the app's D1 databases, KV namespaces, R2 buckets, Workers AI,
 * Browser Rendering, Images, Vectorize indexes, AI Gateways, `send_email`
 * bindings and Secrets Store secrets, the classes it defines, and
 * the gateway (with the app's identity, for capabilities). Only the app's
 * Worker reaches it. Pass it to the Vite plugin:
 *
 *   cloudflare({
 *     auxiliaryWorkers: [
 *       { config: everyAppAuxiliaryWorker({ manifest, worker: "audit", entrypoint: "./src/audit.ts", ctx: { mode } }) },
 *     ],
 *   })
 */
export function everyAppAuxiliaryWorker<
  const M extends EveryAppWorkerManifest,
  TEntrypoint extends string | object,
>(
  options: EveryAppAuxiliaryWorkerOptions<M, TEntrypoint>,
): EveryAppAuxiliaryWorkerConfig<TEntrypoint> {
  const { manifest, worker } = options;
  const helper = manifest.workers?.find((entry) => entry.name === worker);
  if (!helper) {
    throw new Error(
      `everyapp.config.ts declares no helper Worker "${worker}" in workers.`,
    );
  }
  const { deploy, name: appWorker } = appWorkerName(
    options,
    "everyAppAuxiliaryWorker",
  );
  const name = helperWorkerName(appWorker, worker);

  const env: Record<string, EveryAppBinding> = {
    EVERYAPP_APP_ID: { type: "text", value: manifest.id },
    ...storageBindings(manifest, appWorker, deploy),
  };
  addQueueBindings(env, manifest, appWorker, deploy);
  addSendEmailBindings(env, manifest);
  if (deploy) {
    // The app's identity: the gateway treats its helper Workers as the app.
    env["EVERY_APP_GATEWAY"] = gatewayBinding(deploy, manifest.id, appWorker);
    // Sent by the deploy pipeline through `cf deploy --secrets-file`, like
    // the app's Worker: a helper's gateway calls name the organization too.
    env["GATEWAY_URL"] = { type: "secret" };
    env["EVERY_APP_ORG_ID"] = { type: "secret" };
  } else {
    env["EVERYAPP_DEV"] = { type: "text", value: "1" };
    env["EVERYAPP_DEV_CAPABILITIES"] = devCapabilities(manifest);
    env["GATEWAY_URL"] = devGatewayUrl();
    env["EVERY_APP_ORG_ID"] = { type: "text", value: DEV_ORG_ID };
    addDevProviders(env, options.root);
  }
  addAiBindings(env, manifest, deploy);
  addBrowserBindings(env, manifest);
  addImagesBindings(env, manifest);
  addAiGatewayBindings(env, manifest, appWorker, deploy);
  addSecretsStoreBindings(env, manifest, appWorker, deploy);
  addAnalyticsEngineBindings(env, manifest, appWorker);
  addDatabaseBindings(env, options, appWorker, worker, deploy);
  const { bindings, exports } = classBindings(manifest, appWorker, worker, env);
  Object.assign(env, bindings);
  addSecrets(env, options, deploy);
  const triggers = [
    ...cronTriggers(options.crons),
    ...queueTriggers(manifest, appWorker, worker, deploy),
  ];

  return {
    name,
    entrypoint: options.entrypoint,
    compatibilityDate: manifest.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: compatibilityFlags(options.compatibilityFlags),
    workersDev: false,
    previewUrls: false,
    ...(triggers.length ? { triggers } : {}),
    ...runtimeSettings(manifest, helper.limits, deploy),
    observability: observability(),
    env,
    exports,
  };
}

/**
 * A helper Worker's name: `<app worker>--<name>`, within Cloudflare's
 * limit. New app ids can't contain `--`, so it is never another app's
 * Worker name.
 */
export function helperWorkerName(appWorker: string, helper: string): string {
  const name = `${appWorker}--${helper}`;
  if (name.length > MAX_WORKER_NAME_LENGTH) {
    throw new Error(
      `Helper Worker ${name} is longer than Cloudflare's ${MAX_WORKER_NAME_LENGTH} characters; shorten its name in everyapp.config.ts.`,
    );
  }
  return name;
}

/** The placeholder target (in production) and the app Worker's name. */
function appWorkerName(
  options: Pick<
    EveryAppWorkerOptions<EveryAppWorkerManifest, unknown>,
    "manifest" | "ctx" | "root"
  >,
  builder: string,
): { deploy: EveryAppDeployTarget | undefined; name: string } {
  const { manifest, ctx } = options;
  assertAppId(manifest.id);

  let deploy: EveryAppDeployTarget | undefined;
  if (ctx.mode === "production") {
    if (process.env[BUILD_ENV] !== "1") {
      throw new Error(
        `EveryApp Workers are built for production only by \`everyapp deploy\` (\`pnpm run deploy\`), which sets ${BUILD_ENV}=1 and installs the build: ` +
          "a bare `cf build` or `cf deploy` would ship a Worker whose name, identity keys, gateway binding and resources are placeholders. " +
          "For a local build, run Vite in development mode (`vite build --mode development`).",
      );
    }
    deploy = sentinelDeployTarget(manifest);
  } else if (ctx.mode !== undefined && ctx.mode !== "development") {
    throw new Error(
      `${builder}() builds in the "development" or "production" mode, not "${ctx.mode}".`,
    );
  }

  const name = deploy?.workerName ?? workerNameFor(manifest.id);
  if (name === GATEWAY_WORKER_NAME) {
    throw new Error(
      `App id "${manifest.id}" is reserved: its Worker would be the gateway's own (${GATEWAY_WORKER_NAME}).`,
    );
  }
  return { deploy, name };
}

function gatewayBinding(
  deploy: EveryAppDeployTarget,
  appId: string,
  appWorker: string,
): GatewayBinding {
  return {
    type: "worker",
    worker: GATEWAY_WORKER_NAME,
    exportName: GATEWAY_ENTRYPOINT,
    props: {
      organizationId: deploy.organizationId,
      appId,
      workerName: appWorker,
    },
  };
}

/**
 * The app's D1 databases, KV namespaces, R2 buckets and Vectorize indexes,
 * which all its Workers share.
 */
function storageBindings(
  manifest: EveryAppWorkerManifest,
  appWorker: string,
  deploy: EveryAppDeployTarget | undefined,
): Record<string, D1Binding | KvBinding | R2Binding | VectorizeBinding> {
  const env: Record<
    string,
    D1Binding | KvBinding | R2Binding | VectorizeBinding
  > = {};
  for (const binding of manifest.resources?.d1 ?? []) {
    if (deploy) {
      const d1 = provisioned(deploy.resources.d1, binding);
      env[binding] = { type: "d1", name: d1.name, id: d1.id };
    } else {
      env[binding] = {
        type: "d1",
        name: resourceNameFor(appWorker, binding),
        id: localD1Id(appWorker, binding),
      };
    }
  }
  for (const binding of manifest.resources?.kv ?? []) {
    if (deploy) {
      env[binding] = {
        type: "kv",
        id: provisioned(deploy.resources.kv, binding).id,
      };
    } else if (manifest.workers?.length) {
      // The Vite plugin's own default for the app's Worker, named so that
      // its helpers share the namespace in dev, as deployed ones do.
      env[binding] = { type: "kv", id: `${binding}-${appWorker}` };
    } else {
      env[binding] = { type: "kv" };
    }
  }
  // Deployed, the names the gateway assigns at registration (placeholders
  // until installed); in dev its rule, so a local bucket is named like a
  // deployed one.
  for (const binding of manifest.resources?.r2 ?? []) {
    if (env[binding]) {
      throw new Error(
        `r2: ${binding} reuses a binding name the Worker already has.`,
      );
    }
    if (deploy) {
      env[binding] = {
        type: "r2",
        name: provisioned(deploy.resources.r2, binding).name,
      };
    } else {
      env[binding] = { type: "r2", name: bucketNameFor(appWorker, binding) };
    }
  }
  // Deployed, the index the deploy provisioned (a placeholder until
  // installed); in development the account's index of the dev Worker's
  // name, reached remotely: Cloudflare has no local Vectorize, so calls
  // throw until the Vite plugin's remoteBindings is on.
  for (const { name: binding } of manifest.resources?.vectorize ?? []) {
    if (env[binding]) {
      throw new Error(
        `vectorize: ${binding} reuses a binding name the Worker already has.`,
      );
    }
    if (deploy) {
      env[binding] = {
        type: "vectorize",
        name: provisioned(deploy.resources.vectorize, binding).name,
      };
      continue;
    }
    const index = suffixedName(appWorker, binding);
    if (index.length > MAX_VECTORIZE_NAME_LENGTH) {
      throw new Error(
        `vectorize: ${binding} would be the Vectorize index "${index}", longer than Cloudflare's ${MAX_VECTORIZE_NAME_LENGTH} characters; shorten the binding name.`,
      );
    }
    env[binding] = { type: "vectorize", name: index, dev: { remote: true } };
  }
  return env;
}

/**
 * A producer binding to each of the app's queues, which every one of its
 * Workers gets. Deployed, each names the queue the deploy provisioned (a
 * placeholder until installed); in development, the queue its rule gives
 * (Miniflare makes it, shared by the Workers of one `cf dev`).
 */
function addQueueBindings(
  env: Record<string, EveryAppBinding>,
  manifest: EveryAppWorkerManifest,
  appWorker: string,
  deploy: EveryAppDeployTarget | undefined,
): void {
  for (const { name: binding } of manifest.resources?.queues ?? []) {
    if (env[binding]) {
      throw new Error(
        `queues: ${binding} reuses a binding name the Worker already has.`,
      );
    }
    env[binding] = {
      type: "queue",
      name: queueName(appWorker, binding, deploy),
    };
  }
}

/**
 * The manifest's Workers AI bindings, which every one of the app's Workers
 * gets: `{ type: "ai" }` deployed (account-wide, nothing to provision), and
 * marked remote in development, where Miniflare has no Workers AI. The
 * remote mark does nothing until the app's Vite config sets
 * `remoteBindings: true`, so turning that on is the one switch.
 */
function addAiBindings(
  env: Record<string, EveryAppBinding>,
  manifest: EveryAppWorkerManifest,
  deploy: EveryAppDeployTarget | undefined,
): void {
  for (const binding of manifest.resources?.ai ?? []) {
    if (env[binding]) {
      throw new Error(
        `ai: ${binding} reuses a binding name the Worker already has.`,
      );
    }
    env[binding] = deploy
      ? { type: "ai" }
      : { type: "ai", dev: { remote: true } };
  }
}

/**
 * The consumer triggers of one of the app's Workers: each queue whose
 * `consumer` is this Worker (`true`, or no `worker`, for the app's own;
 * `forWorker` for a helper), with its settings and its dead-letter queue,
 * another of the app's queues, by name.
 */
function queueTriggers(
  manifest: EveryAppWorkerManifest,
  appWorker: string,
  forWorker: string | undefined,
  deploy: EveryAppDeployTarget | undefined,
): QueueConsumerTrigger[] {
  const triggers: QueueConsumerTrigger[] = [];
  for (const queue of manifest.resources?.queues ?? []) {
    if (queue.consumer === undefined) continue;
    const settings = queue.consumer === true ? {} : queue.consumer;
    if (settings.worker !== forWorker) continue;
    const { deadLetterQueue } = settings;
    if (
      deadLetterQueue !== undefined &&
      !manifest.resources?.queues?.some(
        (other) => other.name === deadLetterQueue,
      )
    ) {
      throw new Error(
        `queues: ${queue.name}'s deadLetterQueue "${deadLetterQueue}" isn't one of resources.queues.`,
      );
    }
    triggers.push({
      type: "queue",
      name: queueName(appWorker, queue.name, deploy),
      ...(deadLetterQueue !== undefined
        ? { deadLetterQueue: queueName(appWorker, deadLetterQueue, deploy) }
        : {}),
      ...Object.fromEntries(
        QUEUE_CONSUMER_SETTINGS.flatMap((key) =>
          settings[key] === undefined ? [] : [[key, settings[key]]],
        ),
      ),
    });
  }
  return triggers;
}

/** The consumer settings a queue trigger carries, in the order it lists them. */
const QUEUE_CONSUMER_SETTINGS = [
  "maxBatchSize",
  "maxBatchTimeout",
  "maxRetries",
  "maxConcurrency",
  "retryDelay",
  "visibilityTimeoutMs",
] as const;

/** A queue binding's queue: the deploy's placeholder, or in development its rule. */
function queueName(
  appWorker: string,
  binding: string,
  deploy: EveryAppDeployTarget | undefined,
): string {
  return deploy
    ? provisioned(deploy.resources.queues, binding).name
    : queueNameFor(appWorker, binding);
}

/**
 * The manifest's Browser Rendering bindings, which every one of the app's
 * Workers gets: `{ type: "browser" }` in both modes (account-wide,
 * nothing to provision; Miniflare serves a local browser in development).
 */
function addBrowserBindings(
  env: Record<string, EveryAppBinding>,
  manifest: EveryAppWorkerManifest,
): void {
  for (const binding of manifest.resources?.browser ?? []) {
    if (env[binding]) {
      throw new Error(
        `browser: ${binding} reuses a binding name the Worker already has.`,
      );
    }
    env[binding] = { type: "browser" };
  }
}

/**
 * The manifest's Images bindings, which every one of the app's Workers
 * gets: `{ type: "images" }` in both modes (account-wide, nothing to
 * provision; Miniflare answers it locally in development).
 */
function addImagesBindings(
  env: Record<string, EveryAppBinding>,
  manifest: EveryAppWorkerManifest,
): void {
  for (const binding of manifest.resources?.images ?? []) {
    if (env[binding]) {
      throw new Error(
        `images: ${binding} reuses a binding name the Worker already has.`,
      );
    }
    env[binding] = { type: "images" };
  }
}

/**
 * The app's AI Gateways, which all its Workers share, each a `json`
 * binding of `{ id, accountId, url }`. Deployed, the gateway the deploy
 * provisioned (a placeholder until installed); in development the id the
 * deploy's rule gives, with an empty account and URL: there is no gateway,
 * so the app calls the provider directly.
 */
function addAiGatewayBindings(
  env: Record<string, EveryAppBinding>,
  manifest: EveryAppWorkerManifest,
  appWorker: string,
  deploy: EveryAppDeployTarget | undefined,
): void {
  for (const { name: binding } of manifest.resources?.aiGateway ?? []) {
    if (env[binding]) {
      throw new Error(
        `aiGateway: ${binding} reuses a binding name the Worker already has.`,
      );
    }
    const value = deploy
      ? { ...provisioned(deploy.resources.aiGateway, binding) }
      : { id: aiGatewayIdFor(appWorker, binding), accountId: "", url: "" };
    env[binding] = { type: "json", value };
  }
}

/**
 * The manifest's `send_email` bindings, the same on every one of the
 * app's Workers in both modes: Cloudflare's binding with the addresses
 * the manifest lists (the deploy's policy holds the built lists to them).
 * Deployed, Cloudflare checks a message against them and the account's
 * Email Sending domains when the Worker sends; in development Miniflare
 * logs the message and checks the senders.
 */
function addSendEmailBindings(
  env: Record<string, EveryAppBinding>,
  manifest: EveryAppWorkerManifest,
): void {
  for (const entry of manifest.resources?.sendEmail ?? []) {
    if (env[entry.name]) {
      throw new Error(
        `sendEmail: ${entry.name} reuses a binding name the Worker already has.`,
      );
    }
    const senders = entry.allowedSenderAddresses
      ? { allowedSenderAddresses: [...entry.allowedSenderAddresses] }
      : {};
    if (
      entry.destinationAddress !== undefined &&
      entry.allowedDestinationAddresses !== undefined
    ) {
      throw new Error(
        `sendEmail: ${entry.name} sets both destinationAddress and allowedDestinationAddresses; set one.`,
      );
    }
    env[entry.name] =
      entry.destinationAddress !== undefined
        ? {
            type: "send-email",
            ...senders,
            destinationAddress: entry.destinationAddress,
          }
        : entry.allowedDestinationAddresses !== undefined
          ? {
              type: "send-email",
              ...senders,
              allowedDestinationAddresses: [
                ...entry.allowedDestinationAddresses,
              ],
            }
          : { type: "send-email", ...senders };
  }
}

/**
 * The manifest's Secrets Store secrets, which every one of the app's
 * Workers binds. Deployed, the store and secret the deploy provisioned
 * (placeholders until installed); in development the local store `local`,
 * under the name the deploy would give the secret, so a seeded local
 * secret is named like a deployed one.
 */
function addSecretsStoreBindings(
  env: Record<string, EveryAppBinding>,
  manifest: EveryAppWorkerManifest,
  appWorker: string,
  deploy: EveryAppDeployTarget | undefined,
): void {
  for (const { name: binding } of manifest.resources?.secretsStore ?? []) {
    if (env[binding]) {
      throw new Error(
        `secretsStore: ${binding} reuses a binding name the Worker already has.`,
      );
    }
    if (deploy) {
      const secret = provisioned(deploy.resources.secretsStore, binding);
      env[binding] = {
        type: "secrets-store-secret",
        storeId: secret.storeId,
        secretName: secret.secretName,
      };
    } else {
      env[binding] = {
        type: "secrets-store-secret",
        storeId: LOCAL_SECRETS_STORE_ID,
        secretName: suffixedName(appWorker, binding),
      };
    }
  }
}

/**
 * The manifest's Analytics Engine datasets, which every one of the app's
 * Workers writes to: the `dataset` an entry names, or
 * `<app worker>--<binding>`. Deployed, the app's Worker name is the build's
 * placeholder, which the install rewrites like every other; a named
 * dataset holds none and stays as written.
 */
function addAnalyticsEngineBindings(
  env: Record<string, EveryAppBinding>,
  manifest: EveryAppWorkerManifest,
  appWorker: string,
): void {
  for (const entry of manifest.resources?.analyticsEngine ?? []) {
    if (env[entry.name]) {
      throw new Error(
        `analyticsEngine: ${entry.name} reuses a binding name the Worker already has.`,
      );
    }
    env[entry.name] = {
      type: "analytics-engine-dataset",
      name: entry.dataset ?? suffixedName(appWorker, entry.name),
    };
  }
}

/**
 * DATABASE_PROVIDER and the Hyperdrive configs one of the app's Workers
 * binds: each config every Worker shares, and those a helper (`forWorker`)
 * alone takes. Deployed, each is the config the deploy provisioned; in
 * development, a local Postgres URL set as
 * CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<binding>, or nothing.
 */
function addDatabaseBindings(
  env: Record<string, EveryAppBinding>,
  options: Pick<
    EveryAppWorkerOptions<EveryAppWorkerManifest, unknown>,
    "manifest" | "root" | "ctx"
  >,
  appWorker: string,
  forWorker: string | undefined,
  deploy: EveryAppDeployTarget | undefined,
): void {
  const { manifest } = options;
  if (manifest.database) {
    env["DATABASE_PROVIDER"] = {
      type: "text",
      value: manifest.database.provider,
    };
  }
  const configs = (manifest.resources?.hyperdrive ?? []).filter(
    (config) => config.worker === undefined || config.worker === forWorker,
  );
  if (configs.length === 0) return;
  const local = deploy
    ? {}
    : localEnv(
        options.root ?? process.cwd(),
        options.ctx.mode ?? "development",
      );
  for (const config of configs) {
    if (env[config.name]) {
      throw new Error(
        `hyperdrive: ${config.name} reuses a binding name the Worker already has.`,
      );
    }
    if (deploy) {
      env[config.name] = {
        type: "hyperdrive",
        id: provisioned(deploy.resources.hyperdrive, config.name).id,
      };
      continue;
    }
    const connectionString = local[`${LOCAL_HYPERDRIVE_PREFIX}${config.name}`];
    if (connectionString) {
      env[config.name] = {
        type: "hyperdrive",
        id: localD1Id(appWorker, config.name),
        dev: { connectionString },
      };
    }
  }
}

/**
 * The placement and limits of one of the app's Workers: deployed, it runs
 * near the database's region; its CPU limit is the manifest's.
 */
function runtimeSettings(
  manifest: EveryAppWorkerManifest,
  limits: WorkerLimits | undefined,
  deploy: EveryAppDeployTarget | undefined,
): { placement?: EveryAppPlacement; limits?: { cpuMs?: number } } {
  const region = manifest.database?.region;
  return {
    ...(deploy && region ? { placement: { region } } : {}),
    ...(limits?.cpuMs !== undefined ? { limits: { cpuMs: limits.cpuMs } } : {}),
  };
}

/**
 * Durable Object and Workflow bindings, and the classes to export, for one
 * of the app's Workers: the app's own (`forWorker` undefined) binds every
 * class, each in the Worker that defines it, and a helper Worker binds only
 * its own. Each Worker exports the classes it defines. Workflow names are
 * account-wide, so all of them are named after the app's Worker.
 */
function classBindings(
  manifest: EveryAppWorkerManifest,
  appWorker: string,
  forWorker: string | undefined,
  /** The bindings the Worker already has, which no class may reuse. */
  taken: Readonly<Record<string, EveryAppBinding>>,
): {
  bindings: Record<string, DurableObjectBinding | WorkflowBinding>;
  exports: Record<string, DurableObjectExport | WorkflowExport>;
} {
  const bindings: Record<string, DurableObjectBinding | WorkflowBinding> = {};
  const exports: Record<string, DurableObjectExport | WorkflowExport> = {};
  const definedHere = (resource: ClassResource) =>
    resource.worker === forWorker;
  const definingWorker = (resource: ClassResource) =>
    resource.worker ? helperWorkerName(appWorker, resource.worker) : appWorker;

  for (const durableObject of manifest.resources?.durableObjects ?? []) {
    if (forWorker !== undefined && !definedHere(durableObject)) continue;
    bindings[durableObject.name] = {
      type: "durable-object",
      worker: definingWorker(durableObject),
      exportName: durableObject.className,
    };
    if (definedHere(durableObject)) {
      exports[durableObject.className] = {
        type: "durable-object",
        storage: "sqlite",
      };
    }
  }
  // The defining Worker exports each Workflow, and every Worker that binds
  // one can start it and look up its instances.
  for (const workflow of manifest.resources?.workflows ?? []) {
    if (forWorker !== undefined && !definedHere(workflow)) continue;
    if (
      taken[workflow.name] ||
      bindings[workflow.name] ||
      exports[workflow.className]
    ) {
      throw new Error(
        `workflows: ${workflow.name} (${workflow.className}) reuses a binding or class name the Worker already has.`,
      );
    }
    const workflowName = workflowNameFor(appWorker, workflow.name);
    if (workflowName.length > MAX_WORKFLOW_NAME_LENGTH) {
      throw new Error(
        `workflows: ${workflow.name} would be the Workflow "${workflowName}", longer than Cloudflare's ${MAX_WORKFLOW_NAME_LENGTH} characters; shorten the binding name.`,
      );
    }
    bindings[workflow.name] = {
      type: "workflow",
      name: workflowName,
      worker: definingWorker(workflow),
      exportName: workflow.className,
    };
    if (definedHere(workflow)) {
      exports[workflow.className] = { type: "workflow", name: workflowName };
    }
  }
  return { bindings, exports };
}

/**
 * Check the names of the manifest's `secrets` and `settings`, and in dev
 * declare the ones set locally (a setting that isn't, with its default),
 * with the developer's own keys for the manifest's providers and
 * capabilities.
 */
function addSecrets(
  env: Record<string, EveryAppBinding>,
  options: Pick<
    EveryAppWorkerOptions<EveryAppWorkerManifest, unknown>,
    "manifest" | "root" | "ctx"
  >,
  deploy: EveryAppDeployTarget | undefined,
): void {
  const settings = options.manifest.settings ?? [];
  const secrets = [
    ...manifestSecretNames(options.manifest),
    ...settings.map((setting) => setting.name),
  ];
  const settingNames = new Set(settings.map((setting) => setting.name));
  for (const secret of secrets) {
    const field = settingNames.has(secret) ? "settings" : "secrets";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) {
      throw new Error(`${field}: "${secret}" isn't a valid binding name.`);
    }
    if (env[secret] || RESERVED_SECRET_NAME.test(secret)) {
      throw new Error(
        `${field}: ${secret} is a name the deploy sets or a binding it builds.`,
      );
    }
  }
  if (!deploy) {
    // With `.dev.vars` setting it, EVERYAPP_EMAIL_SENDERS stands in for the
    // senders a gateway holds for an installation (`everyapp email set`).
    const names = new Set([
      ...secrets,
      ...devGatewayKeys(options.manifest),
      ...devProviderKeys(options.manifest, options.root),
      ...(options.manifest.capabilities?.["email"]
        ? ["EVERYAPP_EMAIL_SENDERS"]
        : []),
    ]);
    for (const secret of locallySetSecrets(
      options.root ?? process.cwd(),
      options.ctx.mode ?? "development",
      [...names].filter((name) => !env[name]),
    )) {
      env[secret] = { type: "secret" };
    }
    // A setting nobody set locally reads its default, as a deployed one does.
    for (const setting of settings) {
      if (!env[setting.name] && setting.default !== undefined) {
        env[setting.name] = { type: "text", value: setting.default };
      }
    }
  }
}

/** The {@link DEV_GATEWAY_KEYS} of the manifest's providers and capabilities. */
function devGatewayKeys(manifest: EveryAppWorkerManifest): string[] {
  const keysOf = (
    table: Record<string, readonly string[]>,
    id: string,
  ): readonly string[] => (Object.hasOwn(table, id) ? table[id]! : []);
  return [
    ...manifestProviderIds(manifest).flatMap((provider) =>
      keysOf(DEV_GATEWAY_KEYS.providers, provider),
    ),
    ...Object.keys(manifest.capabilities ?? {}).flatMap((id) =>
      keysOf(DEV_GATEWAY_KEYS.capabilities, id),
    ),
  ];
}

/** `nodejs_compat`, then the app's own flags, each once. */
function compatibilityFlags(flags: readonly string[] | undefined): string[] {
  return [...new Set(["nodejs_compat", ...(flags ?? [])])];
}

function cronTriggers(
  crons: readonly string[] | undefined,
): ScheduledTrigger[] {
  return (crons ?? []).map((schedule): ScheduledTrigger => {
    if (!/^\S+( \S+){4}$/.test(schedule)) {
      throw new Error(
        `crons: "${schedule}" isn't a five-field cron schedule, e.g. "0 6 * * *".`,
      );
    }
    return { type: "scheduled", schedule };
  });
}

function observability(): EveryAppObservability {
  return {
    ...EVERYAPP_OBSERVABILITY,
    logs: { ...EVERYAPP_OBSERVABILITY.logs },
    traces: { ...EVERYAPP_OBSERVABILITY.traces },
    issues: { ...EVERYAPP_OBSERVABILITY.issues },
  };
}

/**
 * The Workflow a binding defines, named after the app's Worker:
 * `every-acme-seo` and `RANK_CHECK` → `every-acme-seo--rank-check`.
 * Workflow names are unique in the account, and new app ids can't contain
 * `--`, so one app's Workflow is never named like another app's.
 */
export function workflowNameFor(workerName: string, binding: string): string {
  return `${workerName}--${binding.toLowerCase().replaceAll("_", "-")}`;
}

/**
 * The local D1 database id for a binding: a 32-hex string, because
 * `cf d1 … --local` rejects names. The everyapp CLI computes the same id to
 * apply local migrations to the database `cf dev` serves.
 */
export function localD1Id(workerName: string, binding: string): string {
  return createHash("sha256")
    .update(`${workerName}:${binding}`)
    .digest("hex")
    .slice(0, 32);
}

/** Where `cf dev` keeps D1 databases, under the app's state directory. */
const LOCAL_D1_OBJECT = "miniflare-D1DatabaseObject";

/**
 * The sqlite file `cf dev` (and `cf d1 … --local`) keeps the local D1
 * database `databaseId` in, under the app at `root`, for tools such as
 * drizzle-kit studio: `.cloudflare/state/v3/d1/miniflare-D1DatabaseObject/
 * <hash>.sqlite`. The database is a Durable Object named after its id, and
 * the file after that object's id. `databaseId` is the {@link localD1Id}.
 */
export function localD1Path(root: string, databaseId: string): string {
  return path.join(
    root,
    ".cloudflare",
    "state",
    "v3",
    "d1",
    LOCAL_D1_OBJECT,
    `${durableObjectIdFromName(LOCAL_D1_OBJECT, databaseId)}.sqlite`,
  );
}

/** The id workerd's `idFromName(name)` gives in the namespace `uniqueKey`. */
function durableObjectIdFromName(uniqueKey: string, name: string): string {
  const key = createHash("sha256").update(uniqueKey).digest();
  const nameHmac = createHmac("sha256", key)
    .update(name)
    .digest()
    .subarray(0, 16);
  const hmac = createHmac("sha256", key)
    .update(nameHmac)
    .digest()
    .subarray(0, 16);
  return Buffer.concat([nameHmac, hmac]).toString("hex");
}

/**
 * The `secrets` set for local dev, read the way the Vite plugin reads them:
 * `.dev.vars[.<mode>]` alone when present, otherwise `.env` files and the
 * process environment.
 */
function locallySetSecrets(
  root: string,
  mode: string,
  names: readonly string[],
): string[] {
  if (names.length === 0) return [];
  const values = localEnv(root, mode);
  return names.filter((name) => values[name]);
}

/** The values local dev sees, read as the Vite plugin reads them. */
function localEnv(
  root: string,
  mode: string,
): Record<string, string | undefined> {
  const read = (name: string): Record<string, string | undefined> => {
    const file = path.join(root, name);
    return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
  };
  const devVars = [`.dev.vars.${mode}`, ".dev.vars"].find((name) =>
    fs.existsSync(path.join(root, name)),
  );
  return devVars
    ? read(devVars)
    : {
        ...read(".env"),
        ...read(".env.local"),
        ...read(`.env.${mode}`),
        ...read(`.env.${mode}.local`),
        ...process.env,
      };
}

/** The dev Worker name, e.g. "todo" -> "every-todo". */
function workerNameFor(appId: string): string {
  return appId.startsWith("every-") ? appId : `every-${appId}`;
}

/**
 * Copies of the gateway's naming rules (@every-app/perimeter/manifest's
 * resourceNameFor, bucketNameFor, vectorizeNameFor and storeSecretNameFor):
 * `DB` and `KV` (`R2` for a bucket) take the Worker's name, any other
 * binding (and every Vectorize index and Secrets Store secret)
 * `<worker>--<binding>`.
 */
function resourceNameFor(workerName: string, binding: string): string {
  return binding === "DB" || binding === "KV"
    ? workerName
    : suffixedName(workerName, binding);
}

function bucketNameFor(workerName: string, binding: string): string {
  return binding === "R2" ? workerName : suffixedName(workerName, binding);
}

/** A copy of @every-app/perimeter/manifest's queueNameFor: `<worker>--<binding>`. */
function queueNameFor(workerName: string, binding: string): string {
  return suffixedName(workerName, binding);
}

function suffixedName(workerName: string, binding: string): string {
  return `${workerName}--${binding.toLowerCase().replaceAll("_", "-")}`;
}

/**
 * A copy of the gateway's aiGatewayIdFor: one hyphen, since an AI
 * Gateway's id may not hold `--`.
 */
function aiGatewayIdFor(workerName: string, binding: string): string {
  return `${workerName}-${binding.toLowerCase().replaceAll("_", "-")}`;
}

function assertAppId(id: unknown): void {
  if (typeof id !== "string" || !/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(id)) {
    throw new Error(
      `everyapp.config.ts id must be kebab-case (lowercase letters, digits, hyphens); got ${JSON.stringify(id)}.`,
    );
  }
}

/** The target's resource for a manifest binding, which it always has. */
function provisioned<T>(
  resources: Record<string, T> | undefined,
  binding: string,
): T {
  const resource = resources?.[binding];
  if (resource === undefined) {
    throw new Error(`The build has no placeholder for binding "${binding}".`);
  }
  return resource;
}
