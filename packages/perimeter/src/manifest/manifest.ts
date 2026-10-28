/**
 * Every App application manifest.
 *
 * The manifest is the single source of truth for an app's identity, resources,
 * and public surface. It is authored as `everyapp.config.ts` in an app repo,
 * turned into the Worker definition by the app's `cloudflare.config.ts`
 * (`everyAppWorker()` from `@every-app/sdk/cloudflare`), and snapshotted as a
 * JSON column on the gateway `apps` registry row.
 *
 * This module defines the manifest shape and validators. It is intentionally
 * dependency-light (zod, and the SDK's list of capabilities) so it can be
 * shared by the perimeter package and the CLI without duplicated schema
 * definitions.
 */
import { z } from "zod";
import {
  CATALOG,
  capabilityIdsOf,
  capabilitySettings,
  EMAIL_SET_COMMAND,
  gatewaySettingOwner,
  isCapabilityId,
  isReservedAppSecretName,
  isRemoteMcpSecretName,
  isSignInSettingName,
  isOAuthProvider,
  isSettableGatewaySetting,
  providerEntries,
  RESERVED_APP_SECRET_NAMES_TEXT,
  SCOPE_SET_NAME,
  secretEntries,
  secretNames,
  settingNames,
  settingValueProblem,
  type CapabilityLookup,
  type SettingNeedFields,
} from "@every-app/sdk/internal";
import {
  isMcpPath,
  matchPublicRoute,
  PUBLIC_ASSET_METHODS,
} from "../publicRoutes";
import { GATEWAY_ROOT, gatewayNames, RESOURCE_SEPARATOR } from "./gatewayNames";

/** A single declared public route. Methods default to GET-only when omitted. */
export const PublicRouteSchema = z.object({
  /**
   * Glob path, always absolute. `*` matches a single path segment; `**`
   * matches one-or-more segments. A bare catch-all (`/*`, `/**`, `*`) is a
   * hard error — see {@link validateManifest}.
   */
  path: z.string(),
  /** HTTP methods this public route answers. Defaults to `["GET"]`. */
  methods: z.array(z.string()).optional(),
});
export type PublicRoute = z.infer<typeof PublicRouteSchema>;

/**
 * The most `publicAssets` patterns a manifest may list: each one is an
 * override on the app's Cloudflare Access destination, which holds 25.
 */
export const MAX_PUBLIC_ASSETS = 25;

/**
 * `bearerRoutes: { paths, why }`: the routes a bearer client (a native
 * app, a script with a personal token) reaches with its token only. `paths`
 * are globs with `public[].path`'s syntax and safety rules, every method;
 * `why` the app needs them, shown to the operator as `mcp.why` is. The
 * perimeter refuses a request carrying its session cookie on one (401),
 * so the Cloudflare Access bypass `everyapp access on` makes for these
 * paths opens nothing to a browser. A bearer route is never public, and
 * never `/mcp`.
 */
export const BearerRoutesSchema = z.object({
  paths: z
    .array(z.string())
    .min(1, 'bearerRoutes.paths: list at least one path, such as "/api/**"')
    .max(
      MAX_PUBLIC_ASSETS,
      `bearerRoutes.paths: at most ${MAX_PUBLIC_ASSETS} patterns; use a glob such as "/api/**"`,
    ),
  why: z
    .string()
    .trim()
    .min(1, "bearerRoutes.why: say why the app's routes take a bearer")
    .max(200, "bearerRoutes.why: at most 200 characters"),
});
export type BearerRoutes = z.infer<typeof BearerRoutesSchema>;

// NOTE: the gateway validates manifests sent by DEPLOYED CLIs, which may be
// newer than this code. The base schemas here validate every field the perimeter
// relies on (id, public routes) but deliberately tolerate unknown keys
// (`passthrough`, not `strict`) so an additive manifest change in the CLI
// never bricks app registration until the gateway is redeployed.
/**
 * A Durable Object or Workflow class: its binding name, the class, and the
 * helper Worker that defines it (`workers`), when not the app's own.
 */
const ClassResourceSchema = z.object({
  name: z.string(),
  className: z.string(),
  worker: z.string().optional(),
});

/**
 * A Hyperdrive config the app's Workers bind: every one of them, or only
 * the helper Worker `worker` names. Each is named after the app's Worker
 * in the account, `<worker>--<binding>`.
 */
const HyperdriveResourceSchema = z.object({
  name: z.string(),
  worker: z.string().optional(),
  /**
   * Whether Hyperdrive caches the config's read queries: "off" (the
   * default), since Hyperdrive never invalidates a cached read when the
   * app writes, and app code reads its own writes; "default" turns on
   * Cloudflare's own caching (60 s, stale for 15 s more).
   */
  caching: z.enum(["off", "default"]).optional(),
});

/**
 * How a queue's consumer takes its messages: Cloudflare's consumer
 * settings (`@cloudflare/config`'s `QueueConsumerTriggerOptions`), and
 * the helper Worker (`workers`) that consumes, when not the app's own.
 */
const QueueConsumerSchema = z.object({
  worker: z.string().optional(),
  /** The most messages one batch holds. */
  maxBatchSize: z.number().optional(),
  /** The most seconds to wait to fill a batch. */
  maxBatchTimeout: z.number().optional(),
  /** How many times a message is retried before it goes to `deadLetterQueue` (or is dropped). */
  maxRetries: z.number().optional(),
  /** The most consumer invocations at once; null (or unset) scales with the backlog. */
  maxConcurrency: z.number().nullable().optional(),
  /** The seconds to wait before a message is retried. */
  retryDelay: z.number().optional(),
  /** The milliseconds a pulled message stays hidden (Cloudflare's setting, kept as given). */
  visibilityTimeoutMs: z.number().optional(),
  /** Another of the app's queue bindings, which takes the messages that ran out of retries. */
  deadLetterQueue: z.string().optional(),
});

/**
 * A Cloudflare Queue the app's Workers produce to (every one of them binds
 * it), consumed by the app's own Worker (`consumer: true`) or by the
 * helper Worker `consumer.worker` names. Each is named after the app's
 * Worker in the account, `<worker>--<binding>` ({@link queueNameFor}).
 */
const QueueResourceSchema = z.object({
  name: z.string(),
  consumer: z.union([z.literal(true), QueueConsumerSchema]).optional(),
});

/** The distance metrics a Vectorize index can be created with. */
export const VECTORIZE_METRICS = [
  "cosine",
  "euclidean",
  "dot-product",
] as const;

/**
 * The embedding models Cloudflare creates a Vectorize index for by name,
 * with their dimensions and metric (`cf vectorize create --help`'s choices).
 */
export const VECTORIZE_PRESETS = [
  "@cf/baai/bge-small-en-v1.5",
  "@cf/baai/bge-base-en-v1.5",
  "@cf/baai/bge-large-en-v1.5",
  "openai/text-embedding-ada-002",
  "cohere/embed-multilingual-v2.0",
] as const;

/** Cloudflare's range for a Vectorize index's dimensions. */
export const VECTORIZE_DIMENSIONS = { min: 32, max: 1536 } as const;

/**
 * A Vectorize index every one of the app's Workers binds, named after the
 * app's Worker in the account (`<worker>--<binding>`,
 * {@link vectorizeNameFor}): either `dimensions` and `metric`, or a
 * `preset` (one form only; the strict schema says which is missing).
 * Tolerant here: values a newer CLI accepts don't brick registration.
 */
const VectorizeResourceSchema = z.object({
  name: z.string(),
  dimensions: z.number().optional(),
  metric: z.string().optional(),
  preset: z.string().optional(),
});

/**
 * An AI Gateway of the app's own in the Cloudflare account, which every
 * one of its Workers binds as `{ id, accountId, url }` (a `json` binding).
 * Its id is `<worker>-<binding>` ({@link aiGatewayIdFor}).
 */
const AiGatewayResourceSchema = z.object({
  name: z.string(),
  /** Whether the gateway keeps a log of each request (on by default). */
  collectLogs: z.boolean().optional(),
  /** How long, in seconds, the gateway caches a response; 0 (the default) caches nothing. */
  cacheTtl: z.number().int().min(0).optional(),
});

/**
 * A Cloudflare `send_email` binding every one of the app's Workers gets,
 * beside the Gateway's email capability (which stays the recommended way
 * to send): the senders it may use, and one destination or a list of
 * them. Nothing is made in the account; Cloudflare checks the addresses
 * when the Worker sends.
 */
const SendEmailResourceSchema = z.object({
  name: z.string(),
  allowedSenderAddresses: z.array(z.string()).optional(),
  destinationAddress: z.string().optional(),
  allowedDestinationAddresses: z.array(z.string()).optional(),
});

/**
 * A Cloudflare Secrets Store secret every one of the app's Workers binds:
 * a secret in the account's store named `<worker>--<binding>`
 * ({@link storeSecretNameFor}), created by the deploy from the binding's
 * value in the app's `.everyapp/secrets.env`.
 */
const SecretsStoreResourceSchema = z.object({ name: z.string() });

/** Cloudflare's limit on an Analytics Engine dataset's name. */
const MAX_DATASET_NAME_LENGTH = 128;

/**
 * An Analytics Engine dataset the app's Workers write to, by binding:
 * `dataset` as written, or named after the app's Worker
 * ({@link analyticsDatasetFor}).
 */
const AnalyticsEngineResourceSchema = z.object({
  name: z.string(),
  dataset: z.string().optional(),
});

