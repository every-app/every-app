/**
 * Shapes of the cf JSON output the CLI reads. cf prints the unwrapped API
 * result (or a command's own JSON) on stdout; these schemas keep only what
 * callers use and tolerate extra fields. Shapes for API calls the spike
 * couldn't make without an account follow Cloudflare's API documentation.
 */
import { z } from "zod";

/**
 * `cf d1 migrations apply`: one entry per migration applied by this run,
 * e.g. `[{ "name": "0000_init.sql", "status": "✅" }]`; `[]` when the
 * database is up to date.
 */
export const D1MigrationsApplyOutput = z.array(
  z.looseObject({ name: z.string(), status: z.string() }),
);

/** `cf auth whoami`, which exits 0 and says so when logged out too. */
export const CfWhoamiOutput = z.looseObject({
  authenticated: z.boolean(),
  /** What cf authenticated with: "CLOUDFLARE_API_TOKEN environment variable", or "OAuth token from <file>". */
  authSource: z.string().nullish(),
  /** Whether Cloudflare accepted it: a bad env token reads `authenticated: true, tokenValid: false`, no accounts. */
  tokenValid: z.boolean().nullish(),
  email: z.string().nullish(),
  accounts: z
    .array(z.looseObject({ id: z.string(), name: z.string().nullish() }))
    .nullish(),
});
export type CfWhoami = z.infer<typeof CfWhoamiOutput>;

/** `cf d1 create`, and each entry of `cf d1 list`. */
export const D1DatabaseOutput = z.looseObject({
  uuid: z.string(),
  name: z.string(),
});
export const D1DatabaseListOutput = z.array(D1DatabaseOutput);

/**
 * `cf d1 migrations list`: the migrations the database hasn't applied yet,
 * in the order `migrations apply` runs them.
 */
export const D1MigrationsListOutput = z.array(z.looseObject({ Name: z.string() }));

/** What D1 says about a statement it ran: how long it took, and the rows it changed. */
const D1Meta = z
  .looseObject({
    duration: z.number().nullish(),
    changes: z.number().nullish(),
  })
  .nullish();

/** `cf d1 query`: one result per statement, rows as objects. */
export const D1QueryOutput = z.array(
  z.looseObject({
    results: z.array(z.record(z.string(), z.unknown())).nullish(),
    success: z.boolean().nullish(),
    meta: D1Meta,
  }),
);

/** `cf d1 time-travel get-bookmark`. */
export const D1BookmarkOutput = z.looseObject({ bookmark: z.string() });

/** `cf d1 time-travel restore`: the bookmark the database was at before. */
export const D1RestoreOutput = z.looseObject({
  previous_bookmark: z.string().nullish(),
});

/** `cf kv namespaces create`, and each entry of `cf kv namespaces list`. */
export const KvNamespaceOutput = z.looseObject({
  id: z.string(),
  title: z.string(),
});
export const KvNamespaceListOutput = z.array(KvNamespaceOutput);

const Deployment = z.looseObject({
  id: z.string().nullish(),
  created_on: z.string().nullish(),
  versions: z.array(
    z.looseObject({ version_id: z.string(), percentage: z.number() }),
  ),
});

/** `cf workers deployments list`, newest first. */
export const WorkerDeploymentsOutput = z
  .union([
    z.looseObject({ deployments: z.array(Deployment) }),
    z.array(Deployment),
  ])
  .transform((value) => (Array.isArray(value) ? value : value.deployments));

/**
 * `cf workers list` (each entry; `cf workers get` prints one): the Worker
 * and what references it, its Custom Domains among them (hostname and
 * zone). Checked against cf@1.0.0-beta.14 on 2026-10-24.
 */
export const WorkerListOutput = z.array(
  z.looseObject({
    id: z.string().nullish(),
    name: z.string(),
    references: z
      .looseObject({
        domains: z
          .array(
            z.looseObject({
              id: z.string().nullish(),
              hostname: z.string(),
              zone_id: z.string().nullish(),
              zone_name: z.string().nullish(),
            }),
          )
          .nullish(),
      })
      .nullish(),
  }),
);
export type ListedWorker = z.infer<typeof WorkerListOutput>[number];

/**
 * `cf r2 buckets list`: the page's buckets under `buckets` (R2 paginates
 * with a cursor, which cf doesn't print, so callers take one large page).
 * Checked against cf@1.0.0-beta.14 on 2026-10-24.
 */
export const R2BucketListOutput = z
  .looseObject({
    buckets: z.array(z.looseObject({ name: z.string() })).nullish(),
  })
  .transform((value) => value.buckets ?? []);

