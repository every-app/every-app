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

/** `cf d1 query`: one result per statement, rows as objects. */
export const D1QueryOutput = z.array(
  z.looseObject({
    results: z.array(z.record(z.string(), z.unknown())).nullish(),
    success: z.boolean().nullish(),
  }),
);

/** `cf d1 time-travel get-bookmark`. */
export const D1BookmarkOutput = z.looseObject({ bookmark: z.string() });

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

/** `cf d1 raw`: one result per statement, rows as arrays. */
export const D1RawOutput = z.array(
  z.looseObject({
    results: z
      .looseObject({
        columns: z.array(z.string()).nullish(),
        rows: z.array(z.array(z.unknown())).nullish(),
      })
      .nullish(),
  }),
);
