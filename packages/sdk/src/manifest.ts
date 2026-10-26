/**
 * The manifest an app author writes as `everyapp.config.ts`, typed:
 *
 *   import { defineEveryApp } from "@every-app/sdk";
 *
 *   export default defineEveryApp({
 *     id: "notes",
 *     name: "Notes",
 *     resources: { d1: ["DB"] },
 *   });
 *
 * Types only, and a leaf module: `cloudflare.config.ts` imports the manifest,
 * and the Cloudflare Vite plugin hides from the Worker every file the config
 * imports. The rules beyond the shape (which ids exist, which names are
 * reserved, which scope sets a provider has) are the CLI's: `everyapp deploy`
 * and `everyapp dev` validate the manifest and say what is wrong. The
 * perimeter's schema (`@every-app/perimeter/manifest`) is held to this type
 * by a test there.
 *
 * The Worker reads the manifest back as `env.EVERYAPP_MANIFEST`, which
 * `everyAppWorker()` sets and `cf workers types` types from the file.
 */

/** Why a setting is needed and whether the app opens without it (the settings model). */
export interface EveryAppSettingNeed {
  /** Why the app needs it, for whoever sets it. At most 200 characters. */
  readonly why?: string;
  /** An https page that says where the key or client comes from. */
  readonly docs?: string;
  /** The app opens without it; the feature using it says what is missing. */
  readonly optional?: boolean;
  /** The group of which one member is enough ("AI model"). */
  readonly anyOf?: string;
}

/** A route reachable without a signed-in member. */
export interface EveryAppPublicRoute {
  /** Absolute glob: `*` matches one segment, `**` one or more. */
  readonly path: string;
  /** The methods it answers; `["GET"]` when left out. */
  readonly methods?: readonly string[];
}

/** A Durable Object or Workflow class: its binding, the class, and the helper Worker that defines it. */
export interface EveryAppClassResource {
  readonly name: string;
  readonly className: string;
  readonly worker?: string;
}

/** A Cloudflare Queue's consumer settings. */
export interface EveryAppQueueConsumer {
  readonly worker?: string;
  readonly maxBatchSize?: number;
  readonly maxBatchTimeout?: number;
  readonly maxRetries?: number;
  readonly maxConcurrency?: number | null;
  readonly retryDelay?: number;
  readonly visibilityTimeoutMs?: number;
  readonly deadLetterQueue?: string;
}

/** Cloudflare's limits for one of the app's Workers. */
export interface EveryAppWorkerLimits {
  /** CPU milliseconds an invocation may use, up to 300000. */
  readonly cpuMs?: number;
}

/** The Cloudflare resources the app's Workers bind; the deploy creates them. */
export interface EveryAppResources {
  readonly d1?: readonly string[];
  readonly kv?: readonly string[];
  readonly r2?: readonly string[];
  readonly durableObjects?: readonly EveryAppClassResource[];
  readonly workflows?: readonly EveryAppClassResource[];
  readonly hyperdrive?: readonly {
    readonly name: string;
    readonly worker?: string;
    readonly caching?: "off" | "default";
  }[];
  readonly queues?: readonly {
    readonly name: string;
    readonly consumer?: true | EveryAppQueueConsumer;
  }[];
  readonly ai?: readonly string[];
  readonly browser?: readonly string[];
  readonly images?: readonly string[];
  readonly vectorize?: readonly {
    readonly name: string;
    readonly dimensions?: number;
    readonly metric?: "cosine" | "euclidean" | "dot-product";
    /** A Workers AI embedding model's shape, instead of `dimensions` and `metric`. */
    readonly preset?:
      | "@cf/baai/bge-small-en-v1.5"
      | "@cf/baai/bge-base-en-v1.5"
      | "@cf/baai/bge-large-en-v1.5"
      | "openai/text-embedding-ada-002"
      | "cohere/embed-multilingual-v2.0";
  }[];
  readonly aiGateway?: readonly {
    readonly name: string;
    readonly collectLogs?: boolean;
    readonly cacheTtl?: number;
  }[];
  readonly sendEmail?: readonly {
    readonly name: string;
    readonly allowedSenderAddresses: readonly string[];
    readonly destinationAddress?: string;
    readonly allowedDestinationAddresses?: readonly string[];
  }[];
  readonly secretsStore?: readonly { readonly name: string }[];
  readonly analyticsEngine?: readonly {
    readonly name: string;
    readonly dataset?: string;
  }[];
}

/** One capability the Gateway serves the app with keys it holds. */
export interface EveryAppCapabilityEntry extends EveryAppSettingNeed {
  readonly access: "read" | "write";
  /** An OAuth client's scope sets, by name (`["gmail.read"]`). */
  readonly scopes?: readonly string[];
}

