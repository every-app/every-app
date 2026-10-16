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

/** `cf workflows instances list`. */
export const WorkflowInstanceListOutput = z.array(
  z.looseObject({
    id: z.string(),
    status: z.string().nullish(),
    created_on: z.string().nullish(),
  }),
);

/** `cf workflows instances get`: status, params, steps, output and error. */
export const WorkflowInstanceOutput = z.looseObject({ status: z.string() });

/** `cf workflows instances create`. */
export const WorkflowInstanceCreatedOutput = z.looseObject({
  id: z.string(),
  status: z.string().nullish(),
});

/** `cf workflows instances pause|resume|terminate|restart`: the new status. */
export const WorkflowStatusOutput = z.looseObject({
  status: z.string().nullish(),
});

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