export const ResourcesSchema = z
  .object({
    d1: z.array(z.string()).optional(),
    kv: z.array(z.string()).optional(),
    /** Durable Objects exported by the worker (binding name + class). */
    durableObjects: z.array(ClassResourceSchema).optional(),
    /**
     * Workflows the worker defines (binding name + class). Each is named
     * after the app's Worker in the account, `<worker>--<binding>`.
     */
    workflows: z.array(ClassResourceSchema).optional(),
    /** Hyperdrive configs to a Postgres database the app owns. */
    hyperdrive: z.array(HyperdriveResourceSchema).optional(),
    /**
     * R2 buckets, by binding, which every one of the app's Workers binds:
     * `R2` is named after the app's Worker, any other binding
     * `<worker>--<binding>` ({@link bucketNameFor}).
     */
    r2: z.array(z.string()).optional(),
    /** Cloudflare Queues, by binding, with their consumers. */
    queues: z.array(QueueResourceSchema).optional(),
    /**
     * Workers AI, by binding (`["AI"]`), which every one of the app's
     * Workers binds: account-wide inference billed to the account, nothing
     * to create. The Gateway's `workers-ai` provider is the brokered path.
     */
    ai: z.array(z.string()).optional(),
    /**
     * Browser Rendering, by binding (`["BROWSER"]`), which every one of the
     * app's Workers binds: a headless Chrome the account runs, nothing to
     * create (Workers Paid).
     */
    browser: z.array(z.string()).optional(),
    /**
     * Cloudflare Images, by binding (`["IMAGES"]`), which every one of the
     * app's Workers binds: resizing, transforming and reading images in the
     * Worker, nothing to create.
     */
    images: z.array(z.string()).optional(),
    /** Vectorize indexes, by binding, which every one of the app's Workers binds. */
    vectorize: z.array(VectorizeResourceSchema).optional(),
    /** AI Gateways of the app's own, by binding ({@link aiGatewayIdFor}). */
    aiGateway: z.array(AiGatewayResourceSchema).optional(),
    /** Cloudflare `send_email` bindings, by binding, with the addresses each may use. */
    sendEmail: z.array(SendEmailResourceSchema).optional(),
    /**
     * Secrets Store secrets, by binding (`[{ name: "STRIPE_KEY" }]`), which
     * every one of the app's Workers binds (`await env.STRIPE_KEY.get()`):
     * each a secret in the account's store, named `<worker>--<binding>`.
     */
    secretsStore: z.array(SecretsStoreResourceSchema).optional(),
    /**
     * Analytics Engine datasets, by binding, which every one of the app's
     * Workers writes to: nothing to create (a dataset exists once written
     * to), nothing to delete (Cloudflare has none; data expires after 90
     * days).
     */
    analyticsEngine: z.array(AnalyticsEngineResourceSchema).optional(),
  })
  .passthrough();
export type Resources = z.infer<typeof ResourcesSchema>;

const CompatibilityDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/**
 * The records keyed by an id (`capabilities`) take `z.string()`
 * keys and check each id in their refinement, so that every problem in the
 * record is reported in one pass. A key schema would read as zod 4's own
 * `Invalid key in record` and, since that issue stops the refinement, one
 * malformed id would hide the reserved-id check and every sibling entry's
 * problem until it was fixed. `when` runs the refinement on any object the
 * record got, so a value's problem doesn't hide a key's either.
 */
const everyKey: z.core.$ZodSuperRefineParams = {
  when: ({ value }) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
};

export const MigrationsSchema = z
  .object({
    /**
     * What writes and applies the migrations: "drizzle" (drizzle-kit),
     * "d1-sql" (SQL files written some other way, e.g. Prisma's generated
     * SQL for D1), or "prisma" (`prisma migrate deploy`, Postgres only).
     */
    engine: z.enum(["drizzle", "d1-sql", "prisma"]),
    /**
     * The database the migrations are for: "sqlite" (the default), the D1
     * database `binding` names; "postgresql", the Postgres database at
     * POSTGRES_DATABASE_URL in the app's secrets file, which the deploy
     * migrates before it uploads (`drizzle-kit migrate`, or
     * `prisma migrate deploy` on the "prisma" engine).
     */
    dialect: z.enum(["sqlite", "postgresql"]).optional(),
    /**
     * Directory of SQL migration files, relative to the app root. On the
     * "prisma" engine the deploy skips the migration when it is set and
     * missing; unset, Prisma finds its migrations through its config.
     */
    dir: z.string().optional(),
    /**
     * The app's drizzle config (or, on the "prisma" engine, its
     * prisma.config.ts), relative to the app root, when it isn't the
     * tool's default: the schema check and the Postgres migration run the
     * tool with it.
     */
    config: z.string().min(1).optional(),
    /** D1 binding to migrate. Defaults to the first declared D1 binding. */
    binding: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.engine === "prisma" && value.dialect !== "postgresql") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["engine"],
        message:
          'Prisma migrations run on Postgres (dialect "postgresql"); D1 takes the generated SQL through "d1-sql"',
      });
    }
    if (value.dialect === "postgresql") {
      if (value.engine === "d1-sql") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["engine"],
          message:
            'Postgres migrations run on the "drizzle" or "prisma" engine',
        });
      }
      if (value.binding !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["binding"],
          message: "binding names a D1 database; Postgres migrations have none",
        });
      }
    }
    if (value.config !== undefined && !isSafeRelativePath(value.config)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config"],
        message: "config must be a relative path without .. segments",
      });
    }
    if (value.engine === "d1-sql" && !value.dir?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dir"],
        message: 'dir is required when migrations.engine is "d1-sql"',
      });
      return;
    }
    if (value.dir && !isSafeRelativePath(value.dir)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dir"],
        message: "dir must be a relative path without .. segments",
      });
    }
  });
export type Migrations = z.infer<typeof MigrationsSchema>;

const InstallSchema = z.union([z.literal(false), z.string().min(1)]);

const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;
const PROVIDER_NAME_PROBLEM =
  "provider must start with a lowercase letter and contain only lowercase letters, digits, and hyphens";

export const ProviderNameSchema = z
  .string()
  .regex(PROVIDER_NAME, PROVIDER_NAME_PROBLEM);

/** The `capabilities` keys are provider names; one that isn't is the key's problem (see `everyKey`). */
function addProviderNameIssue(id: string, ctx: z.RefinementCtx): boolean {
  if (PROVIDER_NAME.test(id)) return false;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [id],
    message: PROVIDER_NAME_PROBLEM,
  });
  return true;
}

/**
 * What a provider, capability or secret may say about its need (the
 * settings model, `@every-app/sdk/internal` appSettings): why the app
 * needs it, where it comes from, and whether the app opens without it. A
 * declaration with none of these is required.
 */
const HttpsUrlSchema = z
  .string()
  .url()
  .refine((url) => url.startsWith("https://"), "must be an https URL");

const SettingNeedFieldsSchema = {
  /** Why the app needs it, for whoever sets it. */
  why: z.string().min(1).max(200).optional(),
  /** Where the key or client comes from. */
  docs: HttpsUrlSchema.optional(),
  /** The app works without it; the feature using it says so where it is used. */
  optional: z.boolean().optional(),
  /** The group of which one set member is enough, by name ("AI model"), for an app that picks among the set members at run time. */
  anyOf: z.string().trim().min(1).max(40).optional(),
  // `setup` is not here: only an app's own secret names its guide (below).
} satisfies Record<Exclude<keyof SettingNeedFields, "setup">, z.ZodTypeAny>;

/** One `providers` entry: a provider id, or the id with its need. */
const ProviderEntrySchema = z.object({ id: ProviderNameSchema }).passthrough();
const ProviderEntrySchemaStrict = z
  .object({ id: ProviderNameSchema, ...SettingNeedFieldsSchema })
  .strict();

const noDuplicateProviders = (
  providers: ReadonlyArray<string | { id: string }>,
  ctx: z.RefinementCtx,
) => {
  const seen = new Set<string>();
  providers.forEach((entry, index) => {
    const id = typeof entry === "string" ? entry : entry.id;
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: "duplicate provider",
      });
    }
    seen.add(id);
  });
};

export const ProvidersSchema = z
  .array(z.union([ProviderNameSchema, ProviderEntrySchema]))
  .superRefine(noDuplicateProviders);

const ProvidersSchemaStrict = z
  .array(z.union([ProviderNameSchema, ProviderEntrySchemaStrict]))
  .superRefine(noDuplicateProviders);

/** A secret's name as a stored manifest may hold it (the strict rules are below). */
const SecretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a secret's name is an identifier")
  .max(64);

/**
 * One capability an app asks for (docs/capabilities.md). Approval is of the
 * app: every call it makes may use the capability, attributed to the
 * signed-in person whose identity it forwards, or to the app.
 */
const CapabilityEntryBaseSchema = z.object({
  /**
   * The scope sets an OAuth client with a scope policy lets the app use, by
   * name (docs/capabilities.md "OAuth clients"). The names are checked when
   * the manifest is authored and again at the token endpoint; a malformed
   * stored value reads as undeclared (the `email.inbound` precedent) so a
   * newer CLI's manifest never bricks a row, and the token call is refused
   * instead.
   */
  scopes: z.array(z.string()).optional().catch(undefined),
  /**
   * For an OAuth client: the paths on the app's own host the provider
   * sends people back to when the app runs the flow itself
   * (`/integrations/google/callback`), the redirect URIs the operator
   * registers on the client. The catalog names none: each app says its own.
   */
  redirectPaths: z.array(z.string()).optional().catch(undefined),
  /** What the app does with it; each capability says which levels it offers. */
  access: z.enum(["read", "write"]),
  ...SettingNeedFieldsSchema,
});

export const CapabilityRequestSchema = CapabilityEntryBaseSchema.passthrough();
export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;

/** The most redirect paths one capability entry lists. */
const MAX_REDIRECT_PATHS = 10;

/**
 * An OAuth client's `redirectPaths` as an author writes them: absolute
 * paths on the app's host, no query or fragment, each once.
 */
const RedirectPathsSchema = z
  .array(
    z
      .string()
      .max(200, "a redirect path is at most 200 characters")
      .regex(
        /^\/(?!\/)[A-Za-z0-9._~\-/]*$/,
        "a redirect path is an absolute path on the app's host (/integrations/google/callback), without a query or fragment",
      ),
  )
  .min(1, "redirectPaths lists at least one path, or is left out")
  .max(
    MAX_REDIRECT_PATHS,
    `redirectPaths lists at most ${MAX_REDIRECT_PATHS} paths`,
  )
  .refine(
    (list) => new Set(list).size === list.length,
    "a redirect path is listed twice",
  );

/**
 * What one capability's manifest entry takes: `access`, and its need
 * (`why`, `docs`, `optional`, `anyOf`), and for an OAuth client the
 * app's own callbacks (`redirectPaths`). Strict:
 * anything else is unknown here; an installation's email senders aren't
 * the manifest's (`everyapp email set`), and the strict capabilities
 * schema names the command for a manifest that still lists them.
 *
 * An OAuth client with a scope policy also takes `scopes`, one or more of
 * its set names, each once; every other capability refuses the field.
 * `lookup` is where `id` is found: the catalog, or a gateway's registry;
 * an id it doesn't have, or an AI provider's, is a programming error here
 * (the capabilities schema checks ids first).
 */
