import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { DEV_ISSUER, DEV_PUBLIC_KEY_PEM } from "../dev/keypair.js";
import {
  DEPLOY_INPUTS_FILE,
  readDeployInputs,
  type EveryAppDeployInputs,
} from "./deployInputs.js";

/** A Durable Object or Workflow class, and the helper Worker defining it. */
interface ClassResource {
  readonly name: string;
  readonly className: string;
  /** A helper Worker (`workers`) that defines the class; the app's own when unset. */
  readonly worker?: string;
}

/** The fields of `everyapp.config.ts` the Worker definition is built from. */
export interface EveryAppWorkerManifest {
  id: string;
  compatibilityDate?: string;
  resources?: {
    d1?: readonly string[];
    kv?: readonly string[];
    durableObjects?: readonly ClassResource[];
    workflows?: readonly ClassResource[];
  };
  /**
   * Helper Workers deployed beside the app's Worker as
   * `<app worker>--<name>`, built with {@link everyAppAuxiliaryWorker}.
   * `binding` names the app Worker's service binding to one.
   */
  workers?: readonly { readonly name: string; readonly binding?: string }[];
  /** AI providers the app calls through the gateway (`createGatewayFetch()`). */
  providers?: readonly string[];
  /** Capabilities the app calls through the gateway (`integrationFetch()`). */
  capabilities?: { readonly [id: string]: unknown };
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
  /** App root holding `.everyapp/deploy.json`. Defaults to the working directory. */
  root?: string;
  /**
   * Cron schedules (UTC) that run the Worker's `scheduled` handler, e.g.
   * `"0 6 * * *"` (daily at 06:00). Deploys keep them; an app can't declare
   * routes.
   */
  crons?: readonly string[];
  /**
   * The app's own secrets, e.g. an API key it calls out with. A deployed
   * Worker gets them from `everyapp secret set`, and later deploys keep
   * them, so production builds don't declare them. In development each one
   * that is set locally is declared, read as the Vite plugin reads secrets
   * (`.dev.vars[.<mode>]` alone when present, otherwise the `.env` files
   * and the environment), so the plugin passes it through. Type them as
   * optional in `src/env.d.ts`.
   *
   * The keys of the manifest's `providers` and `capabilities` need no
   * listing: there's no gateway in development, so each one set locally
   * under the gateway secret's name (OPENAI_API_KEY, DATAFORSEO_API_KEY, …)
   * is declared for the SDK's direct fallback.
   */
  secrets?: readonly string[];
}