/** `cf workers secrets list`: names (and types), never values. */
export const WorkerSecretListOutput = z
  .union([
    z.looseObject({ result: z.array(z.looseObject({ name: z.string() })) }),
    z.array(z.looseObject({ name: z.string() })),
  ])
  .transform((value) => (Array.isArray(value) ? value : value.result));

/** `cf zones list`. */
export const ZoneListOutput = z.array(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    status: z.string().nullish(),
  }),
);

/** `cf dns records list`: the records at a name, whatever their type. */
export const DnsRecordListOutput = z.array(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    content: z.string().nullish(),
  }),
);

/** `cf ssl certificate-packs list`. */
export const CertificatePackListOutput = z.array(
  z.looseObject({
    id: z.string(),
    type: z.string().nullish(),
    hosts: z.array(z.string()).nullish(),
    status: z.string().nullish(),
  }),
);

/**
 * `cf workflows get`, and each entry of `cf workflows list`: which Worker
 * runs the Workflow, and (get only) its instances' counts by status.
 */
export const WorkflowOutput = z.looseObject({
  name: z.string(),
  script_name: z.string().nullish(),
  class_name: z.string().nullish(),
  instances: z.record(z.string(), z.number()).nullish(),
});
export type Workflow = z.infer<typeof WorkflowOutput>;
export const WorkflowListOutput = z.array(WorkflowOutput);

/** `cf d1 raw`: one result per statement, rows as arrays. */
export const D1RawOutput = z.array(
  z.looseObject({
    results: z
      .looseObject({
        columns: z.array(z.string()).nullish(),
        rows: z.array(z.array(z.unknown())).nullish(),
      })
      .nullish(),
    meta: D1Meta,
  }),
);

/**
 * `cf hyperdrive create`, and each entry of `cf hyperdrive list`: the
 * config, where it connects (never the password, which the API keeps) and
 * whether it caches reads.
 */
export const HyperdriveConfigOutput = z.looseObject({
  id: z.string(),
  name: z.string(),
  origin: z
    .looseObject({
      host: z.string().nullish(),
      port: z.number().nullish(),
      database: z.string().nullish(),
      user: z.string().nullish(),
      scheme: z.string().nullish(),
    })
    .nullish(),
  // TODO(integration): PR 5 (port/port-resources) reads caching to keep it off.
  caching: z.looseObject({ disabled: z.boolean().nullish() }).nullish(),
});
export type HyperdriveConfig = z.infer<typeof HyperdriveConfigOutput>;
export const HyperdriveConfigListOutput = z.array(HyperdriveConfigOutput);

/**
 * `cf vectorize get`, `create`, and each entry of `cf vectorize list`: the
 * index by its name (it has no other id) and its shape, which can't
 * change once created. An index made from a preset reports the preset's
 * dimensions and metric beside it. Checked against cf@1.0.0-beta.14 on
 * 2026-10-24: `{ created_on, modified_on, name, description, config }`.
 */
export const VectorizeIndexOutput = z.looseObject({
  name: z.string(),
  config: z
    .looseObject({
      dimensions: z.number().nullish(),
      metric: z.string().nullish(),
      preset: z.string().nullish(),
    })
    .nullish(),
  created_on: z.string().nullish(),
});
export type VectorizeIndex = z.infer<typeof VectorizeIndexOutput>;
export const VectorizeIndexListOutput = z.array(VectorizeIndexOutput);

/**
 * `cf ai-gateway gateways get|create|update`, and each entry of
 * `gateways list`: the gateway and its settings. Seen live on 2026-10-24
 * (cf 1.0.0-beta.14): `id, created_at, modified_at,
 * rate_limiting_interval, rate_limiting_limit, rate_limiting_technique,
 * cache_ttl, log_management, log_management_strategy, logpush_public_key,
 * authentication, collect_logs, cache_invalidate_on_update, logpush,
 * wholesale, byok_only, fedramp_level, fedramp_mode, zdr,
 * log_classification, internal, store_id, is_default,
 * workers_ai_billing_mode, retry_max_attempts, retry_delay, retry_backoff`;
 * only what the deploy reads is typed, the rest is kept (an update is a
 * PUT, and sends back every setting it read: lib/cf/aiGateway.ts).
 */
export const AiGatewayOutput = z.looseObject({
  id: z.string(),
  collect_logs: z.boolean().nullish(),
  cache_ttl: z.number().nullish(),
  authentication: z.boolean().nullish(),
});
export type AiGateway = z.infer<typeof AiGatewayOutput>;
export const AiGatewayListOutput = z.array(AiGatewayOutput);