export function capabilityEntrySchema(
  id: string,
  lookup: CapabilityLookup = CATALOG,
  /**
   * What to do with a scope-set name the client's policy doesn't have:
   * refuse it (the default: the lookup is the gateway's registry, overlays
   * included), or accept a well-formed one for the gateway to check (the
   * CLI before it has asked a gateway: an operator may have added the set
   * with `everyapp provider scope-set add`).
   */
  unknown: UnknownCapabilities = "refuse",
) {
  const capability = lookup.get(id);
  if (!capability || capability.mode === "ai") {
    throw new Error(`capabilityEntrySchema: ${id} is not a capability`);
  }
  // An OAuth client the Gateway runs the flow for (a `flow` block) also
  // takes `read`: the app's calls to its API hosts carry the person's held
  // token, and a read grant allows the read methods only (the held-token
  // branch, docs/design/2026-10-oauth-providers.md section 7). `write`
  // stays what the app-driven token-endpoint calls need.
  const offered: readonly string[] =
    isOAuthProvider(capability) && !capability.access.includes("read")
      ? ["read", ...capability.access]
      : capability.access;
  const access = z
    .enum(["read", "write"])
    .refine(
      (level) => offered.includes(level),
      `${capability.label} offers ${offered.join(" or ")} access`,
    );
  // Only an OAuth client has a callback to register.
  const redirectPaths =
    capability.mode === "oauth_client"
      ? RedirectPathsSchema.optional()
      : z
          .undefined({
            error: `${capability.label} takes no redirectPaths; only an OAuth client has a callback`,
          })
          .optional();
  const policy =
    "scopePolicy" in capability ? capability.scopePolicy : undefined;
  if (!policy) {
    // A capability with one purpose takes no scope sets: listing it is
    // the whole grant. `.optional()` so the key may be absent: under zod 4
    // a key whose schema is `z.undefined()` is required.
    const scopes = z
      .undefined({
        error: `${capability.label} takes no scopes; list it as { access: ..., why }`,
      })
      .optional();
    return CapabilityEntryBaseSchema.extend({
      access,
      scopes,
      redirectPaths,
    }).strict();
  }
  // Own keys only: `constructor` is not a set.
  const names = Object.keys(policy.sets) as [string, ...string[]];
  const needsScopes = `${capability.label} needs scopes: one or more of ${names.join(", ")}`;
  const name =
    unknown === "accept"
      ? // A well-formed name the catalog's policy lacks may be an
        // operator's overlay on the gateway: the deploy checks it there.
        z
          .string()
          .regex(
            SCOPE_SET_NAME,
            `unknown scope set (${capability.label} offers: ${names.join(", ")}; a set an operator added is named identity, or <area>.<access>)`,
          )
          .refine(
            (set) => !(set in Object.prototype),
            `unknown scope set (${capability.label} offers: ${names.join(", ")})`,
          )
      : z.enum(names, {
          error: `unknown scope set (${capability.label} offers: ${names.join(", ")})`,
        });
  const scopes = z
    .array(name, { error: needsScopes })
    .min(1, needsScopes)
    .refine(
      (list) => new Set(list).size === list.length,
      "a scope set is listed twice",
    );
  return CapabilityEntryBaseSchema.extend({
    access,
    scopes,
    redirectPaths,
  }).strict();
}

/** One authored capability entry, whichever capability it is for. */
export type CapabilityEntry = z.infer<typeof CapabilityEntryBaseSchema>;

const CapabilitiesSchema = z
  .record(z.string(), CapabilityRequestSchema)
  .superRefine((capabilities, ctx) => {
    for (const id of Object.keys(capabilities)) addProviderNameIssue(id, ctx);
  }, everyKey);

/**
 * The entry of a capability this validator can't look up (a provider
 * registered on a gateway the CLI hasn't asked yet): `access` and its
 * need, and `scopes` as well-formed set names for a registered OAuth
 * provider (the gateway's registry says whether the provider has them),
 * nothing else. `everyapp deploy` checks the id and the sets against the
 * gateway's registry once it is connected.
 */
const UnknownCapabilityEntrySchema = CapabilityEntryBaseSchema.extend({
  scopes: z
    .array(
      z
        .string()
        .regex(
          SCOPE_SET_NAME,
          "a scope set is named identity, or <area>.<access> (repo.read)",
        ),
      {
        error:
          "scopes lists the scope sets of a registered OAuth provider (the gateway's registry names them); an API-key provider takes none",
      },
    )
    .min(1, "scopes lists at least one set, or is left out")
    .refine(
      (list) => new Set(list).size === list.length,
      "a scope set is listed twice",
    )
    .optional(),
  redirectPaths: RedirectPathsSchema.optional(),
}).strict();

/** What the strict validator does with a capability id its lookup doesn't have. */
export type UnknownCapabilities = "refuse" | "accept";

/** The strict `capabilities` schema against a lookup: every id a capability it has, or (`accept`) a well-formed id it doesn't. */
function capabilitiesSchemaStrict(
  lookup: CapabilityLookup,
  unknown: UnknownCapabilities,
) {
  return z
    .record(z.string(), z.unknown())
    .superRefine((capabilities, ctx) => {
      for (const [id, entry] of Object.entries(capabilities)) {
        if (addProviderNameIssue(id, ctx)) continue;
        const capability = lookup.get(id);
        if (capability?.mode === "ai") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [id],
            message: `${id} is an AI provider: list it under providers, not capabilities`,
          });
          continue;
        }
        if (!capability) {
          if (unknown === "refuse") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [id],
              message: `unknown capability (the gateway offers: ${capabilityIdsOf(lookup).join(", ")})`,
            });
            continue;
          }
          const parsed = UnknownCapabilityEntrySchema.safeParse(entry);
          if (parsed.success) continue;
          for (const issue of parsed.error.issues) {
            ctx.addIssue({ ...issue, path: [id, ...issue.path] });
          }
          continue;
        }
        if (
          id === "email" &&
          entry !== null &&
          typeof entry === "object" &&
          "senders" in entry
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [id, "senders"],
            message: `senders moved out of the manifest: set them with \`${EMAIL_SET_COMMAND} --sender <pattern>\` in the app's directory after its first deploy`,
          });
          continue;
        }
        const parsed = capabilityEntrySchema(id, lookup, unknown).safeParse(
          entry,
        );
        if (parsed.success) continue;
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [id, ...issue.path] });
        }
      }
    }, everyKey)
    .transform(
      (capabilities) => capabilities as Record<string, CapabilityEntry>,
    );
}

const CapabilitiesSchemaStrict = capabilitiesSchemaStrict(CATALOG, "refuse");

const INBOUND_MOVED = `inbound is true (the Worker exports an email() handler) or left out; the addresses moved out of the manifest: set them with \`${EMAIL_SET_COMMAND} --inbound <address>\` in the app's directory after its first deploy`;

/**
 * Mail the app receives through its `email()` handler: `inbound: true`
 * declares the handler; the addresses are the installation's
 * (`apps.email_inbound`, set with `everyapp email set --inbound`, which
 * routes them). Registration passes the field through; a row written
 * before the move holds an address list here and reads as undeclared, so
 * the gateway keeps routing the app until its next deploy.
 */
const EmailSchema = z
  .object({ inbound: z.boolean().optional().catch(undefined) })
  .passthrough();

const EmailSchemaStrict = z
  .object({
    /** True when the Worker exports `email()` beside `everyApp()`'s `fetch`; `everyapp email set --inbound` routes addresses to it. */
    inbound: z.boolean({ error: INBOUND_MOVED }).optional(),
  })
  .strict();

/** What a dispatch-tier manifest may not declare; the hosted deploy API refuses it too (`manifestProblems`). */
export const DISPATCH_INBOUND_PROBLEM =
  "email.inbound: apps in a dispatch namespace don't receive mail";

/**
 * Cloudflare's limits for one of the app's Workers. `cpuMs` raises the CPU
 * time an invocation may use (a Workflow step that crawls for minutes, say),
 * up to Cloudflare's 5 minutes.
 */
const WorkerLimitsSchema = z
  .object({ cpuMs: z.number().int().min(1).max(300_000).optional() })
  .passthrough();

/**
 * The database the app's code talks to, which its Workers read as
 * DATABASE_PROVIDER: its D1 database, or Postgres (through `hyperdrive`).
 * `region` is the cloud region the database runs in (e.g. "aws:us-east-1"),
 * where Cloudflare then places the app's Workers.
 */
const DatabaseSchema = z
  .object({
    provider: z.enum(["d1", "postgres"]),
    region: z
      .string()
      .regex(
        /^[a-z0-9]+:[a-z0-9-]+$/,
        'region must be a cloud region such as "aws:us-east-1"',
      )
      .optional(),
  })
  .passthrough();

