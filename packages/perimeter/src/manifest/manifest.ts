/**
 * Every App application manifest.
 *
 * The manifest is the single source of truth for an app's identity, resources,
 * and public surface. It is authored as `everyapp.config.ts` in an app repo,
 * compiled to an ephemeral wrangler config by the CLI at deploy time, and
 * snapshotted as a JSON column on the gateway `apps` registry row.
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
    /** Directory of Wrangler D1 SQL migration files, relative to the app root. */
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
    /** Worker entry module (used by the CLI at deploy time). */
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
    /** Shell command that builds the app. Default: "npx vite build". */
    build: z.string().min(1).optional(),
    /** Shell command that starts the app dev server for `everyapp dev`. */
    dev: z.string().min(1).optional(),
    /** Local wrangler dev port written into the generated config. */
    devPort: z.number().int().positive().optional(),
    /** Dependency install command; false skips install; omitted auto-detects. */
    install: InstallSchema.optional(),
    /** Database migration strategy for the app's D1 database. */
    migrations: MigrationsSchema.optional(),
  })
  .passthrough();
export type Manifest = z.infer<typeof ManifestSchema>;

export const PublicRouteSchemaStrict = PublicRouteSchema.strict();
export const ResourcesSchemaStrict = ResourcesSchema.extend({
  durableObjects: z
    .array(z.object({ name: z.string(), className: z.string() }).strict())
    .optional(),
}).strict();
export const ManifestSchemaStrict = ManifestSchema.extend({
  resources: ResourcesSchemaStrict.optional(),
  public: z.array(PublicRouteSchemaStrict).optional(),
  scopes: ScopesSchemaStrict.optional(),
}).strict();
export type EveryAppManifest = z.infer<typeof ManifestSchemaStrict>;

/** Reserved internal namespace. Nothing under it may ever be public. */
export const EVERYAPP_INTERNAL_PREFIX = "/__everyapp";

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

  for (const route of manifest.public ?? []) {
    assertPublicPathIsSafe(route.path);
  }
  return manifest;
}

/** Typed identity helper for everyapp.config.ts authors. */
export function defineEveryApp(manifest: EveryAppManifest): EveryAppManifest {
  return manifest;
}

/** Prefixed worker / resource name, e.g. "todo" -> "every-todo". */
export function workerNameFor(appId: string): string {
  return appId.startsWith("every-") ? appId : `every-${appId}`;
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
