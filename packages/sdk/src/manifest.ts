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
 * reserved, which scopes a provider takes) are the CLI's: `everyapp deploy`
 * and `everyapp dev` validate the manifest and say what is wrong. The
 * perimeter's schema (`@every-app/perimeter/manifest`) is held to this type
 * by a test there.
 *
 * The Worker reads the manifest back as `env.EVERYAPP_MANIFEST`, which
 * `everyAppWorker()` sets and `cf workers types` types from the file.
 */

/**
 * Why a setting is needed (the settings model). Everything listed at the
 * top level is required; what the app works without goes in an optional
 * feature (`features`).
 */
export interface EveryAppSettingNeed {
  /** Why the app needs it, for whoever sets it. At most 200 characters. */
  readonly why?: string;
  /** An https page that says where the key or client comes from. */
  readonly docs?: string;
}

/** A route reachable without a signed-in member. */
export interface EveryAppPublicRoute {
  /** Absolute glob: `*` matches one segment, `**` one or more. */
  readonly path: string;
  /** The methods it answers; `["GET"]` when left out. */
  readonly methods?: readonly string[];
  /**
   * A bearer route: a native app or a script reaches it with its Gateway
   * token only, on every method (no `methods`). The Gateway answers 401 to
   * a request carrying its session cookie there, and Cloudflare Access
   * lets it through like any public route.
   */
  readonly bearer?: true;
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
  readonly artifacts?: readonly { readonly name: string }[];
}

/**
 * One capability the Gateway serves the app with: an API-key provider or
 * a service, by `access`; an OAuth provider, by the provider's own scopes.
 */
export type EveryAppCapabilityEntry =
  | EveryAppKeyCapabilityEntry
  | EveryAppOAuthCapabilityEntry;

/** A provider whose key the Gateway holds, or a Gateway service. */
export interface EveryAppKeyCapabilityEntry extends EveryAppSettingNeed {
  readonly access: "read" | "write";
  readonly scopes?: never;
}

/**
 * An OAuth provider (`google-workspace`, `github`): the provider's own
 * scope strings the app needs, short (`gmail.modify`) or in full. A person
 * connects in the app for exactly these; the Gateway adds the scopes that
 * name the account, and refuses a token that carries more.
 */
export interface EveryAppOAuthCapabilityEntry extends EveryAppSettingNeed {
  readonly scopes: readonly string[];
  /** Why the app needs it, shown where people connect. At most 200 characters. */
  readonly why: string;
  readonly access?: never;
}

/**
 * One of the app's plain settings: a value that isn't a secret and
 * differs per install (a PostHog host, a region), set with `everyapp
 * configure <app>` and read from `env`.
 */
export interface EveryAppSettingEntry extends EveryAppFeatureSettingEntry {
  /** Why the app needs it: what whoever installs the app reads. */
  readonly why: string;
  readonly docs?: string;
}

/** A plain setting in a feature: the feature says why. */
export interface EveryAppFeatureSettingEntry {
  readonly name: string;
  /** Where the value is and what it needs, for whoever sets it (200 characters at most; `{appUrl}`, `{gatewayUrl}` are filled in). */
  readonly how?: string;
  /** What it takes; text when not given. */
  readonly type?: "text" | "url" | "number" | "boolean";
  /** The values a text setting may take. */
  readonly values?: readonly string[];
  /** What the app reads while nobody has set it; the deploy writes it. */
  readonly default?: string;
}

/** One of the app's own secrets in a feature: the feature says why. */
export interface EveryAppFeatureSecretEntry {
  readonly name: string;
  /** Where the value is and what permission it needs (200 characters at most; `{appUrl}`, `{gatewayUrl}` are filled in). */
  readonly how?: string;
  /** `everyapp configure` makes it (32 random bytes, base64url) when unset; shown once when `how` says where to paste it. */
  readonly generate?: boolean;
  /** The value is a file's contents (a .pem): the prompt takes the file's path. */
  readonly file?: boolean;
}

/** One of the app's own secrets. */
export interface EveryAppSecretEntry
  extends EveryAppSettingNeed, EveryAppFeatureSecretEntry {}

/**
 * One feature: a named group of secrets, settings and Gateway capabilities
 * with numbered setup steps. A required one keeps the app closed until it
 * is set; an optional one (the default) is all or nothing.
 */
export interface EveryAppFeature {
  /** What people read: "GitHub". */
  readonly name: string;
  /** Default false: the app opens without it. */
  readonly required?: boolean;
  /** What it gives the app, in one sentence (200 characters at most). */
  readonly why: string;
  /** Short Markdown lines, numbered when shown; links as plain URLs or `[text](url)`; `{appUrl}`, `{gatewayUrl}` are filled in. */
  readonly steps?: readonly string[];
  readonly settings?: readonly EveryAppFeatureSettingEntry[];
  readonly secrets?: readonly (string | EveryAppFeatureSecretEntry)[];
  /** Capabilities it needs, by id; each declared under `capabilities` too. */
  readonly capabilities?: readonly string[];
  /** AI providers it needs, by id; each declared under `providers` too. */
  readonly providers?: readonly string[];
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
  /** Features by id (a lowercase slug): what the app needs set, grouped, with setup steps. */
  readonly features?: { readonly [id: string]: EveryAppFeature };
  readonly ai?: {
    /** Model ids the app may request; any other is `model_not_allowed`. */
    readonly models?: readonly string[];
    /** OpenAI API paths beyond inference (`"/v1/files"`). */
    readonly routes?: readonly string[];
    /** The app takes the workspace's default chat model (`/api/ai/default`, `aiBaseUrl()`). */
    readonly chat?: boolean | EveryAppSettingNeed;
  };
  /** `inbound: true`: the Worker exports an `email()` handler. */
  readonly email?: { readonly inbound?: boolean };
  /** Who can open the app once registered; `"admins"` by default. */
  readonly access?: "everyone" | "admins";
  /** Shell command that builds the app; `cf build` by default (`--mode production` without Vite). */
  readonly build?: string;
  /** Shell command `everyapp dev` starts; it must listen on PORT. */
  readonly dev?: string;
  /** Dependency install command; false skips it. */
  readonly install?: false | string;
  readonly migrations?: {
    readonly engine: "drizzle" | "d1-sql" | "prisma";
    readonly dialect?: "sqlite" | "postgresql";
    readonly dir?: string;
    readonly config?: string;
    readonly binding?: string;
  };
  /**
   * The Gateway events the app receives at `everyApp(handler, { events: {
   * on } })`: types or patterns from `member.*` (but `member.password_reset`),
   * `group.*`, `app.*`, `mcp_app.*`, `connection.*` and `tool.*`, for the
   * app's own organization. Anything else is refused at deploy.
   */
  readonly events?: {
    readonly subscribe: readonly string[];
    readonly why: string;
  };
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