/** A helper Worker's short name: kebab-case, so `<worker>--<name>` stays one name. */
const HelperWorkerNameSchema = z
  .string()
  .regex(
    /^[a-z]([a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z]$/,
    "helper Worker names are kebab-case (lowercase letters, digits, single hyphens)",
  )
  .max(20);

/**
 * Helper Workers that run beside the app's Worker, e.g. one that takes a
 * memory-hungry job off it. Each is deployed as `<app worker>--<name>`,
 * private like the app: only the app's Worker reaches it, through
 * `binding` (a service binding to its default export) or the Durable
 * Objects and Workflows it defines.
 */
const HelperWorkerSchema = z.object({
  name: HelperWorkerNameSchema,
  binding: z.string().optional(),
  limits: WorkerLimitsSchema.optional(),
});

export const AppAccessSchema = z.enum(["everyone", "admins"]);
export type AppAccess = z.infer<typeof AppAccessSchema>;

// Extra OpenAI API paths an app may opt into beyond the inference routes,
// e.g. "/v1/files". Each also covers its sub-paths.
const AiRouteSchema = z
  .string()
  .regex(
    /^\/v1(\/[a-z0-9_-]+)+$/,
    'must be an OpenAI API path such as "/v1/files"',
  );

/** `ai.chat` as an entry: the need fields alone (the Gateway's default has no id). */
const AiChatEntrySchema = z.object({ ...SettingNeedFieldsSchema });
const AiChatEntrySchemaStrict = AiChatEntrySchema.strict();

export const AiPolicySchema = z
  .object({
    /** Model ids the app may request from inference endpoints. Omitted: any. */
    models: z.array(z.string().min(1).max(200)).optional(),
    /**
     * Provider paths the app needs beyond inference. Only honored within the
     * gateway operator's allowlist (AI_PROXY_EXTRA_ROUTES), since the
     * provider key is shared. Omitted: inference only.
     */
    routes: z.array(AiRouteSchema).optional(),
    /**
     * The app needs a chat model and takes whichever the Gateway's
     * operator made the default (`/api/ai/default/…`, the SDK's `ai()`):
     * `true`, or an entry with its need (`why`, `optional`, `anyOf`). The
     * model allowlist above doesn't apply to the default route: the
     * operator chose the model. An app that needs one provider in
     * particular lists it under `providers` instead, or as well.
     */
    chat: z.union([z.boolean(), AiChatEntrySchema]).optional(),
  })
  .passthrough();

/** The strict form: the `chat` entry takes the need fields and nothing else. */
const AiPolicySchemaStrict = z
  .object({
    models: z.array(z.string().min(1).max(200)).optional(),
    routes: z.array(AiRouteSchema).optional(),
    chat: z.union([z.boolean(), AiChatEntrySchemaStrict]).optional(),
  })
  .strict();
export type AiPolicy = z.infer<typeof AiPolicySchema>;

/** What an author who wrote the old string form, or anything else, is told. */
const MCP_SHAPE =
  'mcp is { by: "gateway" | "app", why: "..." }: "gateway" serves the app\'s defineTools() at <app-host>/mcp, "app" leaves the path to the app\'s own MCP server; left out, the Gateway\'s own /mcp is the one connector';

/** Operator text shown by `everyapp deploy` and `everyapp status`. */
const PLAIN_TEXT = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u;

/**
 * Whether, and by whom, the app's own host answers `/mcp`. Left out, it
 * doesn't: `https://<gateway>/mcp` serves every app the caller can use,
 * and a second connector per app is one more surface to let through
 * Cloudflare Access for nothing. An app that needs one says why.
 */
export const McpSchema = z
  .object(
    {
      /**
       * "gateway": the Gateway's ToolBus serves the tools the app defines
       * with `defineTools()` at `<app-host>/mcp`. "app": the app runs its
       * own MCP server there, and the perimeter proxies `/mcp` to it with
       * the identity header, the token's scopes left for the app to read.
       */
      by: z.enum(["gateway", "app"]),
      /** Why this app needs `/mcp` on its own host; shown by the CLI. */
      why: z
        .string()
        .min(1, "say why the app needs /mcp on its own host")
        .max(200)
        .regex(PLAIN_TEXT, "why is plain text: no control characters"),
    },
    {
      // A string (the field's old form) or anything else that isn't an
      // object is told the shape, not "expected object".
      error: (issue) => (issue.code === "invalid_type" ? MCP_SHAPE : undefined),
    },
  )
  .passthrough();
export type McpPolicy = z.infer<typeof McpSchema>;

export const ManifestSchema = z
  .object({
    /** Stable app id, kebab-case. Used in the app hostname's first DNS label. */
    id: z
      .string()
      .min(1)
      .regex(
        /^[a-z]([a-z0-9-]*[a-z0-9])?$/,
        "id must be kebab-case (lowercase, digits, hyphens)",
      ),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    /**
     * The app's launcher icon: the path of an SVG the app serves (e.g.
     * "/everyapp-icon.svg" from its public directory), which the gateway's
     * app library shows instead of the app's favicon. The app draws the
     * whole tile; the library only rounds its corners. Unset: the favicon.
     */
    icon: z
      .string()
      .regex(
        /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*\.svg$/,
        'icon must be the path of an SVG the app serves, such as "/everyapp-icon.svg"',
      )
      .optional(),
    /**
     * Legacy: the Worker entry now comes from `cloudflare.config.ts`. Still
     * accepted so existing manifests validate.
     */
    main: z.string().optional(),
    /** Optional Cloudflare Workers compatibility date override. */
    compatibilityDate: CompatibilityDateSchema.optional(),
    /** Cloudflare resources the worker binds. Provisioned by the CLI. */
    resources: ResourcesSchema.optional(),
    /** Helper Workers deployed beside the app's Worker. Default: none. */
    workers: z.array(HelperWorkerSchema.passthrough()).optional(),
    /** The database the app's code talks to (DATABASE_PROVIDER). */
    database: DatabaseSchema.optional(),
    /** Cloudflare's limits for the app's own Worker (`workers` set theirs). */
    limits: WorkerLimitsSchema.optional(),
    /** Routes reachable without an authenticated session. Default: none. */
    public: z.array(PublicRouteSchema).optional(),
    /**
     * Static files of the Worker's asset bundle anyone may fetch (favicons,
     * a web manifest, built `/assets/**`): path globs with `public[].path`'s
     * syntax and safety rules, GET and HEAD only. The gateway forwards a
     * match with no identity and no public marker, so the asset server
     * answers it and the Worker, behind `everyApp()`, refuses it. Default:
     * none.
     */
    publicAssets: z
      .array(z.string())
      .max(
        MAX_PUBLIC_ASSETS,
        `publicAssets: at most ${MAX_PUBLIC_ASSETS} patterns; use a glob such as "/icons/**"`,
      )
      .optional(),
    /**
     * Routes a bearer client reaches with its token only ("Sign in with
     * Every App", docs/design/native-sign-in.md §7): see
     * {@link BearerRoutesSchema}. Default: none.
     */
    bearerRoutes: BearerRoutesSchema.optional(),
    /** Provider APIs this app may call through the gateway. Default: none. */
    providers: ProvidersSchema.optional(),
    /**
     * Third-party APIs the gateway calls for this app with keys it holds,
     * e.g. `dataforseo: { access: "read" }`. Default: none.
     */
    capabilities: CapabilitiesSchema.optional(),
    /**
     * The app's own secrets (an API key it calls out with), which
     * `everyapp secret set <NAME>` sets on its Workers: each by name, or as
     * `{ name, why, docs, optional, anyOf }`. Default: none.
     */
    secrets: z
      .array(
        z.union([
          SecretNameSchema,
          z.object({ name: SecretNameSchema }).passthrough(),
        ]),
      )
      .max(100)
      .optional(),
    /**
     * The app's plain settings: values that aren't secrets and differ per
     * install (a PostHog host, a region), set like its secrets with
     * `everyapp configure <app>` and read from `env`: each
     * `{ name, why, type?, values?, default?, optional?, docs? }`.
     * Default: none.
     */
    settings: z
      .array(z.object({ name: SecretNameSchema }).passthrough())
      .max(100)
      .optional(),
    /** Limits on what the app may do through the gateway's AI proxy. */
    ai: AiPolicySchema.optional(),
    /**
     * Mail the app's `email()` handler receives: `inbound: true` declares
     * the handler; `everyapp email set --inbound` routes addresses to it.
     */
    email: EmailSchema.optional(),
    /**
     * Who can open the app once it is first registered. "admins" (the
     * default) grants the deployer and the organization's owners and admins;
     * "everyone" grants every member, including future ones. Redeploys never
     * change access; admins manage it in the gateway UI afterwards.
     */
    access: AppAccessSchema.optional(),
    /**
     * The perimeter only lets same-origin fetch() calls from TanStack's client
     * reach `/_serverFn/*`. Set false for an app whose server functions must
     * be reachable some other way. Default: true.
     */
    serverFnGuard: z.boolean().optional(),
    /**
     * Where the app's TanStack Start server functions live, when that is not
     * `/_serverFn`: an app with a router basepath or its own `serverFns.base`
     * sets it (e.g. "/app/_serverFn") so the perimeter guards that path.
     */
    serverFnBase: z
      .string()
      .regex(
        /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+\/?$/,
        'must be a path such as "/app/_serverFn"',
      )
      .optional(),
    /** Shell command that builds the app for production. Default: `cf build`. */
    build: z.string().min(1).optional(),
    /** Shell command that starts the app dev server for `everyapp dev`. Default: `cf dev`. */
    dev: z.string().min(1).optional(),
    /**
     * Legacy: the dev port now comes from the app's vite.config.ts (PORT).
     * Still accepted so existing manifests validate.
     */
    devPort: z.number().int().positive().optional(),
    /** Dependency install command; false skips install; omitted auto-detects. */
    install: InstallSchema.optional(),
    /** Database migration strategy for the app's D1 database. */
    migrations: MigrationsSchema.optional(),
    /**
     * Whether the app's own host answers `/mcp`, and who does: see
     * {@link McpSchema}. Left out (the default), the host serves no MCP and
     * the Gateway's `/mcp` is the one connector.
     */
    mcp: McpSchema.optional(),
  })
  .passthrough();
export type Manifest = z.infer<typeof ManifestSchema>;

export const PublicRouteSchemaStrict = PublicRouteSchema.strict();
/** A D1, KV, R2 or Workflow binding: the name the Worker reads from `env`. */
const BindingNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "binding names must be JavaScript identifiers",
  );

/**
 * A queue's binding, which names its queue (`<worker>--<binding>`,
 * lowercased with `_` as `-`): an identifier that doesn't end in `_`,
 * since Cloudflare refuses a queue name ending in a hyphen.
 */
const QueueBindingNameSchema = BindingNameSchema.refine(
  (name) => !name.endsWith("_"),
  "a queue's binding can't end with _ (its queue's name would end with a hyphen, which Cloudflare refuses)",
);

/**
 * An AI Gateway's binding: a JavaScript identifier whose underscores each
 * sit between letters or digits, since it becomes the end of the gateway's
 * id, where Cloudflare allows single hyphens only ({@link aiGatewayIdFor}).
 */
const AiGatewayBindingNameSchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/,
    "an AI Gateway's binding is letters and digits joined by single underscores (it ends the gateway's id, which takes single hyphens only)",
  );

/**
 * The app's own secrets, each by name or as an entry with its need:
 * identifiers, each once, none the deploy
 * sets itself, and none of the Gateway's settings, which an app reaches
 * through `providers` and `capabilities` rather than holding its own copy
 * (and which `everyapp secret set` would set on the Gateway). Both rules
 * read the name without regard to case. A name that is also one of the
 * app's bindings is refused by {@link validateManifestStrict}, which sees
 * the whole manifest.
 */
/** An app's own secret may name its setup guide in the everyapp skill (`setup/main-secret.md`). */
const SetupGuideSchema = z
  .string()
  .regex(
    /^setup\/[a-z0-9][a-z0-9-]*\.md$/,
    'must be a guide in the everyapp skill, such as "setup/main-secret.md"',
  );

const SecretEntrySchemaStrict = z
  .object({
    name: BindingNameSchema,
    ...SettingNeedFieldsSchema,
    setup: SetupGuideSchema.optional(),
  })
  .strict();

/**
 * The provider a gateway registered (a lookup's id outside the catalog)
 * whose settings include `name`, as {@link gatewaySettingOwner} names a
 * catalog provider's.
 */
function registeredSettingOwner(
  lookup: CapabilityLookup | undefined,
  name: string,
): { kind: "capability"; id: string } | null {
  if (!lookup) return null;
  for (const id of lookup.ids()) {
    if (isCapabilityId(id)) continue;
    const capability = lookup.get(id);
    if (capability && capabilitySettings(capability).includes(name)) {
      return { kind: "capability", id };
    }
  }
  return null;
}

/**
 * The strict `secrets` schema. With a gateway's registry (`lookup`), a
 * setting one of its registered providers holds is a Gateway setting too,
 * refused in the same words as the catalog's.
 */
function appSecretsSchemaStrict(lookup?: CapabilityLookup) {
  return z
    .array(z.union([BindingNameSchema, SecretEntrySchemaStrict]))
    .superRefine((entries, ctx) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const name = typeof entry === "string" ? entry : entry.name;
        const issue = (message: string) =>
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message });
        if (seen.has(name)) issue(`duplicate secret ${name}`);
        seen.add(name);
        const refused = ownNameRefusal(name, "secret", lookup);
        if (refused) issue(refused);
      });
    });
}

