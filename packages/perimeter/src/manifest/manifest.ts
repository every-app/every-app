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
 * dependency-light (zod only) so it can be shared by the perimeter package and
 * the CLI without duplicated schema definitions.
 */
import { z } from "zod";

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
export const ResourcesSchema = z
  .object({
    d1: z.array(z.string()).optional(),
    kv: z.array(z.string()).optional(),
    /** Durable Objects exported by the worker (binding name + class). */
    durableObjects: z
      .array(z.object({ name: z.string(), className: z.string() }))
      .optional(),
    /**
     * Workflows the worker defines (binding name + class). Each is named
     * after the app's Worker in the account, `<worker>--<binding>`.
     */
    workflows: z
      .array(z.object({ name: z.string(), className: z.string() }))
      .optional(),
  })
  .passthrough();
export type Resources = z.infer<typeof ResourcesSchema>;

const CompatibilityDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const ScopeIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9:_-]{0,63}$/, "invalid scope id");

// Reserved ids are rejected in BOTH the tolerant (gateway) and strict (CLI)
// schemas: provider:* scopes belonged to the retired egress credential plane
// and must not be registrable from any path.
const ScopesSchema = z
  .record(ScopeIdSchema, z.string().min(1).max(200))
  .superRefine((scopes, ctx) => {
    for (const scope of Object.keys(scopes)) {
      if (scope === "*" || scope.startsWith("provider:")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [scope],
          message: "reserved scope id",
        });
      }
    }
  });

const ScopesSchemaStrict = ScopesSchema;

export const MigrationsSchema = z
  .object({
    engine: z.enum(["drizzle", "d1-sql"]),
    /** Directory of D1 SQL migration files, relative to the app root. */
    dir: z.string().optional(),
    /** D1 binding to migrate. Defaults to the first declared D1 binding. */
    binding: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
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

export const ProviderNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "provider must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
  );

export const ProvidersSchema = z
  .array(ProviderNameSchema)
  .refine(
    (providers) => new Set(providers).size === providers.length,
    "duplicate provider",
  );

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
     * Legacy: the Worker entry now comes from `cloudflare.config.ts`. Still
     * accepted so existing manifests validate.
     */
    main: z.string().optional(),
    /** Optional Cloudflare Workers compatibility date override. */
    compatibilityDate: CompatibilityDateSchema.optional(),
    /** Cloudflare resources the worker binds. Provisioned by the CLI. */
    resources: ResourcesSchema.optional(),
    /** Routes reachable without an authenticated session. Default: none. */
    public: z.array(PublicRouteSchema).optional(),
    /** Provider APIs this app may call through the gateway. Default: none. */
    providers: ProvidersSchema.optional(),
    /** Opaque app-domain scopes that PATs may request. */
    scopes: ScopesSchema.optional(),
    /** Limits on what the app may do through the gateway's AI proxy. */
    ai: AiPolicySchema.optional(),
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
     * Who answers `<app-host>/mcp`. "gateway" (the default) serves it from
     * the tools the app defines with `defineTools()`; "app" leaves the path
     * to the app's own MCP server.
     */
    mcp: z.enum(["gateway", "app"]).optional(),
  })
  .passthrough();
export type Manifest = z.infer<typeof ManifestSchema>;

export const PublicRouteSchemaStrict = PublicRouteSchema.strict();
/** A D1, KV or Workflow binding: the name the Worker reads from `env`. */
const BindingNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "binding names must be JavaScript identifiers",
  );
export const ResourcesSchemaStrict = ResourcesSchema.extend({
  d1: z.array(BindingNameSchema).optional(),
  kv: z.array(BindingNameSchema).optional(),
  durableObjects: z
    .array(z.object({ name: z.string(), className: z.string() }).strict())
    .optional(),
  workflows: z
    .array(
      z.object({ name: BindingNameSchema, className: z.string() }).strict(),
    )
    .optional(),
}).strict();
export const ManifestSchemaStrict = ManifestSchema.extend({
  resources: ResourcesSchemaStrict.optional(),
  public: z.array(PublicRouteSchemaStrict).optional(),
  scopes: ScopesSchemaStrict.optional(),
  ai: AiPolicySchema.strict().optional(),
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
 * Parse and strictly validate a manifest object. Throws {@link ManifestError}
 * on any problem. This is the one place catch-all / internal-prefix public
 * routes are rejected as hard errors (not warnings).
 */
export function validateManifest(input: unknown): Manifest {
  const parsed = ManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ManifestError(
      `Invalid manifest: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
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
      `Invalid everyapp.config: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const manifest = parsed.data;
  if (isReservedAppId(manifest.id)) {
    throw new ManifestError(
      `Invalid everyapp.config: id "${manifest.id}" is reserved for the platform.`,
    );
  }

  for (const route of manifest.public ?? []) {
    assertPublicPathIsSafe(route.path);
  }
  return manifest;
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
 * namespaces (`every-app-gateway`, `every-app-gateway-OAUTH_KV`,
 * `every-app-gateway-deploy`). No app Worker may take one, and so no app
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
