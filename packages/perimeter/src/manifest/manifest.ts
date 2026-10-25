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
  CAPABILITIES,
  EMAIL_SET_COMMAND,
  gatewaySettingOwner,
  isCapabilityId,
  isReservedAppSecretName,
  isRemoteMcpSecretName,
  isSettableGatewaySetting,
  providerEntries,
  RESERVED_APP_SECRET_NAMES_TEXT,
  secretEntries,
  secretNames,
  type CapabilityId,
  type SettingNeedFields,
} from "@every-app/sdk/internal";
import { matchPublicRoute } from "../publicRoutes";

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
  })
  .passthrough();
export type Resources = z.infer<typeof ResourcesSchema>;

const CompatibilityDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const SCOPE_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

/**
 * The records keyed by an id (`scopes`, `capabilities`) take `z.string()`
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

// Reserved ids are rejected in BOTH the tolerant (gateway) and strict (CLI)
// schemas: provider:* scopes belonged to the retired egress credential plane
// and must not be registrable from any path.
const ScopesSchema = z
  .record(z.string(), z.string().min(1).max(200))
  .superRefine((scopes, ctx) => {
    for (const scope of Object.keys(scopes)) {
      if (scope === "*" || scope.startsWith("provider:")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [scope],
          message: "reserved scope id",
        });
      } else if (!SCOPE_ID.test(scope)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [scope],
          message: "invalid scope id",
        });
      }
    }
  }, everyKey);

const ScopesSchemaStrict = ScopesSchema;

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
  /** What the app does with it; each capability says which levels it offers. */
  access: z.enum(["read", "write"]),
  ...SettingNeedFieldsSchema,
});

export const CapabilityRequestSchema = CapabilityEntryBaseSchema.passthrough();
export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;

/**
 * What one capability's manifest entry takes: `access`, and its need
 * (`why`, `docs`, `optional`, `anyOf`). Strict:
 * anything else is unknown here; an installation's email senders aren't
 * the manifest's (`everyapp email set`), and `CapabilitiesSchemaStrict`
 * names the command for a manifest that still lists them.
 *
 * An OAuth client with a scope policy also takes `scopes`, one or more of
 * its set names, each once; every other capability refuses the field.
 */
export function capabilityEntrySchema(id: CapabilityId) {
  const capability = CAPABILITIES[id];
  const access = z
    .enum(["read", "write"])
    .refine(
      (level) => (capability.access as readonly string[]).includes(level),
      `${capability.label} offers ${capability.access.join(" or ")} access`,
    );
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
    return CapabilityEntryBaseSchema.extend({ access, scopes }).strict();
  }
  // Own keys only: `constructor` is not a set.
  const names = Object.keys(policy.sets) as [string, ...string[]];
  const needsScopes = `${capability.label} needs scopes: one or more of ${names.join(", ")}`;
  const scopes = z
    .array(
      z.enum(names, {
        error: `unknown scope set (${capability.label} offers: ${names.join(", ")})`,
      }),
      { error: needsScopes },
    )
    .min(1, needsScopes)
    .refine(
      (list) => new Set(list).size === list.length,
      "a scope set is listed twice",
    );
  return CapabilityEntryBaseSchema.extend({ access, scopes }).strict();
}

/** One authored capability entry, whichever capability it is for. */
export type CapabilityEntry = z.infer<typeof CapabilityEntryBaseSchema>;

const CapabilitiesSchema = z
  .record(z.string(), CapabilityRequestSchema)
  .superRefine((capabilities, ctx) => {
    for (const id of Object.keys(capabilities)) addProviderNameIssue(id, ctx);
  }, everyKey);

const CapabilitiesSchemaStrict = z
  .record(z.string(), z.unknown())
  .superRefine((capabilities, ctx) => {
    for (const [id, entry] of Object.entries(capabilities)) {
      if (addProviderNameIssue(id, ctx)) continue;
      if (!isCapabilityId(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [id],
          message: `unknown capability (the gateway offers: ${Object.keys(CAPABILITIES).join(", ")})`,
        });
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
      const parsed = capabilityEntrySchema(id).safeParse(entry);
      if (parsed.success) continue;
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: [id, ...issue.path] });
      }
    }
  }, everyKey)
  .transform((capabilities) => capabilities as Record<string, CapabilityEntry>);

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
  })
  .passthrough();
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
    /** Opaque app-domain scopes that PATs may request. */
    scopes: ScopesSchema.optional(),
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

const AppSecretsSchemaStrict = z
  .array(z.union([BindingNameSchema, SecretEntrySchemaStrict]))
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const name = typeof entry === "string" ? entry : entry.name;
      const issue = (message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message });
      if (seen.has(name)) issue(`duplicate secret ${name}`);
      seen.add(name);
      if (isReservedAppSecretName(name)) {
        issue(
          `${name} is set by everyapp itself (${RESERVED_APP_SECRET_NAMES_TEXT})`,
        );
        return;
      }
      const upper = name.toUpperCase();
      if (!isSettableGatewaySetting(upper)) return;
      if (isRemoteMcpSecretName(upper)) {
        issue(
          `${name} is a remote MCP app's credential name (every name ending in _MCP_TOKEN is the Gateway's, set with \`everyapp secret set\`); give the app's secret another name`,
        );
        return;
      }
      const owner = gatewaySettingOwner(upper);
      const instead = owner
        ? `list \`${owner.id}\` under ${owner.kind === "provider" ? "providers" : "capabilities"} instead`
        : "give the app's secret another name";
      issue(
        `${name} is a Gateway setting, which \`everyapp secret set ${upper}\` sets on the Gateway for every app; ${instead}`,
      );
    });
  });