/**
 * Why `name` can't be one of the app's own secrets or settings (`what`),
 * or null when it can: not a name the deploy sets, not a sign-in
 * provider's, a remote MCP app's or any other Gateway setting (with a
 * gateway's registry, one a registered provider holds counts too). Read
 * without regard to case.
 */
function ownNameRefusal(
  name: string,
  what: "secret" | "setting",
  lookup?: CapabilityLookup,
): string | null {
  if (isReservedAppSecretName(name)) {
    return `${name} is set by everyapp itself (${RESERVED_APP_SECRET_NAMES_TEXT})`;
  }
  const upper = name.toUpperCase();
  if (isSignInSettingName(upper)) {
    return `${name} is a sign-in provider's setting name (every <ID>_SIGNIN_<FIELD> name is the Gateway's, set with \`everyapp signin add\`); give the app's ${what} another name`;
  }
  const registered = isSettableGatewaySetting(upper)
    ? null
    : registeredSettingOwner(lookup, upper);
  if (!isSettableGatewaySetting(upper) && !registered) return null;
  if (isRemoteMcpSecretName(upper)) {
    return `${name} is a remote MCP app's credential name (every name ending in _MCP_TOKEN is the Gateway's, set with \`everyapp secret set\`); give the app's ${what} another name`;
  }
  const owner = registered ?? gatewaySettingOwner(upper);
  const instead = owner
    ? `list \`${owner.id}\` under ${owner.kind === "provider" ? "providers" : "capabilities"} instead`
    : `give the app's ${what} another name`;
  return `${name} is a Gateway setting, which \`everyapp secret set ${upper}\` sets on the Gateway for every app; ${instead}`;
}

const AppSecretsSchemaStrict = appSecretsSchemaStrict();

/**
 * One of the app's plain settings, as an author writes it: a value that
 * isn't a secret and differs per install (a PostHog host, a region),
 * held on the app's Workers like a secret and read from `env`. `why` is
 * required: whoever installs the app is asked for it.
 */
const SettingEntrySchemaStrict = z
  .object({
    name: BindingNameSchema,
    why: z.string().min(1).max(200),
    docs: HttpsUrlSchema.optional(),
    optional: z.boolean().optional(),
    type: z.enum(["text", "url", "number", "boolean"]).optional(),
    values: z
      .array(z.string().trim().min(1).max(200))
      .min(2)
      .max(50)
      .optional(),
    default: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (entry.values && entry.type && entry.type !== "text") {
      issue(
        "values",
        `values lists what a text setting may be; drop type "${entry.type}" or values`,
      );
      return;
    }
    if (entry.values && new Set(entry.values).size !== entry.values.length) {
      issue("values", "each value once");
    }
    if (entry.optional === true && entry.default !== undefined) {
      issue(
        "optional",
        "a setting with a default is never unset (the deploy sets the default), so it is optional already; drop optional",
      );
    }
    if (entry.default !== undefined) {
      const problem = settingValueProblem(
        {
          type: entry.type ?? "text",
          ...(entry.values ? { values: entry.values } : {}),
        },
        entry.default,
      );
      if (problem)
        issue(
          "default",
          `the default isn't a value the setting takes: ${problem}`,
        );
    }
  });

/** The strict `settings` schema: the same name rules as `secrets`, each once. */
function appSettingsSchemaStrict(lookup?: CapabilityLookup) {
  return z
    .array(SettingEntrySchemaStrict)
    .max(100)
    .superRefine((entries, ctx) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const issue = (message: string) =>
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message });
        if (seen.has(entry.name)) issue(`duplicate setting ${entry.name}`);
        seen.add(entry.name);
        const refused = ownNameRefusal(entry.name, "setting", lookup);
        if (refused) issue(refused);
      });
    });
}

const AppSettingsSchemaStrict = appSettingsSchemaStrict();

/**
 * A Vectorize index as an author writes it: `{ name, dimensions, metric }`
 * or `{ name, preset }`, never both. An index can't be reshaped once
 * created, so the deploy compares the two (`VECTORIZE_CONFIG_MISMATCH`).
 */
const VectorizeResourceSchemaStrict = VectorizeResourceSchema.extend({
  name: BindingNameSchema,
  dimensions: z
    .number()
    .int(`a Vectorize index's dimensions are a whole number`)
    .min(
      VECTORIZE_DIMENSIONS.min,
      `a Vectorize index has ${VECTORIZE_DIMENSIONS.min} to ${VECTORIZE_DIMENSIONS.max} dimensions`,
    )
    .max(
      VECTORIZE_DIMENSIONS.max,
      `a Vectorize index has ${VECTORIZE_DIMENSIONS.min} to ${VECTORIZE_DIMENSIONS.max} dimensions`,
    )
    .optional(),
  metric: z.enum(VECTORIZE_METRICS).optional(),
  preset: z.enum(VECTORIZE_PRESETS).optional(),
})
  .strict()
  .superRefine((entry, ctx) => {
    const sized = entry.dimensions !== undefined || entry.metric !== undefined;
    if (entry.preset !== undefined && sized) {
      ctx.addIssue({
        code: "custom",
        message: `${entry.name}: a preset sets the index's dimensions and metric itself; give either preset, or dimensions and metric`,
      });
    } else if (
      entry.preset === undefined &&
      (entry.dimensions === undefined || entry.metric === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${entry.name} needs dimensions and metric (e.g. 768 and "cosine"), or a preset (e.g. "@cf/baai/bge-base-en-v1.5")`,
      });
    }
  });

/**
 * One address, as a `send_email` binding's lists take it: no `*`, so a
 * sender pattern (`*@<domain>`, as `everyapp email set --sender` takes)
 * isn't mistaken for one.
 */
const EMAIL_ADDRESS =
  /^[A-Za-z0-9.!#$%&'+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const EmailAddressSchema = z
  .string()
  .max(254, "an email address is at most 254 characters")
  .regex(
    EMAIL_ADDRESS,
    "must be an email address such as noreply@example.com, not a pattern",
  );
const EmailAddressListSchema = z
  .array(EmailAddressSchema)
  .min(1, "list at least one address, or leave the list out");

/**
 * Why an entry names its senders: without the list Cloudflare's binding
 * sends as any address on the account's Email Sending domains, the
 * Gateway's own sender (invitations, resets) included.
 */
const SENDERS_REQUIRED =
  "list the addresses the binding may send as: without allowedSenderAddresses it could send as any address on the account's Email Sending domains, the Gateway's own sender included";

/**
 * A `send_email` binding's entry: an identifier, the senders it may use
 * (required, at least one), addresses as addresses, and one destination or
 * a list of them, never both (Cloudflare's `SendEmailDestinationOptions`).
 */
const SendEmailResourceSchemaStrict = SendEmailResourceSchema.extend({
  name: BindingNameSchema,
  allowedSenderAddresses: z
    .array(EmailAddressSchema, {
      error: (issue) =>
        issue.input === undefined ? SENDERS_REQUIRED : undefined,
    })
    .min(1, SENDERS_REQUIRED),
  destinationAddress: EmailAddressSchema.optional(),
  allowedDestinationAddresses: EmailAddressListSchema.optional(),
})
  .strict()
  .refine(
    (entry) =>
      entry.destinationAddress === undefined ||
      entry.allowedDestinationAddresses === undefined,
    {
      message:
        "destinationAddress and allowedDestinationAddresses can't both be set: one destination, or a list of them",
      path: ["allowedDestinationAddresses"],
    },
  );

export const ResourcesSchemaStrict = ResourcesSchema.extend({
  d1: z.array(BindingNameSchema).optional(),
  kv: z.array(BindingNameSchema).optional(),
  r2: z.array(BindingNameSchema).optional(),
  ai: z.array(BindingNameSchema).optional(),
  browser: z.array(BindingNameSchema).optional(),
  images: z.array(BindingNameSchema).optional(),
  analyticsEngine: z
    .array(
      AnalyticsEngineResourceSchema.extend({
        // A Worker name is at most 63 characters, so the default dataset,
        // `<worker>--<binding>`, fits Cloudflare's 128 with one this long.
        name: BindingNameSchema.max(
          63,
          `Analytics Engine binding names are at most 63 characters, so the dataset named after the Worker fits Cloudflare's ${MAX_DATASET_NAME_LENGTH}`,
        ),
        dataset: z
          .string()
          .regex(
            new RegExp(`^[A-Za-z0-9_-]{1,${MAX_DATASET_NAME_LENGTH}}$`),
            `dataset names are letters, digits, dashes and underscores, at most ${MAX_DATASET_NAME_LENGTH} characters (Cloudflare's rule)`,
          )
          .optional(),
      }).strict(),
    )
    .optional(),
  durableObjects: z.array(ClassResourceSchema.strict()).optional(),
  workflows: z
    .array(ClassResourceSchema.extend({ name: BindingNameSchema }).strict())
    .optional(),
  hyperdrive: z
    .array(
      HyperdriveResourceSchema.extend({ name: BindingNameSchema }).strict(),
    )
    .optional(),
  queues: z
    .array(
      QueueResourceSchema.extend({
        name: QueueBindingNameSchema,
        consumer: z
          .union([
            z.literal(true),
            QueueConsumerSchema.extend({
              maxBatchSize: z.number().int().positive().optional(),
              maxBatchTimeout: z.number().nonnegative().optional(),
              maxRetries: z.number().int().nonnegative().optional(),
              maxConcurrency: z.number().int().positive().nullable().optional(),
              retryDelay: z.number().int().nonnegative().optional(),
              visibilityTimeoutMs: z.number().int().nonnegative().optional(),
            }).strict(),
          ])
          .optional(),
      }).strict(),
    )
    .optional(),
  vectorize: z.array(VectorizeResourceSchemaStrict).optional(),
  aiGateway: z
    .array(
      AiGatewayResourceSchema.extend({
        name: AiGatewayBindingNameSchema,
      }).strict(),
    )
    .optional(),
  sendEmail: z.array(SendEmailResourceSchemaStrict).optional(),
  secretsStore: z
    .array(
      SecretsStoreResourceSchema.extend({ name: BindingNameSchema }).strict(),
    )
    .optional(),
}).strict();
/** How the strict validator looks capability ids up ({@link validateManifestStrict}). */
export interface StrictManifestOptions {
  /** Where capability ids are found: the catalog alone by default, or a gateway's registry. */
  capabilities?: CapabilityLookup;
  /** What to do with an id the lookup doesn't have: refuse it (the default), or accept a well-formed entry for the gateway to check. */
  unknownCapabilities?: UnknownCapabilities;
}