// Structural copies of the `cf/config` binding and export shapes this helper
// emits, so the SDK needs no `cf` dependency. The app's own `defineConfig()`
// call type-checks the result against the real ones, and `cf` infers the
// Worker's `Env` from these types, so each binding keeps its own key.
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
export interface DurableObjectBinding {
  type: "durable-object";
  worker: string;
  exportName: string;
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
export type EveryAppBinding =
  | TextBinding
  | SecretBinding
  | D1Binding
  | KvBinding
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

type HelperWorkers<M> = M extends { workers: readonly (infer H)[] } ? H : never;

/**
 * The gateway secrets holding the keys of the AI providers and capabilities
 * an app may ask for. With no gateway in development, the SDK reaches them
 * with the developer's own keys under the same names. A copy of the tables
 * in ../internal, which the Worker loads: the Vite plugin hides whatever
 * cloudflare.config.ts imports from the Worker. A test keeps them in step.
 */
const DEV_GATEWAY_KEYS = {
  providers: { openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" },
  capabilities: {
    dataforseo: "DATAFORSEO_API_KEY",
    context: "CONTEXT_API_KEY",
  },
} as const;
type DevProviderKeys = typeof DEV_GATEWAY_KEYS.providers;
type DevCapabilityKeys = typeof DEV_GATEWAY_KEYS.capabilities;

/** The gateway keys a developer may set locally for the manifest's providers and capabilities. */
type DevGatewayKeys<M> =
  | (M extends { providers: readonly (infer P)[] }
      ? P extends keyof DevProviderKeys
        ? DevProviderKeys[P]
        : never
      : never)
  | (M extends { capabilities: infer C }
      ? keyof C extends infer K
        ? K extends keyof DevCapabilityKeys
          ? DevCapabilityKeys[K]
          : never
        : never
      : never);

type ResourceEnv<M> = { [B in D1Names<M>]: D1Binding } & {
  [B in KvNames<M>]: KvBinding;
} & {
  [D in DurableObjects<M> as D extends { name: infer N extends string }
    ? N
    : never]: DurableObjectBinding;
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
type SharedEnv = {
  EVERYAPP_APP_ID: TextBinding;
  CF_VERSION_METADATA: VersionMetadataBinding;
};

/**
 * Bindings in development: the well-known dev identity, as plain text, and
 * the developer's own gateway keys (when set).
 */
export type EveryAppDevEnv<M> = ResourceEnv<M> &
  SharedEnv & {
    EVERYAPP_DEV: TextBinding;
    EVERYAPP_IDENTITY_PUBLIC_KEYS: TextBinding;
    EVERYAPP_IDENTITY_ISSUER: TextBinding;
  } & { [K in DevGatewayKeys<M>]: SecretBinding };

/** Bindings in production: the deployed identity and the gateway binding. */
export type EveryAppDeployEnv<M> = ResourceEnv<M> &
  SharedEnv & {
    EVERYAPP_AUDIENCE: TextBinding;
    EVERYAPP_IDENTITY_PUBLIC_KEYS: TextBinding;
    EVERYAPP_IDENTITY_ISSUER: TextBinding;
    EVERY_APP_GATEWAY: GatewayBinding;
    GATEWAY_URL: SecretBinding;
    /** The owning organization; a shared app serves every one and has none. */
    EVERY_APP_ORG_ID?: SecretBinding;
    /** `1` on a shared app's Workers: gateway calls say whom they are for. */
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

/** Structural copy of cf's scheduled (cron) trigger. */
export interface ScheduledTrigger {
  type: "scheduled";
  schedule: string;
}

export interface EveryAppWorkerConfig<M, TEntrypoint> {
  name: string;
  entrypoint: TEntrypoint;
  compatibilityDate: string;
  compatibilityFlags: string[];
  workersDev: false;
  previewUrls: false;
  /** The `crons` option's schedules; absent without any. */
  triggers?: ScheduledTrigger[];
  observability: EveryAppObservability;
  /** Either branch, so `Env` marks dev-only and deploy-only bindings optional. */
  env: EveryAppDevEnv<M> | EveryAppDeployEnv<M>;
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
/** Names the deploy sets itself (as `everyapp secret set` refuses). */
const RESERVED_SECRET_NAME =
  /^(GATEWAY_URL|CF_VERSION_METADATA|EVERYAPP_\w*|EVERY_APP_\w*|APP__\w*)$/i;
const GATEWAY_WORKER_NAME = "every-app-gateway";
const GATEWAY_ENTRYPOINT = "AppGateway";
/** Cloudflare's limit on a Workflow's name. */
const MAX_WORKFLOW_NAME_LENGTH = 64;
/** Cloudflare's limit on a Worker's name. */
const MAX_WORKER_NAME_LENGTH = 63;

/**
 * Build the Worker definition for an Every App app from its manifest.
 *
 * - `development` (cf dev) and no mode (cf API commands, `cf workers types`):
 *   EVERYAPP_DEV is on, the identity keys and issuer are the well-known dev
 *   ones (`@every-app/sdk/dev`) as plain text, so nothing needs writing to
 *   `.dev.vars`, and each D1 database gets a fixed local id (see
 *   {@link localD1Id}) that `cf d1 … --local` can address.
 * - `production`: everything deploy-specific comes from `.everyapp/deploy.json`,
 *   which only `everyapp deploy` writes. Without it this throws, so a bare
 *   `cf deploy` can't ship a Worker without identity keys.
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
      value: deploy.identityIssuer,
    };
    env["EVERY_APP_GATEWAY"] = gatewayBinding(deploy, manifest.id, name);
    // Sent by the deploy pipeline through `cf deploy --secrets-file`.
    env["GATEWAY_URL"] = { type: "secret" };
    if (!deploy.shared) env["EVERY_APP_ORG_ID"] = { type: "secret" };
    else env["EVERYAPP_SHARED"] = { type: "text", value: "1" };
  } else {
    env["EVERYAPP_DEV"] = { type: "text", value: "1" };
    env["EVERYAPP_IDENTITY_PUBLIC_KEYS"] = {
      type: "text",
      value: JSON.stringify([DEV_PUBLIC_KEY_PEM]),
    };
    env["EVERYAPP_IDENTITY_ISSUER"] = { type: "text", value: DEV_ISSUER };
  }

  Object.assign(env, storageBindings(manifest, name, deploy));
  // The app binds every class, a helper Worker's in that Worker, and
  // exports only its own.
  const { bindings, exports: ownClasses } = classBindings(
    manifest,
    name,
    undefined,
    env,
  );
  Object.assign(env, bindings);
  // Deleted classes are tombstones the deploy adds at runtime; they bind
  // nothing, so the exports type only names the live classes.
  const exports: Record<
    string,
    | DurableObjectExport
    | WorkflowExport
    | { type: "durable-object"; state: "deleted" }
  > = { ...ownClasses };
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
  for (const className of deploy?.deletedDurableObjects ?? []) {
    if (exports[className]) {
      throw new Error(
        `Durable Object class "${className}" is both declared in everyapp.config.ts and marked deleted.`,
      );
    }
    exports[className] = { type: "durable-object", state: "deleted" };
  }

  addSecrets(env, options, deploy);
  const triggers = cronTriggers(options.crons);

  return {
    name,
    entrypoint: options.entrypoint,
    compatibilityDate: manifest.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    ...(triggers.length ? { triggers } : {}),
    observability: observability(),
    env: env as EveryAppDevEnv<M> | EveryAppDeployEnv<M>,
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
  triggers?: ScheduledTrigger[];
  observability: EveryAppObservability;
  env: Record<string, EveryAppBinding>;
  exports: Record<string, DurableObjectExport | WorkflowExport>;
}

/**
 * Build the definition of one of the app's helper Workers (the manifest's
 * `workers`), e.g. one that runs a memory-hungry job away from the app's
 * Worker. It is named `<app worker>--<worker>`, is private like the app, and
 * binds the app's D1 databases and KV namespaces, the classes it defines, and
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
  if (!manifest.workers?.some((helper) => helper.name === worker)) {
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
  if (deploy) {
    // The app's identity: the gateway treats its helper Workers as the app.
    env["EVERY_APP_GATEWAY"] = gatewayBinding(deploy, manifest.id, appWorker);
    if (deploy.shared) env["EVERYAPP_SHARED"] = { type: "text", value: "1" };
  } else {
    env["EVERYAPP_DEV"] = { type: "text", value: "1" };
  }
  const { bindings, exports } = classBindings(manifest, appWorker, worker, env);
  Object.assign(env, bindings);
  addSecrets(env, options, deploy);
  const triggers = cronTriggers(options.crons);

  return {
    name,
    entrypoint: options.entrypoint,
    compatibilityDate: manifest.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    ...(triggers.length ? { triggers } : {}),
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

/** The deploy inputs (in production) and the app Worker's name. */
function appWorkerName(
  options: Pick<
    EveryAppWorkerOptions<EveryAppWorkerManifest, unknown>,
    "manifest" | "ctx" | "root"
  >,
  builder: string,
): { deploy: EveryAppDeployInputs | undefined; name: string } {
  const { manifest, ctx } = options;
  assertAppId(manifest.id);

  let deploy: EveryAppDeployInputs | undefined;
  if (ctx.mode === "production") {
    deploy = readDeployInputs(options.root ?? process.cwd());
    if (!deploy) {
      throw new Error(
        `${DEPLOY_INPUTS_FILE} not found. Every App Workers are built for production only by \`everyapp deploy\` (\`pnpm run deploy\`); ` +
          "a bare `cf build` or `cf deploy` would ship a Worker without identity keys or its gateway binding. " +
          "For a local build, run Vite in development mode (`vite build --mode development`).",
      );
    }
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
  deploy: EveryAppDeployInputs,
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

/** The app's D1 databases and KV namespaces, which all its Workers share. */
function storageBindings(
  manifest: EveryAppWorkerManifest,
  appWorker: string,
  deploy: EveryAppDeployInputs | undefined,
): Record<string, D1Binding | KvBinding> {
  const env: Record<string, D1Binding | KvBinding> = {};
  for (const binding of manifest.resources?.d1 ?? []) {
    if (deploy) {
      const d1 = deploy.resources.d1?.[binding];
      if (!d1) throw missingResource("D1 database", binding);
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
      const kv = deploy.resources.kv?.[binding];
      if (!kv) throw missingResource("KV namespace", binding);
      env[binding] = { type: "kv", id: kv.id };
    } else if (manifest.workers?.length) {
      // The Vite plugin's own default for the app's Worker, named so that
      // its helpers share the namespace in dev, as deployed ones do.
      env[binding] = { type: "kv", id: `${binding}-${appWorker}` };
    } else {
      env[binding] = { type: "kv" };
    }
  }
  return env;
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
 * Check the app's secret names, and in dev declare the ones set locally,
 * with the developer's own keys for the manifest's providers and
 * capabilities.
 */
function addSecrets(
  env: Record<string, EveryAppBinding>,
  options: Pick<
    EveryAppWorkerOptions<EveryAppWorkerManifest, unknown>,
    "manifest" | "secrets" | "root" | "ctx"
  >,
  deploy: EveryAppDeployInputs | undefined,
): void {
  for (const secret of options.secrets ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) {
      throw new Error(`secrets: "${secret}" isn't a valid binding name.`);
    }
    if (env[secret] || RESERVED_SECRET_NAME.test(secret)) {
      throw new Error(
        `secrets: ${secret} is a name the deploy sets or a binding it builds.`,
      );
    }
  }
  if (!deploy) {
    const names = new Set([
      ...(options.secrets ?? []),
      ...devGatewayKeys(options.manifest),
    ]);
    for (const secret of locallySetSecrets(
      options.root ?? process.cwd(),
      options.ctx.mode ?? "development",
      [...names].filter((name) => !env[name]),
    )) {
      env[secret] = { type: "secret" };
    }
  }
}

/** The {@link DEV_GATEWAY_KEYS} of the manifest's providers and capabilities. */
function devGatewayKeys(manifest: EveryAppWorkerManifest): string[] {
  const keyOf = (table: Record<string, string>, id: string) =>
    Object.hasOwn(table, id) ? [table[id]!] : [];
  return [
    ...(manifest.providers ?? []).flatMap((provider) =>
      keyOf(DEV_GATEWAY_KEYS.providers, provider),
    ),
    ...Object.keys(manifest.capabilities ?? {}).flatMap((id) =>
      keyOf(DEV_GATEWAY_KEYS.capabilities, id),
    ),
  ];
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
  const read = (name: string): Record<string, string | undefined> => {
    const file = path.join(root, name);
    return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
  };
  const devVars = [`.dev.vars.${mode}`, ".dev.vars"].find((name) =>
    fs.existsSync(path.join(root, name)),
  );
  const values: Record<string, string | undefined> = devVars
    ? read(devVars)
    : {
        ...read(".env"),
        ...read(".env.local"),
        ...read(`.env.${mode}`),
        ...read(`.env.${mode}.local`),
        ...process.env,
      };
  return names.filter((name) => values[name]);
}

/** The dev Worker name, e.g. "todo" -> "every-todo". */
function workerNameFor(appId: string): string {
  return appId.startsWith("every-") ? appId : `every-${appId}`;
}

function resourceNameFor(workerName: string, binding: string): string {
  return binding === "DB" || binding === "KV"
    ? workerName
    : `${workerName}-${binding.toLowerCase()}`;
}

function assertAppId(id: unknown): void {
  if (typeof id !== "string" || !/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(id)) {
    throw new Error(
      `everyapp.config.ts id must be kebab-case (lowercase letters, digits, hyphens); got ${JSON.stringify(id)}.`,
    );
  }
}

function missingResource(kind: string, binding: string): Error {
  return new Error(
    `${DEPLOY_INPUTS_FILE} has no ${kind} for binding "${binding}". Deploy with \`everyapp deploy\`, which provisions every resource in everyapp.config.ts.`,
  );
}