export const ResourcesSchemaStrict = ResourcesSchema.extend({
  d1: z.array(BindingNameSchema).optional(),
  kv: z.array(BindingNameSchema).optional(),
  r2: z.array(BindingNameSchema).optional(),
  durableObjects: z.array(ClassResourceSchema.strict()).optional(),
  workflows: z
    .array(ClassResourceSchema.extend({ name: BindingNameSchema }).strict())
    .optional(),
  hyperdrive: z
    .array(
      HyperdriveResourceSchema.extend({ name: BindingNameSchema }).strict(),
    )
    .optional(),
}).strict();
export const ManifestSchemaStrict = ManifestSchema.extend({
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
  scopes: ScopesSchemaStrict.optional(),
  ai: AiPolicySchema.strict().optional(),
  capabilities: CapabilitiesSchemaStrict.optional(),
  secrets: AppSecretsSchemaStrict.optional(),
  email: EmailSchemaStrict.optional(),
  database: DatabaseSchema.strict().optional(),
  limits: WorkerLimitsSchema.strict().optional(),
  mcp: McpSchema.strict().optional(),
}).strict();
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
  return manifest;
}

/**
 * Parse and strictly validate an authored manifest. This is the CLI-facing
 * author-time linter: unknown top-level/resource/public-route keys fail here,
 * while gateway registration uses {@link validateManifest} and remains
 * tolerant of additive fields from newer CLIs.
 */
export function validateManifestStrict(input: unknown): EveryAppManifest {
  const parsed = ManifestSchemaStrict.safeParse(input);
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
  }
  assertHelperWorkersAreDeclared(manifest);
  assertDatabaseIsConsistent(manifest);
  assertSettingNeedsAreConsistent(manifest);
  return manifest;
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
    ...(manifest.workers ?? []).flatMap((w) => (w.binding ? [w.binding] : [])),
    ...(manifest.database ? ["DATABASE_PROVIDER"] : []),
    "ASSETS",
  ]);
}

/**
 * What a manifest asks for that an app on `tier` can't have, as sentences.
 * The dispatch tier (customer code in a Workers for Platforms namespace)
 * gets no Hyperdrive: an account holds at most 25 configs, so they are
 * kept for first-party apps. Nor R2 buckets yet: the hosted deployer
 * refuses R2 bindings. Nor inbound mail: the platform's zones aren't an
 * organization's to route. Nor secrets of its own: a third-party Worker
 * gets GATEWAY_URL and EVERY_APP_ORG_ID only, and nothing sets another.
 */
export function manifestTierProblems(
  manifest: Pick<Manifest, "resources" | "email" | "secrets">,
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
  if (manifest.email?.inbound === true) problems.push(DISPATCH_INBOUND_PROBLEM);
  if (manifest.secrets?.length) {
    problems.push(
      "secrets: third-party apps can't have secrets of their own yet",
    );
  }
  return problems;
}

/** Typed identity helper for everyapp.config.ts authors. */
export function defineEveryApp(manifest: EveryAppManifest): EveryAppManifest {
  return manifest;
}

/**
 * The dev Worker name, and the name apps registered before org-scoped names
 * keep, e.g. "todo" -> "every-todo".
 */
export function workerNameFor(appId: string): string {
  return appId.startsWith("every-") ? appId : `every-${appId}`;
}

/** The gateway's own Worker script name. No app may use or bind it. */
export const GATEWAY_WORKER_NAME = "every-app-gateway";

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
export const RESOURCE_SEPARATOR = "--";

interface RegistryNaming {
  appId: string;
  /** The organization's immutable key (`organization_keys.org_key`). */
  orgKey: string | null;
}

/**
 * The Worker name the gateway assigns an app at registration,
 * `every-<orgKey>-<appId>`, so two organizations never share a Worker, D1
 * database or KV namespace.
 */
export function registryWorkerNameFor({
  appId,
  orgKey,
}: RegistryNaming): string {
  if (!orgKey) throw new Error("An org-scoped Worker name needs an org key.");
  return `every-${orgKey}-${appId}`;
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

function suffixedName(workerName: string, binding: string): string {
  const suffix = binding.toLowerCase().replaceAll("_", "-");
  return `${workerName}${RESOURCE_SEPARATOR}${suffix}`;
}

/**
 * Reject public-route declarations that are structurally dangerous, regardless
 * of request-time normalization. These are author mistakes, so they fail the
 * deploy rather than silently narrowing.
 */
export function assertPublicPathIsSafe(path: string): void {
  if (!path.startsWith("/")) {
    throw new ManifestError(
      `Public route path must be absolute (start with "/"): ${JSON.stringify(path)}`,
    );
  }
  // A root catch-all defeats default-private. Hard error, never a warning.
  if (path === "/*" || path === "/**" || path === "*" || path === "/") {
    throw new ManifestError(
      `Public route "${path}" exposes the entire app. A catch-all public route is not allowed.`,
    );
  }
  if (path.includes("%")) {
    throw new ManifestError(
      `Public route "${path}" must not contain percent-encoding; declare the decoded path.`,
    );
  }
  if (path.includes("\\")) {
    throw new ManifestError(
      `Public route "${path}" must not contain backslashes.`,
    );
  }
  const segments = path.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new ManifestError(
      `Public route "${path}" must not contain "." or ".." segments.`,
    );
  }
  for (const segment of segments) {
    if (segment.startsWith(":") && !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      throw new ManifestError(
        `Public route "${path}" has an invalid named segment "${segment}".`,
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
      `Public route "${path}" targets the reserved ${EVERYAPP_INTERNAL_PREFIX} namespace, which can never be public.`,
    );
  }
}

function isSafeRelativePath(value: string): boolean {
  if (!value.trim()) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === "..");
}