function manifestSchemaStrict(options: StrictManifestOptions = {}) {
  const capabilities =
    options.capabilities === undefined &&
    (options.unknownCapabilities ?? "refuse") === "refuse"
      ? CapabilitiesSchemaStrict
      : capabilitiesSchemaStrict(
          options.capabilities ?? CATALOG,
          options.unknownCapabilities ?? "refuse",
        );
  return ManifestSchema.extend({
    resources: ResourcesSchemaStrict.optional(),
    providers: ProvidersSchemaStrict.optional(),
    workers: z
      .array(
        HelperWorkerSchema.extend({
          binding: BindingNameSchema.optional(),
          limits: WorkerLimitsSchema.strict().optional(),
        }).strict(),
      )
      .optional(),
    public: z.array(PublicRouteSchemaStrict).optional(),
    ai: AiPolicySchemaStrict.optional(),
    capabilities: capabilities.optional(),
    secrets: (options.capabilities
      ? appSecretsSchemaStrict(options.capabilities)
      : AppSecretsSchemaStrict
    ).optional(),
    settings: (options.capabilities
      ? appSettingsSchemaStrict(options.capabilities)
      : AppSettingsSchemaStrict
    ).optional(),
    email: EmailSchemaStrict.optional(),
    database: DatabaseSchema.strict().optional(),
    limits: WorkerLimitsSchema.strict().optional(),
    mcp: McpSchema.strict().optional(),
    bearerRoutes: BearerRoutesSchema.strict().optional(),
  }).strict();
}

export const ManifestSchemaStrict = manifestSchemaStrict();
export type EveryAppManifest = z.infer<typeof ManifestSchemaStrict>;

/** Reserved internal namespace. Nothing under it may ever be public. */
export const EVERYAPP_INTERNAL_PREFIX = "/__everyapp";

/**
 * App ids the platform keeps: "everyapp" prefixes the gateway's own MCP tools
 * (`everyapp_<tool>`), so no app may register under it.
 */
const RESERVED_APP_IDS: readonly string[] = ["everyapp"];

export function isReservedAppId(id: string): boolean {
  return RESERVED_APP_IDS.includes(id);
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * Each problem a parse found as `<path>: <message>`, the path dotted
 * (`capabilities.email.access`) or `(root)`. zod 4's path is a
 * `PropertyKey[]`, so each segment is stringified rather than joined.
 */
function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
    )
    .join("; ");
}

/**
 * Parse and strictly validate a manifest object. Throws {@link ManifestError}
 * on any problem. This is the one place catch-all / internal-prefix public
 * routes are rejected as hard errors (not warnings).
 */
export function validateManifest(input: unknown): Manifest {
  const parsed = ManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ManifestError(
      `Invalid manifest: ${describeIssues(parsed.error.issues)}`,
    );
  }
  const manifest = parsed.data;

  for (const route of manifest.public ?? []) {
    assertPublicPathIsSafe(route.path);
  }
  for (const path of manifest.publicAssets ?? []) {
    assertPublicPathIsSafe(path, PUBLIC_ASSET_LABEL);
  }
  assertBearerRoutesAreSafe(manifest);
  return manifest;
}

/** How a `publicAssets` pattern is named in a refusal. */
const PUBLIC_ASSET_LABEL = "publicAssets: pattern";
/** How a `bearerRoutes` pattern is named in a refusal. */
const BEARER_ROUTE_LABEL = "bearerRoutes: pattern";

/**
 * A `bearerRoutes` pattern obeys the public-route safety rules (absolute,
 * no catch-all, no encoding, never the internal namespace), is never
 * `/mcp` nor covers it (the host's `/mcp` is served to MCP clients by its
 * own rule and must stay behind Access), and is not also a public route
 * or public asset pattern: a path is served to anyone, or to a bearer
 * only, never both. Checked at registration and at author time alike, so
 * a stored row can't widen what the perimeter lets a cookie reach.
 */
function assertBearerRoutesAreSafe(manifest: {
  bearerRoutes?: BearerRoutes;
  public?: PublicRoute[];
  publicAssets?: string[];
}): void {
  const publicPaths = new Set([
    ...(manifest.public ?? []).map((route) => route.path),
    ...(manifest.publicAssets ?? []),
  ]);
  for (const path of manifest.bearerRoutes?.paths ?? []) {
    assertPublicPathIsSafe(path, BEARER_ROUTE_LABEL);
    const covers =
      isMcpPath(path) ||
      matchPublicRoute([{ path, methods: ["GET"] }], "GET", "/mcp").public;
    if (covers) {
      throw new ManifestError(
        `Invalid everyapp.config: bearerRoutes: ${path} can't be a bearer route${isMcpPath(path) ? "" : " (it covers /mcp)"}; /mcp takes MCP clients by its own rule`,
      );
    }
    if (publicPaths.has(path)) {
      throw new ManifestError(
        `Invalid everyapp.config: bearerRoutes: ${path} is also public; a path is open to anyone or to a bearer only, not both`,
      );
    }
  }
}

/**
 * Refuse a `publicAssets` pattern that is `/mcp`, under it, or covers it
 * (`/:page`): the host's `/mcp` is never a static file.
 */
function assertPublicAssetsSkipMcp(manifest: EveryAppManifest): void {
  for (const path of manifest.publicAssets ?? []) {
    const covers = PUBLIC_ASSET_METHODS.some(
      (method) =>
        matchPublicRoute([{ path, methods: [method] }], method, "/mcp").public,
    );
    if (isMcpPath(path) || covers) {
      throw new ManifestError(
        `Invalid everyapp.config: publicAssets: ${path} can't be a public asset${isMcpPath(path) ? "" : " (it covers /mcp)"}; /mcp is never a static file`,
      );
    }
  }
}

/**
 * Parse and strictly validate an authored manifest. This is the CLI-facing
 * author-time linter: unknown top-level/resource/public-route keys fail here,
 * while gateway registration uses {@link validateManifest} and remains
 * tolerant of additive fields from newer CLIs.
 */
export function validateManifestStrict(
  input: unknown,
  options: StrictManifestOptions = {},
): EveryAppManifest {
  const parsed = manifestSchemaStrict(options).safeParse(input);
  if (!parsed.success) {
    throw new ManifestError(
      `Invalid everyapp.config: ${describeIssues(parsed.error.issues)}`,
    );
  }
  const manifest = parsed.data;
  // A secret named like one of the app's bindings would only fail at
  // upload, or shadow the binding.
  const bindings = bindingNamesOf(manifest);
  const taken = secretNames(manifest).find((name) => bindings.has(name));
  if (taken) {
    throw new ManifestError(
      `Invalid everyapp.config: secrets: ${taken} is one of the app's bindings; pick another name for the secret`,
    );
  }
  const secrets = new Set(secretNames(manifest));
  for (const name of settingNames(manifest)) {
    if (bindings.has(name)) {
      throw new ManifestError(
        `Invalid everyapp.config: settings: ${name} is one of the app's bindings; pick another name for the setting`,
      );
    }
    if (secrets.has(name)) {
      throw new ManifestError(
        `Invalid everyapp.config: settings: ${name} is one of the app's secrets too; declare it once, under secrets when it is a key, under settings when it isn't`,
      );
    }
  }
  if (isReservedAppId(manifest.id)) {
    throw new ManifestError(
      `Invalid everyapp.config: id "${manifest.id}" is reserved for the platform.`,
    );
  }

  for (const route of manifest.public ?? []) {
    assertPublicPathIsSafe(route.path);
    // A public /mcp is served by nobody the Gateway vouches for: the
    // perimeter skips the ToolBus there and Access lets it through. A
    // pattern that covers /mcp (`/:page`) under any of the route's
    // methods is the same hole as the path itself. An app with its own
    // MCP server says `mcp: { by: "app" }` and gets the identity header
    // instead.
    const named = route.path === "/mcp" || route.path.startsWith("/mcp/");
    const covers =
      named ||
      (route.methods ?? ["GET"]).some(
        (method) => matchPublicRoute([route], method, "/mcp").public,
      );
    if (covers) {
      throw new ManifestError(
        `Invalid everyapp.config: public: ${route.path} can't be public${named ? "" : " (it covers /mcp)"}; an app that runs its own MCP server sets mcp: { by: "app", why: "..." }`,
      );
    }
    // A public route over the TanStack server-function endpoint makes every
    // server function that skips its own user check callable by anyone: the
    // same-origin guard there is a CSRF check, not authentication. A public
    // page that needs data gets its own route (`/api/public/...`).
    const serverFnBase = (manifest.serverFnBase ?? "/_serverFn").replace(
      /\/+$/,
      "",
    );
    const coversServerFns = ["GET", "POST"].some(
      (method) =>
        matchPublicRoute([route], method, `${serverFnBase}/fn`).public,
    );
    if (coversServerFns) {
      throw new ManifestError(
        `Invalid everyapp.config: public: ${route.path} can't be public (it covers ${serverFnBase}, where every server function lives); serve the public page's data from a route of its own, such as /api/public/...`,
      );
    }
  }
  for (const path of manifest.publicAssets ?? []) {
    assertPublicPathIsSafe(path, PUBLIC_ASSET_LABEL);
  }
  assertPublicAssetsSkipMcp(manifest);
  assertBearerRoutesAreSafe(manifest);
  assertHelperWorkersAreDeclared(manifest);
  assertQueuesAreConsistent(manifest);
  assertDatabaseIsConsistent(manifest);
  assertAiGatewayIdsFit(manifest);
  assertSettingNeedsAreConsistent(manifest);
  return manifest;
}

/**
 * Each AI Gateway's id fits Cloudflare's 64 characters on any Gateway:
 * the Worker name it starts with is `every-<orgKey>-<id>`, and an org key
 * is at most {@link MAX_ORG_KEY_LENGTH} characters, so the longest id the
 * manifest can give is known before any organization is.
 */
function assertAiGatewayIdsFit(manifest: EveryAppManifest): void {
  const longestWorker = registryWorkerNameFor({
    appId: manifest.id,
    orgKey: "k".repeat(MAX_ORG_KEY_LENGTH),
  });
  for (const { name } of manifest.resources?.aiGateway ?? []) {
    const id = aiGatewayIdFor(longestWorker, name);
    if (id.length > MAX_AI_GATEWAY_ID_LENGTH) {
      throw new ManifestError(
        `Invalid everyapp.config: resources.aiGateway: ${name} would make an AI Gateway id of up to ${id.length} characters (${aiGatewayIdFor(registryWorkerNameFor({ appId: manifest.id, orgKey: "<orgKey>" }), name)}), longer than Cloudflare's ${MAX_AI_GATEWAY_ID_LENGTH}; shorten the binding name.`,
      );
    }
  }
}

/**
 * Each declaration's need reads one way: not both `optional` and a
 * `anyOf` group (a group's member is optional by itself), and every
 * any-of group has two or more members across providers, capabilities and
 * secrets (one member alone is either required or optional).
 */