/**
 * One of the app's plain settings: a value that isn't a secret and
 * differs per install (a PostHog host, a region), set with `everyapp
 * configure <app>` and read from `env`.
 */
export interface EveryAppSettingEntry {
  readonly name: string;
  /** Why the app needs it: what whoever installs the app reads. */
  readonly why: string;
  readonly docs?: string;
  readonly optional?: boolean;
  /** What it takes; text when not given. */
  readonly type?: "text" | "url" | "number" | "boolean";
  /** The values a text setting may take. */
  readonly values?: readonly string[];
  /** What the app reads while nobody has set it; the deploy writes it. */
  readonly default?: string;
}

/** One of the app's own secrets, with its need. */
export interface EveryAppSecretEntry extends EveryAppSettingNeed {
  readonly name: string;
  /** Its guide in the everyapp skill (`"setup/main-secret.md"`). */
  readonly setup?: string;
}

/** `everyapp.config.ts`. */
export interface EveryAppManifest {
  /** Stable id, kebab-case: the app's hostname and Worker. */
  readonly id: string;
  readonly name?: string;
  /** The one line the Gateway's app library shows under the name. */
  readonly description?: string;
  /** The path of an SVG the app serves (`"/everyapp-icon.svg"`). */
  readonly icon?: string;
  /** Legacy: the entry comes from `cloudflare.config.ts`. */
  readonly main?: string;
  /** YYYY-MM-DD. */
  readonly compatibilityDate?: string;
  readonly resources?: EveryAppResources;
  /** Helper Workers deployed beside the app's as `<app worker>--<name>`. */
  readonly workers?: readonly {
    readonly name: string;
    readonly binding?: string;
    readonly limits?: EveryAppWorkerLimits;
  }[];
  readonly database?: {
    readonly provider: "d1" | "postgres";
    /** A cloud region such as `"aws:us-east-1"`. */
    readonly region?: string;
  };
  readonly limits?: EveryAppWorkerLimits;
  /** Routes open without a signed-in member. Default: none. */
  readonly public?: readonly EveryAppPublicRoute[];
  /**
   * Static files of the asset bundle anyone may fetch (favicons, icons, an
   * OG image): path patterns, GET and HEAD, never Worker code.
   */
  readonly publicAssets?: readonly string[];
  /** AI providers the Gateway calls for the app, by id or with their need. */
  readonly providers?: readonly (
    | string
    | (EveryAppSettingNeed & { readonly id: string })
  )[];
  /** Capabilities by id (`members`, `email`, `dataforseo`, …). */
  readonly capabilities?: { readonly [id: string]: EveryAppCapabilityEntry };
  /** The app's own secrets, by name or with their need. */
  readonly secrets?: readonly (string | EveryAppSecretEntry)[];
  /** The app's plain settings: per-install values that aren't secrets. */
  readonly settings?: readonly EveryAppSettingEntry[];
  /** App-domain scopes personal access tokens may request, with descriptions. */
  readonly scopes?: { readonly [scope: string]: string };
  readonly ai?: {
    /** Model ids the app may request; any other is `model_not_allowed`. */
    readonly models?: readonly string[];
    /** OpenAI API paths beyond inference (`"/v1/files"`). */
    readonly routes?: readonly string[];
    /** The app takes the Gateway's default chat model (`ai()`). */
    readonly chat?: boolean | EveryAppSettingNeed;
  };
  /** `inbound: true`: the Worker exports an `email()` handler. */
  readonly email?: { readonly inbound?: boolean };
  /** Who can open the app once registered; `"admins"` by default. */
  readonly access?: "everyone" | "admins";
  readonly serverFnGuard?: boolean;
  readonly serverFnBase?: string;
  /** Shell command that builds the app; `cf build` by default. */
  readonly build?: string;
  /** Shell command `everyapp dev` starts; it must listen on PORT. */
  readonly dev?: string;
  /** Legacy: the port comes from PORT. */
  readonly devPort?: number;
  /** Dependency install command; false skips it. */
  readonly install?: false | string;
  readonly migrations?: {
    readonly engine: "drizzle" | "d1-sql" | "prisma";
    readonly dialect?: "sqlite" | "postgresql";
    readonly dir?: string;
    readonly config?: string;
    readonly binding?: string;
  };
  /** Who answers `/mcp` on the app's own host, and why it needs to. */
  readonly mcp?: { readonly by: "gateway" | "app"; readonly why: string };
}

/**
 * Type `everyapp.config.ts` without widening it: the literal binding names
 * stay, so `everyAppWorker()` types `env.DB` and `env.EVERYAPP_MANIFEST`
 * from them. Returns the manifest as given.
 */
export function defineEveryApp<const M extends EveryAppManifest>(
  manifest: M,
): M {
  return manifest;
}