function assertSettingNeedsAreConsistent(manifest: EveryAppManifest): void {
  const declared: Array<{ path: string; need: SettingNeedFields }> = [
    ...providerEntries(manifest).map((entry) => ({
      path: `providers: ${entry.id}`,
      need: entry,
    })),
    ...Object.entries(manifest.capabilities ?? {}).map(([id, entry]) => ({
      path: `capabilities.${id}`,
      need: entry,
    })),
    ...secretEntries(manifest).map((entry) => ({
      path: `secrets: ${entry.name}`,
      need: entry,
    })),
  ];
  const groups = new Map<string, string[]>();
  for (const { path, need } of declared) {
    const group = need.anyOf?.trim();
    if (need.optional === true && group) {
      throw new ManifestError(
        `Invalid everyapp.config: ${path} is both optional and in the any-of group "${group}"; a group's member is optional by itself, so drop one of them.`,
      );
    }
    if (group) groups.set(group, [...(groups.get(group) ?? []), path]);
  }
  for (const [group, members] of groups) {
    if (members.length < 2) {
      throw new ManifestError(
        `Invalid everyapp.config: the any-of group "${group}" has one member (${members[0]}); an any-of group needs two or more. Drop anyOf, or mark it optional.`,
      );
    }
  }
}

/**
 * Each helper Worker is named once, and every Durable Object or Workflow
 * that names a helper Worker names a declared one.
 */
function assertHelperWorkersAreDeclared(manifest: EveryAppManifest): void {
  const helpers = new Set<string>();
  for (const { name } of manifest.workers ?? []) {
    if (helpers.has(name)) {
      throw new ManifestError(
        `Invalid everyapp.config: workers lists "${name}" twice.`,
      );
    }
    helpers.add(name);
  }
  const resources = manifest.resources;
  for (const resource of [
    ...(resources?.durableObjects ?? []),
    ...(resources?.workflows ?? []),
  ]) {
    if (resource.worker !== undefined && !helpers.has(resource.worker)) {
      throw new ManifestError(
        `Invalid everyapp.config: ${resource.name} is defined by Worker "${resource.worker}", which workers doesn't declare.`,
      );
    }
  }
  for (const resource of resources?.hyperdrive ?? []) {
    if (resource.worker !== undefined && !helpers.has(resource.worker)) {
      throw new ManifestError(
        `Invalid everyapp.config: Hyperdrive ${resource.name} is bound by Worker "${resource.worker}", which workers doesn't declare.`,
      );
    }
  }
}

/**
 * Each queue's consumer is a Worker the app has, and its dead-letter
 * queue another of the app's queues: Cloudflare creates a dead-letter
 * queue that doesn't exist, so naming anything else would make a queue
 * no deploy records.
 */
function assertQueuesAreConsistent(manifest: EveryAppManifest): void {
  const queues = manifest.resources?.queues ?? [];
  const helpers = new Set((manifest.workers ?? []).map(({ name }) => name));
  const bindings = new Set(queues.map(({ name }) => name));
  for (const queue of queues) {
    if (queue.consumer === undefined || queue.consumer === true) continue;
    const { worker, deadLetterQueue } = queue.consumer;
    if (worker !== undefined && !helpers.has(worker)) {
      throw new ManifestError(
        `Invalid everyapp.config: Queue ${queue.name} is consumed by Worker "${worker}", which workers doesn't declare.`,
      );
    }
    if (deadLetterQueue === undefined) continue;
    if (deadLetterQueue === queue.name) {
      throw new ManifestError(
        `Invalid everyapp.config: Queue ${queue.name} can't be its own dead-letter queue; name another of resources.queues.`,
      );
    }
    if (!bindings.has(deadLetterQueue)) {
      throw new ManifestError(
        `Invalid everyapp.config: Queue ${queue.name}'s deadLetterQueue "${deadLetterQueue}" isn't one of resources.queues; declare it there and name its binding.`,
      );
    }
  }
}

/**
 * Postgres migrations and the database the code talks to agree, and each
 * binding name is used once among the app's storage bindings.
 */
function assertDatabaseIsConsistent(manifest: EveryAppManifest): void {
  if (
    manifest.migrations?.dialect === "postgresql" &&
    manifest.database?.provider !== "postgres"
  ) {
    throw new ManifestError(
      'Invalid everyapp.config: Postgres migrations (migrations.dialect "postgresql") need database: { provider: "postgres" }.',
    );
  }
  const names = new Set<string>();
  for (const name of [
    ...(manifest.resources?.d1 ?? []),
    ...(manifest.resources?.kv ?? []),
    ...(manifest.resources?.r2 ?? []),
    ...(manifest.resources?.hyperdrive ?? []).map((h) => h.name),
    ...(manifest.resources?.queues ?? []).map((q) => q.name),
    ...(manifest.resources?.ai ?? []),
    ...(manifest.resources?.browser ?? []),
    ...(manifest.resources?.images ?? []),
    ...(manifest.resources?.vectorize ?? []).map((v) => v.name),
    ...(manifest.resources?.aiGateway ?? []).map((g) => g.name),
    ...(manifest.resources?.sendEmail ?? []).map((s) => s.name),
    ...(manifest.resources?.secretsStore ?? []).map((s) => s.name),
    ...(manifest.resources?.analyticsEngine ?? []).map((a) => a.name),
  ]) {
    if (names.has(name)) {
      throw new ManifestError(
        `Invalid everyapp.config: the binding ${name} is declared twice in resources.`,
      );
    }
    names.add(name);
  }
}

/**
 * The names the app's Workers read their bindings from `env` by: the
 * manifest's resources, helper Worker bindings, DATABASE_PROVIDER when a
 * database is named, and ASSETS. A secret can't take one of them.
 */
export function bindingNamesOf(
  manifest: Pick<Manifest, "resources" | "workers" | "database">,
): Set<string> {
  return new Set([
    ...(manifest.resources?.d1 ?? []),
    ...(manifest.resources?.kv ?? []),
    ...(manifest.resources?.r2 ?? []),
    ...(manifest.resources?.durableObjects ?? []).map((d) => d.name),
    ...(manifest.resources?.workflows ?? []).map((w) => w.name),
    ...(manifest.resources?.hyperdrive ?? []).map((h) => h.name),
    ...(manifest.resources?.queues ?? []).map((q) => q.name),
    ...(manifest.resources?.ai ?? []),
    ...(manifest.resources?.browser ?? []),
    ...(manifest.resources?.images ?? []),
    ...(manifest.resources?.vectorize ?? []).map((v) => v.name),
    ...(manifest.resources?.aiGateway ?? []).map((g) => g.name),
    ...(manifest.resources?.sendEmail ?? []).map((s) => s.name),
    ...(manifest.resources?.secretsStore ?? []).map((s) => s.name),
    ...(manifest.resources?.analyticsEngine ?? []).map((a) => a.name),
    ...(manifest.workers ?? []).flatMap((w) => (w.binding ? [w.binding] : [])),
    ...(manifest.database ? ["DATABASE_PROVIDER"] : []),
    "ASSETS",
  ]);
}

/**
 * What a manifest asks for that an app on `tier` can't have, as sentences.
 * The dispatch tier (customer code in a Workers for Platforms namespace)
 * gets no Hyperdrive: an account holds at most 25 configs, so they are kept
 * for first-party apps. Nor R2 buckets yet: the hosted deployer refuses R2
 * bindings. Nor Workers AI: the binding bills whatever account the Worker
 * runs in, the platform's here, with no Gateway budget (the `workers-ai`
 * provider is the brokered path). Nor Browser Rendering: the browser time
 * bills the platform's account the same way, nor Images, whose
 * transformations do too. Nor Vectorize indexes: the hosted deployer makes
 * none. Nor AI Gateways yet. Nor a `send_email` binding: it would send from
 * the platform's account, past the Gateway's budgets and sender list. Nor
 * Secrets Store secrets: the store is the platform account's. Nor Analytics
 * Engine: a dataset's name is account-wide, and its writes bill the account.
 * Nor inbound mail: the platform's zones aren't an organization's to route.
 * Nor secrets or settings of its own: a third-party Worker gets GATEWAY_URL and
 * EVERY_APP_ORG_ID only, and nothing sets another.
 */
export function manifestTierProblems(
  manifest: Pick<Manifest, "resources" | "email" | "secrets" | "settings">,
  tier: string,
): string[] {
  if (tier === "service_binding") return [];
  if (tier !== "dispatch") return [`apps on tier "${tier}" can't be deployed`];
  const problems: string[] = [];
  if (manifest.resources?.hyperdrive?.length) {
    problems.push(
      "resources.hyperdrive: Hyperdrive isn't available to apps in a dispatch namespace (an account holds at most 25 configs)",
    );
  }
  if (manifest.resources?.r2?.length) {
    problems.push(
      "resources.r2: R2 buckets aren't available to apps in a dispatch namespace yet",
    );
  }
  if (manifest.resources?.queues?.length) {
    problems.push(
      "resources.queues: Queues aren't available to apps in a dispatch namespace yet",
    );
  }
  if (manifest.resources?.ai?.length) {
    problems.push(
      "resources.ai: the Workers AI binding isn't available to apps in a dispatch namespace (it bills the platform's account); list the workers-ai provider instead",
    );
  }
  if (manifest.resources?.browser?.length) {
    problems.push(
      "resources.browser: Browser Rendering isn't available to apps in a dispatch namespace (it bills the platform's account)",
    );
  }
  if (manifest.resources?.images?.length) {
    problems.push(
      "resources.images: the Images binding isn't available to apps in a dispatch namespace (it bills the platform's account)",
    );
  }
  if (manifest.resources?.vectorize?.length) {
    problems.push(
      "resources.vectorize: Vectorize indexes aren't available to apps in a dispatch namespace yet",
    );
  }
  if (manifest.resources?.aiGateway?.length) {
    problems.push(
      "resources.aiGateway: AI Gateways aren't available to apps in a dispatch namespace yet",
    );
  }
  if (manifest.resources?.sendEmail?.length) {
    problems.push(
      "resources.sendEmail: Email sending bindings aren't available to apps in a dispatch namespace (they send through the Gateway's email capability)",
    );
  }
  if (manifest.resources?.secretsStore?.length) {
    problems.push(
      "resources.secretsStore: Secrets Store secrets aren't available to apps in a dispatch namespace (the store is the platform account's)",
    );
  }
  if (manifest.resources?.analyticsEngine?.length) {
    problems.push(
      "resources.analyticsEngine: Analytics Engine datasets aren't available to apps in a dispatch namespace (their names are account-wide and their writes bill the platform's account)",
    );
  }
  if (manifest.email?.inbound === true) problems.push(DISPATCH_INBOUND_PROBLEM);
  if (manifest.secrets?.length) {
    problems.push(
      "secrets: third-party apps can't have secrets of their own yet",
    );
  }
  if (manifest.settings?.length) {
    problems.push(
      "settings: third-party apps can't have settings of their own yet",
    );
  }
  return problems;
}

/**
 * The dev Worker name, and the name apps registered before org-scoped names
 * keep, e.g. "todo" -> "every-todo".
 */
export function workerNameFor(appId: string): string {
  return appId.startsWith("every-") ? appId : `every-${appId}`;
}

/**
 * The default Gateway's Worker script name (`gatewayNames(null).worker`);
 * a named Gateway's is `every-app-gateway-<name>` (./gatewayNames.ts). No
 * app may use or bind either.
 */
export const GATEWAY_WORKER_NAME = GATEWAY_ROOT;

/** Cloudflare's limit on a Worker's name. */
export const MAX_WORKER_NAME_LENGTH = 63;

/**
 * Names the gateway's own resources use: its Worker, D1 database and KV
 * namespace (`every-app-gateway`, `every-app-gateway-OAUTH_KV`). No app
 * Worker may take one, and so no app
 * resource either, since a get-or-create by name would hand the app the
 * gateway's own.
 */
export function isReservedName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === GATEWAY_WORKER_NAME || lower.startsWith(`${GATEWAY_WORKER_NAME}-`)
  );
}

/**
 * What separates an org-scoped app's Worker name from the suffix of a
 * resource named after it. Org keys have no hyphens and no org-scoped app id
 * may contain it, so `every-acme-notes--archive` can only ever be app
 * `notes`'s ARCHIVE database, never app `notes-archive`'s own.
 */
export { RESOURCE_SEPARATOR } from "./gatewayNames";

interface RegistryNaming {
  appId: string;
  /** The organization's immutable key (`organization_keys.org_key`). */
  orgKey: string | null;
  /**
   * The Gateway's name (./gatewayNames.ts): null or absent for the default
   * Gateway. A named Gateway's apps are `every-<name>--<orgKey>-<appId>`.
   */
  gatewayName?: string | null;
}

/**
 * The Worker name the gateway assigns an app at registration,
 * `every-<orgKey>-<appId>` (on a named Gateway, behind its app prefix:
 * `every-<name>--<orgKey>-<appId>`), so two organizations never share a
 * Worker, D1 database or KV namespace, and two Gateways in one account
 * never do either.
 */
export function registryWorkerNameFor({
  appId,
  orgKey,
  gatewayName,
}: RegistryNaming): string {
  if (!orgKey) throw new Error("An org-scoped Worker name needs an org key.");
  return `${gatewayNames(gatewayName).appPrefix}${orgKey}-${appId}`;
}

/**
 * Whether a registry row's Worker is the one its naming rule gives it, fits
 * Cloudflare's limit and isn't the gateway's. The gateway only binds such
 * rows, so the registry can never route a hostname to another Worker in the
 * Cloudflare account.
 */
export function isRegistryWorkerName(
  row: RegistryNaming & { workerName: string },
): boolean {
  if (
    isReservedName(row.workerName) ||
    row.workerName.length > MAX_WORKER_NAME_LENGTH ||
    !row.orgKey ||
    row.appId.includes(RESOURCE_SEPARATOR)
  ) {
    return false;
  }
  return row.workerName === registryWorkerNameFor(row);
}

/**
 * The D1 database or KV namespace an app Worker's binding uses: `DB` and
 * `KV` take the Worker's name, any other binding appends its own after
 * {@link RESOURCE_SEPARATOR} (`every-acme-notes--archive`).
 */
export function resourceNameFor(workerName: string, binding: string): string {
  if (binding === "DB" || binding === "KV") return workerName;
  return suffixedName(workerName, binding);
}

/** Cloudflare's limit on an R2 bucket's name. */
export const MAX_BUCKET_NAME_LENGTH = 63;

/**
 * The R2 bucket an app Worker's binding uses: `R2` takes the Worker's name
 * (the bucket apps bound by hand before `resources.r2`), any other binding
 * appends its own after {@link RESOURCE_SEPARATOR}
 * (`every-acme-postiz--media`).
 */
export function bucketNameFor(workerName: string, binding: string): string {
  return binding === "R2" ? workerName : suffixedName(workerName, binding);
}

/** Cloudflare's limit on a queue's name. */
export const MAX_QUEUE_NAME_LENGTH = 63;

/**
 * Cloudflare's rule for a queue's name: lowercase letters, digits and
 * hyphens, starting and ending with a letter or digit, at most
 * {@link MAX_QUEUE_NAME_LENGTH} characters.
 */
const QUEUE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The queue an app Worker's binding produces to and consumes from, named
 * after the Worker: `every-acme-seo` and `JOBS` → `every-acme-seo--jobs`.
 * Queue names are unique in the account, and new app ids can't contain
 * `--`, so one app's queue is never named like another app's.
 */
export function queueNameFor(workerName: string, binding: string): string {
  return suffixedName(workerName, binding);
}

/** Whether Cloudflare takes `name` for a queue ({@link MAX_QUEUE_NAME_LENGTH}). */
export function isValidQueueName(name: string): boolean {
  return name.length <= MAX_QUEUE_NAME_LENGTH && QUEUE_NAME.test(name);
}

/** Cloudflare's limit on a Vectorize index's name. */
export const MAX_VECTORIZE_NAME_LENGTH = 64;

/**
 * The Vectorize index an app Worker's binding uses: always
 * `<worker>--<binding>` (`every-acme-notes--vectors`), the binding
 * lowercased with `_` as `-`, so lowercase letters, digits and hyphens,
 * which is what Cloudflare accepts. At most
 * {@link MAX_VECTORIZE_NAME_LENGTH} characters, which the deploy checks
 * once the Worker's name is known (`VECTORIZE_NAME_TOO_LONG`).
 */
export function vectorizeNameFor(workerName: string, binding: string): string {
  return suffixedName(workerName, binding);
}

/** Cloudflare's limit on an AI Gateway's id. */
export const MAX_AI_GATEWAY_ID_LENGTH = 64;

/** The longest organization key registration assigns (`orgKeyCandidates()`). */
export const MAX_ORG_KEY_LENGTH = 12;

/**
 * Cloudflare's rule for an AI Gateway's id, seen live on 2026-10-24
 * (`[7001] not valid ID format` otherwise): lowercase letters and digits,
 * joined by single hyphens, at most {@link MAX_AI_GATEWAY_ID_LENGTH}.
 */
const AI_GATEWAY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isAiGatewayId(id: string): boolean {
  return id.length <= MAX_AI_GATEWAY_ID_LENGTH && AI_GATEWAY_ID.test(id);
}

/**
 * The AI Gateway an app Worker's binding uses: the Worker's name and the
 * binding lowercased with `_` as `-`, joined by ONE hyphen
 * (`every-acme-notes` and `AI_GATEWAY` → `every-acme-notes-ai-gateway`),
 * since an id may not hold {@link RESOURCE_SEPARATOR}. So the id alone
 * doesn't say whose it is (app `notes-ai`'s `GATEWAY` would be the same);
 * the resource ledger does, and refuses one it didn't record.
 */
export function aiGatewayIdFor(workerName: string, binding: string): string {
  return `${aiGatewayWorkerStem(workerName)}-${binding.toLowerCase().replaceAll("_", "-")}`;
}

/**
 * What an app's AI Gateway ids start with: its Worker name, except on a
 * named Gateway, whose app Workers hold `--` (`every-demo--acme-notes`),
 * which an id may not: those go under the Gateway's reserved root instead
 * (`every-app-gateway-demo-acme-notes`), which keeps them apart from every
 * other Gateway's (./gatewayNames.ts).
 */
function aiGatewayWorkerStem(workerName: string): string {
  const named = /^every-([a-z0-9]+)--(.+)$/.exec(workerName);
  if (!named) return workerName;
  return `${gatewayNames(named[1]).aiGatewayPrefix}${named[2]}`;
}

/**
 * The Secrets Store secret an app Worker's binding uses, in the account's
 * store: `<worker>--<binding lowercased, _ as ->` for every binding
 * (`every-acme-shop--stripe-key`), so the teardown's `every-` scan finds it.
 */
export function storeSecretNameFor(
  workerName: string,
  binding: string,
): string {
  return suffixedName(workerName, binding);
}

/**
 * The Analytics Engine dataset an app Worker's binding writes to when the
 * manifest names none: the binding after {@link RESOURCE_SEPARATOR}, as
 * every other account-wide name (`every-acme-shop--events`). SQL reads it
 * double-quoted (`FROM "every-acme-shop--events"`): the API's parser takes
 * an unquoted `-` as minus.
 */
export function analyticsDatasetFor(
  workerName: string,
  binding: string,
): string {
  return suffixedName(workerName, binding);
}

function suffixedName(workerName: string, binding: string): string {
  const suffix = binding.toLowerCase().replaceAll("_", "-");
  return `${workerName}${RESOURCE_SEPARATOR}${suffix}`;
}

/**
 * Reject public-route declarations that are structurally dangerous, regardless
 * of request-time normalization. These are author mistakes, so they fail the
 * deploy rather than silently narrowing.
 */
export function assertPublicPathIsSafe(
  path: string,
  what = "Public route",
): void {
  if (!path.startsWith("/")) {
    throw new ManifestError(
      `${what} path must be absolute (start with "/"): ${JSON.stringify(path)}`,
    );
  }
  // A root catch-all defeats default-private. Hard error, never a warning.
  if (path === "/*" || path === "/**" || path === "*" || path === "/") {
    throw new ManifestError(
      `${what} "${path}" exposes the entire app. A catch-all public route is not allowed.`,
    );
  }
  if (path.includes("%")) {
    throw new ManifestError(
      `${what} "${path}" must not contain percent-encoding; declare the decoded path.`,
    );
  }
  if (path.includes("\\")) {
    throw new ManifestError(`${what} "${path}" must not contain backslashes.`);
  }
  const segments = path.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new ManifestError(
      `${what} "${path}" must not contain "." or ".." segments.`,
    );
  }
  for (const segment of segments) {
    if (segment.startsWith(":") && !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      throw new ManifestError(
        `${what} "${path}" has an invalid named segment "${segment}".`,
      );
    }
  }
  // Nothing under the reserved internal namespace can be public.
  const firstSegment = "/" + (segments[1] ?? "");
  if (
    path === EVERYAPP_INTERNAL_PREFIX ||
    path.startsWith(EVERYAPP_INTERNAL_PREFIX + "/") ||
    firstSegment === EVERYAPP_INTERNAL_PREFIX
  ) {
    throw new ManifestError(
      `${what} "${path}" targets the reserved ${EVERYAPP_INTERNAL_PREFIX} namespace, which can never be public.`,
    );
  }
}

function isSafeRelativePath(value: string): boolean {
  if (!value.trim()) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === "..");
}
