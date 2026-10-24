/**
 * A Cloudflare account for end-to-end tests of the deploy plane, behind
 * FakeCf: D1 databases are real SQLite (queries and `migrations apply` run
 * against them), KV namespaces exist by title, `cf deploy --prebuilt` reads
 * the Build Output it would upload and validates it with @cloudflare/config,
 * and `cf build` builds an app's tenant-neutral Worker config with the SDK's
 * real everyAppWorker(), in the environment the build is given. Zones hold DNS records, a
 * deploy publishes its Worker's Custom Domains the way Cloudflare does (the
 * whole list, taken from other Workers, each with its own certificate pack
 * that outlives it, listing the zone apex, the hostname and its wildcard,
 * and its placeholder DNS record, `AAAA 100::`, which goes with the
 * domain) and creates or takes over the Workflows the Worker
 * defines. An account without a workers.dev subdomain (`workersDevSubdomain`)
 * stops a deploy once the version and its Custom Domains are live, as cf
 * did on a fresh account on 2026-10-24. Hyperdrive configs keep their origin, password apart, as the
 * API does (it never returns one). Each zone has Email Routing: its
 * settings, rules and catch-all (`emailRouting`), enabled on a domain by
 * adding Cloudflare's MX records there, with rules that may send mail only
 * to a Worker that exists. R2 buckets exist by name, each with a count of
 * objects (a bucket with any is refused on delete, as R2 does). `api.fetch` is the account's REST API, for the hosted
 * deployer: Workers for Platforms dispatch namespaces (`dispatchNamespaces`),
 * D1 and the account's Workers (fakeCloudflareApi.ts). Nothing is spawned
 * or sent.
 */
import fs from "node:fs";
import path from "node:path";
import { OutputWorkerSchema } from "@cloudflare/config";
import {
  everyAppAuxiliaryWorker,
  everyAppWorker,
} from "@every-app/sdk/cloudflare";
import { APP_BINDING_PREFIX } from "@every-app/perimeter/manifest";
import { FakeCf, type FakeCfResponse, type RecordedCfCall } from "@/lib/cf/fakeCf";
import { loadEveryAppManifest, type EveryAppCliManifest } from "@/lib/manifest";
import { createSqliteD1, sqliteD1Script, type SqliteD1 } from "./sqliteD1";
import { FakeCloudflareApi, type FakeDispatchNamespace } from "./fakeCloudflareApi";

export const ACCOUNT_ID = "0123456789abcdef0123456789abcd01";

interface DeployedWorker {
  versions: string[];
  /** The worker.config.json of the live version. */
  config: Record<string, any>;
  secrets: Record<string, string>;
}

interface RecordedDeploy {
  workerName: string;
  config: Record<string, any>;
  secrets: Record<string, string> | null;
  args: string[];
  mode: RecordedCfCall["mode"];
}

interface FakeZone {
  id: string;
  name: string;
  status: string;
}

interface FakeDnsRecord {
  zoneId: string;
  name: string;
  type: string;
  content: string;
  /** Given when first listed, so a delete finds the record. */
  id?: string;
}

interface FakeCertificatePack {
  id: string;
  zoneId: string;
  hosts: string[];
  /** "advanced" (a Custom Domain's) unless a test adds the zone's Universal SSL pack. */
  type?: string;
  /**
   * "active" unless a test puts the pack on its way out ("pending_deletion")
   * or stuck ("deletion_timed_out"); as cf does, the list shows only active
   * packs unless asked for `--status all`.
   */
  status?: string;
}

interface FakeWorkflow {
  scriptName: string;
  className: string;
  instances: Map<string, { status: string; params?: unknown }>;
}

interface FakeHyperdrive {
  name: string;
  origin: {
    scheme: string;
    host: string;
    port: number;
    database: string;
    user: string;
  };
  /** Kept apart: `list` never shows it, like Cloudflare's API. */
  password: string;
  /** As the API keeps it: absent until a body sets it (Cloudflare caches by default). */
  caching?: { disabled?: boolean };
}

/** A routing rule or a zone's catch-all, as Email Routing keeps it. */
interface FakeEmailRule {
  id: string;
  name: string;
  enabled: boolean;
  matchers: Array<{ type: string; field?: string; value?: string }>;
  actions: Array<{ type: string; value?: string[] }>;
}

/** A zone's Email Routing. */
interface FakeEmailRouting {
  enabled: boolean;
  rules: Map<string, FakeEmailRule>;
  catchAll: FakeEmailRule;
}

/** The account's Zero Trust organization, identity providers, reusable policies and Access applications. */
interface FakeZeroTrust {
  organization: Record<string, unknown> | null;
  identityProviders: Map<string, Record<string, unknown>>;
  policies: Map<string, Record<string, unknown>>;
  applications: Map<string, Record<string, unknown>>;
}

/**
 * What the Access API refuses in an organization PUT although GET returns
 * it (`access.api.error.invalid_org_config`, seen live on 2026-10-23).
 */
const ORGANIZATION_READ_ONLY = new Set([
  "is_ui_read_only",
  "login_design",
  "strict_service_token_auth",
  "service_token_inactivity",
  "disable_end_user_app_creation",
  "created_at",
  "updated_at",
]);

/** A Cloudflare API refusal, as cf 1.0.0-beta.14 prints it: the code, the message, the status and the path. */
function apiError(code: number, message: string, status: string, path: string): FakeCfResponse {
  return {
    exitCode: 1,
    stderr: `\n┌ APIError\n│ [${code}] ${message}\n│ ${status} · HTTP /accounts/${ACCOUNT_ID}/${path}\n└\n`,
  };
}

/** An Access API refusal. */
function accessApiError(code: number, message: string, status: string, path: string): FakeCfResponse {
  return apiError(code, message, status, `access/${path}`);
}

/** The MX records Email Routing adds (and locks) on a domain it routes. */
const EMAIL_ROUTING_MX = [
  "route1.mx.cloudflare.net",
  "route2.mx.cloudflare.net",
  "route3.mx.cloudflare.net",
];

/**
 * An app's cloudflare.config.ts as `cf build` evaluates it in production:
 * its Worker and its helper Workers (the Vite plugin's auxiliaryWorkers),
 * built with the SDK from the manifest and the app root.
 */
export type FakeAppConfig = (options: {
  manifest: EveryAppCliManifest;
  root: string;
}) => {
  worker: Record<string, any>;
  auxiliaryWorkers?: Record<string, any>[];
};

/** An app whose cloudflare.config.ts is everyAppWorker() and its helpers, as they are. */
const plainAppConfig: FakeAppConfig = ({ manifest, root }) => ({
  worker: everyAppWorker({
    manifest,
    entrypoint: "./src/entry.worker.ts",
    ctx: { mode: "production" },
    root,
  }),
  auxiliaryWorkers: (manifest.workers ?? []).map((helper) =>
    everyAppAuxiliaryWorker({
      manifest,
      worker: helper.name,
      entrypoint: `./src/${helper.name}.ts`,
      ctx: { mode: "production" },
      root,
    }),
  ),
});

/** What each `cf workflows instances <action>` makes of an instance. */
const INSTANCE_STATUS: Record<string, string> = {
  pause: "paused",
  resume: "running",
  terminate: "terminated",
  restart: "queued",
};

const WORKERS_OUTPUT = ".cloudflare/output/v0/workers";
const WORKER_CONFIG = `${WORKERS_OUTPUT}/default/worker.config.json`;

function cfError(message: string): FakeCfResponse {
  return { exitCode: 1, stderr: `┌ Error\n│ ${message}\n└\n` };
}

/**
 * cf 1.0.0-beta.14's strict-mode abort at the upload: on stdout, with no
 * box on stderr, and exit 1.
 */
const STRICT_ABORT: FakeCfResponse = {
  exitCode: 1,
  stdout:
    "Aborting the upload operation because of conflicts. To override and upload anyway, remove the `--strict` flag\n",
};

/** A missing Workflow, as cf 1.0.0-beta.14 prints the API's answer. */
function workflowNotFound(path: string): FakeCfResponse {
  return {
    exitCode: 1,
    stderr: `\n┌ APIError\n│ [10200] workflows.api.error.workflow.not_found\n│ 404 Not Found · HTTP /accounts/${ACCOUNT_ID}/workflows/${path}\n└\n`,
  };
}

/**
 * What cf answers (exit 1) when the version went live but its Custom
 * Domains didn't: at a terminal, a person declined to move one from another
 * Worker, and cf skips the whole list (cf 1.0.0-beta.14's own wording).
 */
export function customDomainsSkipped(
  workerName: string,
  domains: readonly string[],
): FakeCfResponse {
  const skipped =
    domains.length === 1
      ? `Publishing to Custom Domain "${domains[0]}" was skipped, fix conflict and try again`
      : `Publishing to ${domains.length} Custom Domains was skipped, fix conflicts and try again`;
  return {
    exitCode: 1,
    stderr: [
      "┌ Error",
      `│ Trigger configuration for "${workerName}" was only partially updated:`,
      "│",
      "│   Custom domains:",
      `│     - ${skipped}`,
      "│",
      "│ Successful trigger changes were not rolled back.",
      "└",
      "",
    ].join("\n"),
  };
}

/** The DNS record Cloudflare keeps at a Workers Custom Domain (listed as such, proxied). */
const PLACEHOLDER_RECORD = { type: "AAAA", content: "100::" } as const;

const isPlaceholderRecord = (record: FakeDnsRecord) =>
  record.type === PLACEHOLDER_RECORD.type && record.content === PLACEHOLDER_RECORD.content;

/** cf's refusal on an account that hasn't registered its workers.dev subdomain. */
function workersDevSubdomainMissing(): FakeCfResponse {
  return cfError(
    `You need a workers.dev subdomain before your first upload. Register one: https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`,
  );
}

/**
 * What cf does with a destructive command it can't confirm: without
 * `--force` and a terminal it declines, says so, and exits 0.
 */
function unconfirmed(call: RecordedCfCall, warning: string): FakeCfResponse | null {
  if (call.args.includes("--force")) return null;
  return {
    stderr: `? ${warning} Continue?\n  (non-interactive; pass --force to confirm)\nAborted.\n`,
  };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export class FakeCloudflare {
  readonly accountId = ACCOUNT_ID;
  readonly cf = new FakeCf();
  readonly databases = new Map<string, { name: string; db: SqliteD1 }>();
  readonly namespaces = new Map<string, { title: string }>();
  readonly workers = new Map<string, DeployedWorker>();
  /** Workflows by name: `cf deploy` creates or takes over a Worker's own. */
  readonly workflows = new Map<string, FakeWorkflow>();
  /** Hyperdrive configs by id. */
  readonly hyperdrive = new Map<string, FakeHyperdrive>();
  /** R2 buckets by name, each with how many objects it holds. */
  readonly buckets = new Map<string, { objects: number }>();
  readonly deploys: RecordedDeploy[] = [];
  /** `cf d1 time-travel restore`s, in order (the data isn't rewound). */
  readonly restores: Array<{ databaseId: string; bookmark: string }> = [];
  /** Apps `cf build` can build, by app root. */
  readonly apps = new Map<string, EveryAppCliManifest>();
  /**
   * An app's own cloudflare.config.ts (and Vite plugin's auxiliaryWorkers),
   * by app root, for `cf build` to run instead of the plain everyAppWorker()
   * build: what a port with extra bindings, crons or secrets builds.
   */
  readonly appConfigs = new Map<string, FakeAppConfig>();
  /** The next `cf deploy` fails with this stderr box message. */
  failNextDeploy: string | null = null;
  /**
   * The next `cf deploy` aborts in strict mode, as cf does unattended for a
   * Worker last changed in the dashboard or through the API.
   */
  strictAbortNextDeploy = false;
  /** The next `cf deploy` uploads nothing and exits 0, as when a person declines its prompt. */
  declineNextDeploy = false;
  /** Changes what `cf build` writes, as an app's own cloudflare.config.ts could. */
  editBuild: ((config: Record<string, any>) => void) | null = null;
  /**
   * Runs once a `cf deploy` has its version live, before cf publishes the
   * Worker's Custom Domains: what it returns is cf's answer instead, and
   * the domains stay as they were (cf stopped, or skipped them all:
   * customDomainsSkipped).
   */
  afterUpload: ((workerName: string) => FakeCfResponse | undefined) | null = null;
  readonly zones: FakeZone[] = [
    { id: "zone-1", name: "example.com", status: "active" },
  ];
  /** The zones' records: the operator's, and each Custom Domain's own placeholder (`AAAA 100::`). */
  readonly dnsRecords: FakeDnsRecord[] = [];
  /**
   * Whether the account has registered its workers.dev subdomain. Without
   * one, cf's deploy puts the version live and publishes its Custom
   * Domains, then stops asking for the subdomain (seen live 2026-10-24).
   */
  workersDevSubdomain = true;
  /** Email Routing, by zone id; a zone's starts off, its catch-all dropping mail. */
  readonly emailRouting = new Map<string, FakeEmailRouting>();
  /**
   * The account never opened Zero Trust: every Access call answers
   * `[9999] access.api.error.not_enabled` 403, as a fresh account did live
   * on 2026-10-24 (whatever `zeroTrust` holds).
   */
  accessNotEnabled = false;
  /** The account never enabled R2: every bucket call answers `[10042] Please enable R2 ...` 403 (seen live the same day). */
  r2NotEnabled = false;
  /** Zero Trust: no organization until one is created (or a test sets one). */
  readonly zeroTrust: FakeZeroTrust = {
    organization: null,
    identityProviders: new Map(),
    policies: new Map(),
    applications: new Map(),
  };
  /** Hostname → the Worker it is a Custom Domain of. */
  readonly customDomains = new Map<string, string>();
  readonly certificatePacks: FakeCertificatePack[] = [];
  /** Workers for Platforms dispatch namespaces, by name, with their scripts. */
  readonly dispatchNamespaces = new Map<string, FakeDispatchNamespace>();
  /** The REST API over this account; `api.fetch` is what a client calls. */
  readonly api = new FakeCloudflareApi({
    accountId: ACCOUNT_ID,
    databases: this.databases,
    workers: this.workers,
    dispatchNamespaces: this.dispatchNamespaces,
    createDatabase: (name) => this.createDatabase(name),
    nextId: () => (this.counter += 1),
  });
  private counter = 0;
  /** When each Worker's live version went out (`workers deployments list`'s created_on). */
  readonly deployedAt = new Map<string, string>();

  /** A clock that only moves forward, one second per tick, from mid-October 2026. */
  clock(): string {
    return new Date(1_792_000_000_000 + (this.counter += 1) * 1000).toISOString();
  }

  constructor() {
    const d1 = sqliteD1Script({});
    this.cf
      .on(["auth", "whoami"], {
        stdout: JSON.stringify({
          authenticated: true,
          email: "dev@example.com",
          accounts: [{ id: ACCOUNT_ID, name: "Acme" }],
        }),
      })
      .on(["zones", "list"], (call) => {
        const name = flag(call.args, "--name");
        const page = Number(flag(call.args, "--page") ?? "1");
        return {
          stdout: JSON.stringify(
            name !== undefined
              ? this.zones.filter((zone) => zone.name === name)
              : page === 1
                ? this.zones
                : [],
          ),
        };
      })
      .on(["dns", "records", "list"], (call) => ({
        stdout: JSON.stringify(
          this.dnsRecords
            .filter(
              (record) =>
                record.zoneId === flag(call.args, "-z") &&
                record.name === flag(call.args, "--name-exact"),
            )
            .map((record) => ({ ...record, id: (record.id ??= `record-${(this.counter += 1)}`) })),
        ),
      }))
      .on(["dns", "records", "delete"], (call) => {
        const declined = unconfirmed(call, "This permanently deletes the DNS record.");
        if (declined) return declined;
        const index = this.dnsRecords.findIndex(
          (record) => record.id === call.args[3] && record.zoneId === flag(call.args, "-z"),
        );
        if (index < 0) return cfError("Record does not exist. [code: 81044]");
        this.dnsRecords.splice(index, 1);
        return { stdout: JSON.stringify({ id: call.args[3] }) };
      })
      .on(["ssl", "certificate-packs", "list"], (call) => ({
        stdout: JSON.stringify(
          flag(call.args, "--page") === "1"
            ? this.certificatePacks
                .filter((pack) => pack.zoneId === flag(call.args, "-z"))
                .map(({ id, hosts, type, status }) => ({ id, type: type ?? "advanced", hosts, status: status ?? "active" }))
                .filter((pack) => pack.status === "active" || flag(call.args, "--status") === "all")
            : [],
        ),
      }))
      .on(["ssl", "certificate-packs", "delete"], (call) => {
        const declined = unconfirmed(call, "This permanently deletes the resource.");
        if (declined) return declined;
        const index = this.certificatePacks.findIndex(
          (pack) => pack.id === call.args[3],
        );
        if (index < 0) return cfError("Certificate pack not found [code: 1400]");
        this.certificatePacks.splice(index, 1);
        return { stdout: "{}" };
      })
      .on(["d1", "list"], (call) => ({
        stdout: JSON.stringify(
          [...this.databases]
            .filter(([, entry]) =>
              entry.name.includes(flag(call.args, "--name") ?? ""),
            )
            .map(([uuid, entry]) => ({ uuid, name: entry.name })),
        ),
      }))
      .on(["d1", "create"], (call) => {
        const name = flag(call.args, "--name")!;
        const uuid = this.createDatabase(name).uuid;
        return { stdout: JSON.stringify({ uuid, name }) };
      })
      .on(["d1", "delete"], (call) => {
        const declined = unconfirmed(call, "This permanently deletes the D1 database and all of its data.");
        if (declined) return declined;
        this.databases.delete(call.args[2]!);
        return { stdout: "{}" };
      })
      .on(["d1", "time-travel", "get-bookmark"], () => ({
        stdout: JSON.stringify({ bookmark: `bookmark-${(this.counter += 1)}` }),
      }))
      .on(["d1", "time-travel", "restore"], (call) => {
        const declined = unconfirmed(call, "This reverts the D1 database to a previous point in time.");
        if (declined) return declined;
        this.restores.push({ databaseId: call.args[3]!, bookmark: flag(call.args, "--bookmark")! });
        return { stdout: JSON.stringify({ previous_bookmark: `bookmark-${(this.counter += 1)}` }) };
      })
      .on(["d1"], (call) => {
        const id = call.args[1] === "query" ? call.args[2] : call.args[3];
        const entry = this.databases.get(id ?? "");
        return entry
          ? sqliteD1Script({ [id!]: entry.db })(call)
          : d1(call);
      })
      .on(["kv", "namespaces", "list"], (call) => ({
        stdout: JSON.stringify(
          flag(call.args, "--page") === "1"
            ? [...this.namespaces].map(([id, ns]) => ({ id, title: ns.title }))
            : [],
        ),
      }))
      .on(["kv", "namespaces", "create"], (call) => {
        const title = flag(call.args, "--title")!;
        const id = this.createNamespace(title);
        return { stdout: JSON.stringify({ id, title }) };
      })
      .on(["kv", "namespaces", "delete"], (call) => {
        const declined = unconfirmed(call, "This operation deletes the selected Workers KV namespace and all of its key-value pairs.");
        if (declined) return declined;
        this.namespaces.delete(call.args[3]!);
        return { stdout: "{}" };
      })
      // As `/workers/workers` lists them: each with what references it, its Custom Domains among them.
      .on(["workers", "list"], (call) => ({
        stdout: JSON.stringify(
          flag(call.args, "--page") === "1"
            ? [...this.workers.keys()].map((name) => ({
                id: `worker-${name}`,
                name,
                tags: [],
                created_on: "2026-10-12T00:00:00Z",
                references: {
                  workers: this.workersBinding(name).map((worker) => ({ id: `worker-${worker}`, name: worker })),
                  domains: [...this.customDomains]
                    .filter(([, worker]) => worker === name)
                    .map(([hostname]) => {
                      const zone = this.zoneOf(hostname);
                      return {
                        id: `domain-${hostname}`,
                        hostname,
                        zone_id: zone?.id ?? null,
                        zone_name: zone?.name ?? null,
                      };
                    }),
                },
              }))
            : [],
        ),
      }))
      .on(["workers", "deployments", "list"], (call) => {
        const worker = this.workers.get(flag(call.args, "--worker")!);
        if (!worker) {
          return cfError("This Worker does not exist on your account. [code: 10007]");
        }
        return {
          stdout: JSON.stringify({
            deployments: [
              {
                id: "deployment",
                created_on: this.deployedAt.get(flag(call.args, "--worker")!) ?? "2026-10-12T00:00:00Z",
                versions: [{ version_id: worker.versions.at(-1), percentage: 100 }],
              },
            ],
          }),
        };
      })
      .on(["workers", "secrets", "list"], (call) => {
        const worker = this.workers.get(flag(call.args, "--worker")!);
        if (!worker) {
          return cfError("This Worker does not exist on your account. [code: 10007]");
        }
        return {
          stdout: JSON.stringify(
            Object.keys(worker.secrets).map((name) => ({ name, type: "secret_text" })),
          ),
        };
      })
      // Like the API: one new version of the live one with every change.
      .on(["workers", "secrets", "bulk"], (call) => {
        const workerName = flag(call.args, "--worker")!;
        const worker = this.workers.get(workerName);
        if (!worker) {
          return cfError("This Worker does not exist on your account. [code: 10007]");
        }
        // Like the API: the patch is read as JSON only from `--body @<file>`
        // (`--file` uploads an octet stream), under `secrets`, each entry
        // naming itself; anything else is a patch of nothing.
        const body = flag(call.args, "--body") ?? "";
        const patch = body.startsWith("@")
          ? (JSON.parse(call.files[path.basename(body.slice(1))]!) as {
              secrets?: Record<string, { name: string; type: string; text: string } | null>;
            })
          : {};
        const secrets = { ...worker.secrets };
        for (const [name, change] of Object.entries(patch.secrets ?? {})) {
          if (change === null) delete secrets[name];
          else if (change.name === name && change.type === "secret_text") {
            secrets[name] = change.text;
          }
        }
        this.workers.set(workerName, {
          ...worker,
          versions: [...worker.versions, `${workerName}-api-${(this.counter += 1)}`],
          secrets,
        });
        this.deployedAt.set(workerName, this.clock());
        return { stdout: "{}" };
      })
      // Like the API: a new version of the live one, without the secret.
      .on(["workers", "secrets", "delete"], (call) => {
        const declined = unconfirmed(call, "This will permanently delete the Worker script secret.");
        if (declined) return declined;
        const workerName = flag(call.args, "--worker")!;
        const worker = this.workers.get(workerName);
        if (!worker) {
          return cfError("This Worker does not exist on your account. [code: 10007]");
        }
        const name = call.args[3]!;
        if (!(name in worker.secrets)) {
          return cfError(`Secret ${name} not found. [code: 10056]`);
        }
        const { [name]: _deleted, ...secrets } = worker.secrets;
        this.workers.set(workerName, {
          ...worker,
          versions: [...worker.versions, `${workerName}-api-${(this.counter += 1)}`],
          secrets,
        });
        this.deployedAt.set(workerName, this.clock());
        return { stdout: "{}" };
      })
      .on(["workers", "delete"], (call) => {
        const declined = unconfirmed(call, "This will permanently delete the Worker and its associated versions and deployments.");
        if (declined) return declined;
        const name = call.args[2]!;
        if (!this.workers.has(name)) {
          return cfError("This Worker does not exist on your account. [code: 10007]");
        }
        // As the API: a Worker another Worker binds (a service binding or
        // one of its Durable Objects) stays unless `--delete-with-references`.
        const referencedBy = this.workersBinding(name);
        if (referencedBy.length > 0 && !call.args.includes("--delete-with-references")) {
          return cfError(
            `Worker "${name}" is referenced by ${referencedBy.map((worker) => `"${worker}"`).join(", ")}; pass --delete-with-references to delete it anyway. [code: 10118]`,
          );
        }
        this.workers.delete(name);
        // Its Custom Domains go with it, and their records (their certificate packs stay).
        for (const [host, worker] of [...this.customDomains]) {
          if (worker === name) this.dropCustomDomain(host);
        }
        return { stdout: "{}" };
      })
      .on(["workflows", "get"], (call) => {
        const workflow = this.workflows.get(call.args[2]!);
        if (!workflow) return workflowNotFound(call.args[2]!);
        const instances: Record<string, number> = {};
        for (const instance of workflow.instances.values()) {
          instances[instance.status] = (instances[instance.status] ?? 0) + 1;
        }
        return {
          stdout: JSON.stringify({
            name: call.args[2],
            class_name: workflow.className,
            script_name: workflow.scriptName,
            instances,
          }),
        };
      })
      .on(["workflows", "list"], (call) => ({
        stdout: JSON.stringify(
          flag(call.args, "--page") === "1"
            ? [...this.workflows]
                .filter(([name]) => name.includes(flag(call.args, "--search") ?? ""))
                .map(([name, workflow]) => ({
                  name,
                  class_name: workflow.className,
                  script_name: workflow.scriptName,
                }))
            : [],
        ),
      }))
      .on(["workflows", "delete"], (call) => {
        const declined = unconfirmed(call, "This operation permanently deletes the Workflow.");
        if (declined) return declined;
        if (!this.workflows.delete(call.args[2]!)) {
          return workflowNotFound(call.args[2]!);
        }
        return { stdout: JSON.stringify({ status: "ok", success: true }) };
      })
      .on(["workflows", "instances"], (call) => this.workflowInstances(call))
      .on(["hyperdrive"], (call) => this.hyperdriveCommand(call))
      .on(["r2", "buckets"], (call) => this.r2Command(call))
      .on(["email-routing"], (call) => this.emailRoutingCommand(call))
      .on(["zero-trust"], (call) => this.zeroTrustCommand(call))
      .on(["build"], (call) => this.build(call))
      .on(["deploy"], (call) => this.deploy(call));
  }

  createDatabase(name: string): { uuid: string; db: SqliteD1 } {
    const uuid = `${(this.counter += 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    const db = createSqliteD1();
    this.databases.set(uuid, { name, db });
    return { uuid, db };
  }

  createNamespace(title: string): string {
    const id = (this.counter += 1).toString(16).padStart(32, "0");
    this.namespaces.set(id, { title });
    return id;
  }

  database(name: string): SqliteD1 {
    const entry = [...this.databases.values()].find((db) => db.name === name);
    if (!entry) throw new Error(`no database ${name}`);
    return entry.db;
  }

  namespaceId(title: string): string | undefined {
    return [...this.namespaces].find(([, ns]) => ns.title === title)?.[0];
  }

  /** The release the live gateway version runs (its EVERYAPP_RELEASE). */
  gatewayRelease(): { version: string; sha256: string } | null {
    return (
      this.workers.get("every-app-gateway")?.config["env"]?.EVERYAPP_RELEASE?.value ??
      null
    );
  }

  /** The hostnames the gateway Worker is published under. */
  gatewayDomains(): string[] {
    return [...this.customDomains]
      .filter(([, worker]) => worker === "every-app-gateway")
      .map(([host]) => host)
      .sort();
  }

  /** The app Workers the live gateway binds. */
  gatewayBindings(): string[] {
    const env = this.workers.get("every-app-gateway")?.config["env"] ?? {};
    return Object.keys(env)
      .filter((name) => name.startsWith(APP_BINDING_PREFIX))
      .map((name) => name.slice(APP_BINDING_PREFIX.length))
      .sort();
  }

  /** A Hyperdrive config, by name. */
  hyperdriveConfig(name: string): (FakeHyperdrive & { id: string }) | undefined {
    const entry = [...this.hyperdrive].find(([, config]) => config.name === name);
    return entry ? { id: entry[0], ...entry[1] } : undefined;
  }

  /** A zone's Email Routing, as the API has it before anyone changes it. */
  emailRoutingOf(zoneId: string): FakeEmailRouting {
    let routing = this.emailRouting.get(zoneId);
    if (!routing) {
      routing = {
        enabled: false,
        rules: new Map(),
        catchAll: {
          id: `catch-all-${zoneId}`,
          name: "",
          enabled: true,
          matchers: [{ type: "all" }],
          actions: [{ type: "drop" }],
        },
      };
      this.emailRouting.set(zoneId, routing);
    }
    return routing;
  }

  /** The rules in a zone that take `address`, in the order they were made. */
  emailRulesFor(zoneId: string, address: string): FakeEmailRule[] {
    return [...this.emailRoutingOf(zoneId).rules.values()].filter((rule) =>
      rule.matchers.some((matcher) => matcher.value === address),
    );
  }

  /**
   * `cf email-routing settings get|enable` and `rules
   * create|get|update|delete|list-account|catch-all get|update`, zone by
   * zone (`-z <zone id>`). Enabling a domain adds Email Routing's MX
   * records there (the apex turns the zone's routing on); a rule's Worker
   * must exist, and two rules can't take one address.
   */
  /**
   * Cloudflare Access as the API behaves: one organization per account (a
   * GET without one is a 404), identity providers, reusable policies, and
   * applications validated as Cloudflare validates them (policies and
   * providers must exist; a destination takes at most 25 overrides, each a
   * path with at most one `*` per segment), each with an AUD tag.
   */
  private zeroTrustCommand(call: RecordedCfCall): FakeCfResponse {
    const [, group, second, third, fourth] = call.args;
    if (this.accessNotEnabled) {
      const path = group === "organization" ? "organizations" : group === "identity-providers" ? "identity_providers" : (second ?? "apps");
      return accessApiError(9999, "access.api.error.not_enabled", "403 Forbidden", path);
    }
    const zt = this.zeroTrust;
    const body = (): Record<string, any> | null => {
      const file = flag(call.args, "--body") ?? "";
      if (!file.startsWith("@")) return null;
      return JSON.parse(call.files[path.basename(file.slice(1))]!);
    };
    const page = () => Number(flag(call.args, "--page") ?? "1");
    const list = (items: unknown[]) => ({ stdout: JSON.stringify(page() === 1 ? items : []) });
    const now = () => this.clock();

    if (group === "organization") {
      if (second === "get") {
        return zt.organization
          ? { stdout: JSON.stringify(zt.organization) }
          : accessApiError(12130, "access.api.error.not_found", "404 Not Found", "organizations");
      }
      if (second === "create") {
        if (zt.organization) {
          return accessApiError(12001, "access.api.error.organization_exists", "409 Conflict", "organizations");
        }
        const given = body() ?? {
          name: flag(call.args, "--name"),
          auth_domain: flag(call.args, "--auth-domain"),
          ...(flag(call.args, "--session-duration") ? { session_duration: flag(call.args, "--session-duration") } : {}),
        };
        if (typeof given["auth_domain"] !== "string") {
          return accessApiError(12062, "access.api.error.invalid_org_config", "400 Bad Request", "organizations");
        }
        zt.organization = {
          name: given["name"] ?? given["auth_domain"],
          allow_authenticate_via_warp: false,
          deny_unmatched_requests: false,
          deny_unmatched_requests_exempted_zone_names: [],
          warp_auth_non_browser_401: false,
          is_ui_read_only: false,
          login_design: {},
          strict_service_token_auth: true,
          created_at: now(),
          ...given,
          updated_at: now(),
        };
        return { stdout: JSON.stringify(zt.organization) };
      }
      if (second === "update") {
        if (!zt.organization) {
          return accessApiError(12130, "access.api.error.not_found", "404 Not Found", "organizations");
        }
        const given = body() ?? {};
        if (Object.keys(given).some((key) => ORGANIZATION_READ_ONLY.has(key))) {
          return accessApiError(12062, "access.api.error.invalid_org_config", "400 Bad Request", "organizations");
        }
        zt.organization = { ...zt.organization, ...given, updated_at: now() };
        return { stdout: JSON.stringify(zt.organization) };
      }
    }

    if (group === "identity-providers") {
      if (second === "list") return list([...zt.identityProviders.values()]);
      if (second === "create") {
        const given = body() ?? {};
        const id = `idp-${(this.counter += 1)}`;
        const provider = { id, uid: id, config: {}, ...given };
        zt.identityProviders.set(id, provider);
        return { stdout: JSON.stringify(provider) };
      }
    }

    if (group === "access" && second === "policies") {
      if (third === "list") {
        return list(
          [...zt.policies.values()].map((policy) => ({
            ...policy,
            app_count: [...zt.applications.values()].filter((application) =>
              (application["policies"] as string[]).includes(policy["id"] as string),
            ).length,
          })),
        );
      }
      if (third === "create") {
        const given = body() ?? {};
        const id = `policy-${(this.counter += 1)}`;
        const policy = { id, uid: id, exclude: [], require: [], reusable: true, created_at: now(), ...given, updated_at: now() };
        zt.policies.set(id, policy);
        return { stdout: JSON.stringify(policy) };
      }
      if (third === "update") {
        const policy = zt.policies.get(fourth ?? "");
        if (!policy) return accessApiError(12130, "access.api.error.not_found", "404 Not Found", `policies/${fourth}`);
        // PUT replaces the policy: what the body leaves out is gone, as at Cloudflare.
        const updated = {
          id: policy["id"],
          uid: policy["uid"],
          created_at: policy["created_at"],
          reusable: policy["reusable"],
          ...(body() ?? {}),
          updated_at: now(),
        };
        zt.policies.set(policy["id"] as string, updated);
        return { stdout: JSON.stringify(updated) };
      }
      if (third === "delete") {
        const declined = unconfirmed(call, "This permanently deletes the Access policy.");
        if (declined) return declined;
        const policy = zt.policies.get(fourth ?? "");
        if (!policy) return accessApiError(12130, "access.api.error.not_found", "404 Not Found", `policies/${fourth}`);
        // Like the API: a reusable policy an application still uses can't go.
        const users = [...zt.applications.values()].filter((application) =>
          (application["policies"] as string[]).includes(policy["id"] as string),
        );
        if (users.length > 0) {
          return accessApiError(12060, "access.api.error.policy_in_use", "400 Bad Request", `policies/${fourth}`);
        }
        zt.policies.delete(policy["id"] as string);
        return { stdout: JSON.stringify({ id: fourth }) };
      }
    }

    if (group === "access" && second === "applications") {
      const expand = (application: Record<string, unknown>) => ({
        ...application,
        policies: (application["policies"] as string[]).map((id, index) => ({
          ...zt.policies.get(id),
          precedence: index + 1,
        })),
      });
      const invalid = (given: Record<string, any>): FakeCfResponse | null => {
        for (const id of (given["policies"] ?? []) as string[]) {
          if (!zt.policies.has(id)) {
            return accessApiError(12130, `access.api.error.policy_not_found: ${id}`, "404 Not Found", "apps");
          }
        }
        for (const id of (given["allowed_idps"] ?? []) as string[]) {
          if (!zt.identityProviders.has(id)) {
            return accessApiError(12130, `access.api.error.idp_not_found: ${id}`, "404 Not Found", "apps");
          }
        }
        for (const destination of (given["destinations"] ?? []) as Array<Record<string, any>>) {
          const overrides = (destination["overrides"] ?? []) as Array<Record<string, string>>;
          if (overrides.length > 25) {
            return accessApiError(12060, "access.api.error.invalid_request: a destination takes at most 25 overrides", "400 Bad Request", "apps");
          }
          for (const override of overrides) {
            const pattern = override["path_pattern"] ?? "";
            const oneWildcardPerSegment = pattern
              .split("/")
              .every((segment) => (segment.match(/\*/g) ?? []).length <= 1);
            if (!pattern.startsWith("/") || pattern.length > 512 || !oneWildcardPerSegment || override["behavior"] !== "public") {
              return accessApiError(12060, `access.api.error.invalid_request: invalid override ${pattern}`, "400 Bad Request", "apps");
            }
          }
        }
        return null;
      };
      if (third === "list") return list([...zt.applications.values()].map(expand));
      if (third === "get") {
        const application = zt.applications.get(fourth ?? "");
        return application
          ? { stdout: JSON.stringify(expand(application)) }
          : accessApiError(12130, "access.api.error.not_found", "404 Not Found", `apps/${fourth}`);
      }
      if (third === "create") {
        const given = body() ?? {};
        const refused = invalid(given);
        if (refused) return refused;
        const id = `app-${(this.counter += 1)}`;
        const application = {
          id,
          uid: id,
          aud: (this.counter += 1).toString(16).padStart(64, "a"),
          app_launcher_visible: true,
          allowed_idps: [],
          auto_redirect_to_identity: false,
          session_duration: "24h",
          enable_binding_cookie: false,
          http_only_cookie_attribute: true,
          options_preflight_bypass: false,
          eager_redirect_cookie_setting: true,
          tags: [],
          policies: [],
          created_at: now(),
          ...given,
          updated_at: now(),
        };
        zt.applications.set(id, application);
        return { stdout: JSON.stringify(expand(application)) };
      }
      if (third === "update") {
        const application = zt.applications.get(fourth ?? "");
        if (!application) return accessApiError(12130, "access.api.error.not_found", "404 Not Found", `apps/${fourth}`);
        const given = body() ?? {};
        const refused = invalid(given);
        if (refused) return refused;
        // Like the API: PUT replaces the application; its identity stays.
        const updated = {
          ...given,
          id: application["id"],
          uid: application["uid"],
          aud: application["aud"],
          created_at: application["created_at"],
          updated_at: now(),
        };
        zt.applications.set(application["id"] as string, updated);
        return { stdout: JSON.stringify(expand(updated)) };
      }
      if (third === "delete") {
        const declined = unconfirmed(call, "This permanently deletes the Access application.");
        if (declined) return declined;
        if (!zt.applications.delete(fourth ?? "")) {
          return accessApiError(12130, "access.api.error.not_found", "404 Not Found", `apps/${fourth}`);
        }
        return { stdout: JSON.stringify({ id: fourth }) };
      }
    }
    return cfError(`Unknown zero-trust command: ${call.args.slice(1).join(" ")}`);
  }

  private emailRoutingCommand(call: RecordedCfCall): FakeCfResponse {
    const zoneId = flag(call.args, "-z");
    const zone = this.zones.find((candidate) => candidate.id === zoneId);
    if (!zone) return cfError(`Could not route to /zones/${zoneId}, perhaps your object identifier is invalid? [code: 7003]`);
    const routing = this.emailRoutingOf(zone.id);
    const settings = () => ({
      id: `settings-${zone.id}`,
      name: zone.name,
      enabled: routing.enabled,
      status: routing.enabled ? "ready" : "unconfigured",
    });
    const body = (): Omit<FakeEmailRule, "id"> | null => {
      const file = flag(call.args, "--body") ?? "";
      if (!file.startsWith("@")) return null;
      return JSON.parse(call.files[path.basename(file.slice(1))]!);
    };
    const checkWorker = (rule: Omit<FakeEmailRule, "id">): FakeCfResponse | null => {
      for (const action of rule.actions) {
        const worker = action.type === "worker" ? action.value?.[0] : undefined;
        if (worker !== undefined && !this.workers.has(worker)) {
          return cfError(`Worker ${worker} does not exist on this account [code: 2020]`);
        }
      }
      return null;
    };
    const [, group, action] = call.args;
    if (group === "settings" && action === "get") {
      return { stdout: JSON.stringify(settings()) };
    }
    if (group === "enable") {
      const domain = flag(call.args, "--name") ?? zone.name;
      if (domain !== zone.name && !domain.endsWith(`.${zone.name}`)) {
        return cfError(`${domain} is not in the zone ${zone.name} [code: 2007]`);
      }
      if (domain === zone.name) routing.enabled = true;
      for (const content of EMAIL_ROUTING_MX) {
        if (
          !this.dnsRecords.some(
            (record) =>
              record.zoneId === zone.id &&
              record.name === domain &&
              record.type === "MX" &&
              record.content === content,
          )
        ) {
          this.dnsRecords.push({ zoneId: zone.id, name: domain, type: "MX", content });
        }
      }
      return { stdout: JSON.stringify(settings()) };
    }
    if (group === "disable") {
      const declined = unconfirmed(call, "This disables Email Routing for the zone.");
      if (declined) return declined;
      routing.enabled = false;
      // Cloudflare removes the MX records it added for the apex.
      for (let index = this.dnsRecords.length - 1; index >= 0; index -= 1) {
        const record = this.dnsRecords[index]!;
        if (
          record.zoneId === zone.id &&
          record.name === zone.name &&
          record.type === "MX" &&
          EMAIL_ROUTING_MX.includes(record.content)
        ) {
          this.dnsRecords.splice(index, 1);
        }
      }
      return { stdout: JSON.stringify(settings()) };
    }
    if (group !== "rules") return cfError(`unknown command email-routing ${group}`);
    if (action === "catch-all") {
      if (call.args[3] === "get") return { stdout: JSON.stringify(routing.catchAll) };
      const request = body();
      if (!request) return cfError("A body is required");
      const refused = checkWorker(request);
      if (refused) return refused;
      routing.catchAll = { ...routing.catchAll, ...request };
      return { stdout: JSON.stringify(routing.catchAll) };
    }
    if (action === "list-account") {
      const perPage = Number(flag(call.args, "--per-page") ?? "20");
      const page = Number(flag(call.args, "--page") ?? "1");
      return {
        stdout: JSON.stringify(
          [...routing.rules.values()].slice((page - 1) * perPage, page * perPage),
        ),
      };
    }
    if (action === "create") {
      const request = body();
      if (!request) return cfError("A body is required");
      const refused = checkWorker(request);
      if (refused) return refused;
      const address = request.matchers.find((matcher) => matcher.value)?.value;
      if (address && this.emailRulesFor(zone.id, address).length > 0) {
        return cfError(`A rule for ${address} already exists [code: 2032]`);
      }
      const id = (this.counter += 1).toString(16).padStart(32, "0");
      const rule = { id, ...request };
      routing.rules.set(id, rule);
      return { stdout: JSON.stringify(rule) };
    }
    const id = call.args[3]!;
    const rule = routing.rules.get(id);
    if (!rule) return cfError(`Rule not found [code: 2020]`);
    if (action === "get") return { stdout: JSON.stringify(rule) };
    if (action === "update") {
      const request = body();
      if (!request) return cfError("A body is required");
      const refused = checkWorker(request);
      if (refused) return refused;
      routing.rules.set(id, { ...request, id });
      return { stdout: JSON.stringify(routing.rules.get(id)) };
    }
    if (action === "delete") {
      const declined = unconfirmed(call, "This operation permanently deletes an Email Routing rule.");
      if (declined) return declined;
      routing.rules.delete(id);
      return { stdout: JSON.stringify(rule) };
    }
    return cfError(`unknown command email-routing rules ${action}`);
  }

  /** The other Workers whose live config binds `name` (a service binding or a Durable Object of its). */
  private workersBinding(name: string): string[] {
    return [...this.workers]
      .filter(
        ([other, worker]) =>
          other !== name &&
          Object.values(worker.config["env"] ?? {}).some(
            (binding: any) => ["worker", "durable-object"].includes(binding?.type) && binding.worker === name,
          ),
      )
      .map(([other]) => other)
      .sort();
  }

  /** The zone that holds `host`, the longest match, as Cloudflare resolves a Custom Domain. */
  private zoneOf(host: string): FakeZone | undefined {
    return [...this.zones]
      .sort((a, b) => b.name.length - a.name.length)
      .find((candidate) => host === candidate.name || host.endsWith(`.${candidate.name}`));
  }

  /**
   * `cf r2 buckets list|delete`, as cf 1.0.0-beta.14 prints them: a list is
   * `{ buckets: [{ name, creation_date }] }` (filtered by `--name-contains`),
   * and a delete refuses a bucket with objects in it.
   */
  private r2Command(call: RecordedCfCall): FakeCfResponse {
    const action = call.args[2];
    if (this.r2NotEnabled) {
      return apiError(10042, "Please enable R2 through the Cloudflare Dashboard.", "403 Forbidden", "r2/buckets");
    }
    if (action === "list") {
      const contains = flag(call.args, "--name-contains") ?? "";
      return {
        stdout: JSON.stringify({
          buckets: [...this.buckets.keys()]
            .filter((name) => name.includes(contains))
            .sort()
            .map((name) => ({ name, creation_date: "2026-10-12T00:00:00.000Z" })),
        }),
      };
    }
    if (action === "delete") {
      const declined = unconfirmed(call, "This permanently deletes the R2 bucket.");
      if (declined) return declined;
      const name = call.args[3]!;
      const bucket = this.buckets.get(name);
      if (!bucket) return cfError("The specified bucket does not exist. [code: 10006]");
      if (bucket.objects > 0) {
        return cfError("The bucket you tried to delete is not empty. [code: 10008]");
      }
      this.buckets.delete(name);
      return { stdout: "{}" };
    }
    return cfError(`unknown command r2 buckets ${action}`);
  }

  /**
   * `cf hyperdrive list|create|update|delete`: a create or update reads its
   * body from the `--body @<file>` cf is handed, which holds the password.
   */
  private hyperdriveCommand(call: RecordedCfCall): FakeCfResponse {
    const listed = (id: string, config: FakeHyperdrive) => ({
      id,
      name: config.name,
      origin: config.origin,
      caching: { disabled: config.caching?.disabled ?? false },
    });
    const body = () => {
      const file = flag(call.args, "--body") ?? "";
      if (!file.startsWith("@")) return null;
      return JSON.parse(call.files[path.basename(file.slice(1))]!) as {
        name?: string;
        origin?: FakeHyperdrive["origin"] & { password: string };
        caching?: FakeHyperdrive["caching"];
      };
    };
    const action = call.args[1];
    if (action === "list") {
      const perPage = Number(flag(call.args, "--per-page") ?? "20");
      const page = Number(flag(call.args, "--page") ?? "1");
      return {
        stdout: JSON.stringify(
          [...this.hyperdrive]
            .slice((page - 1) * perPage, page * perPage)
            .map(([id, config]) => listed(id, config)),
        ),
      };
    }
    if (action === "create") {
      const request = body();
      if (!request?.name || !request.origin) return cfError("A body is required");
      if (this.hyperdriveConfig(request.name)) {
        return cfError(`A Hyperdrive config named ${request.name} already exists [code: 2017]`);
      }
      const { password, ...origin } = request.origin;
      const id = (this.counter += 1).toString(16).padStart(32, "0");
      this.hyperdrive.set(id, {
        name: request.name,
        origin,
        password,
        ...(request.caching ? { caching: request.caching } : {}),
      });
      return { stdout: JSON.stringify(listed(id, this.hyperdrive.get(id)!)) };
    }
    const id = call.args[2]!;
    const config = this.hyperdrive.get(id);
    if (!config) return cfError(`Hyperdrive config ${id} not found [code: 2005]`);
    // A PATCH: what the body leaves out stays as it was.
    if (action === "update") {
      const request = body();
      const { password, ...origin } = request?.origin ?? {
        ...config.origin,
        password: config.password,
      };
      this.hyperdrive.set(id, {
        ...config,
        origin,
        password,
        ...(request?.caching ? { caching: request.caching } : {}),
      });
      return { stdout: JSON.stringify(listed(id, this.hyperdrive.get(id)!)) };
    }
    if (action === "delete") {
      const declined = unconfirmed(call, "This permanently deletes the Hyperdrive config.");
      if (declined) return declined;
      this.hyperdrive.delete(id);
      return { stdout: "{}" };
    }
    return cfError(`unknown command hyperdrive ${action}`);
  }

  /**
   * The gateway's DISPATCHER binding over one of this account's dispatch
   * namespaces, as Workers for Platforms answers `get(name, args, options)`:
   * "Worker not found" for a script the namespace doesn't hold, else a
   * fetcher that `respond` answers with the script as its latest upload
   * left it. Each call is recorded with its options (limits, outbound).
   */
  dispatcher(
    namespace: string,
    respond: (
      request: Request,
      script: { name: string; bindings: Record<string, any>[]; tags: string[] },
    ) => Response | Promise<Response> = () => new Response("dispatched app"),
  ) {
    const calls: Array<{ name: string; options: Record<string, any> | undefined }> = [];
    return {
      calls,
      get: (name: string, _args?: unknown, options?: Record<string, any>) => {
        calls.push({ name, options });
        const script = this.dispatchNamespaces.get(namespace)?.scripts.get(name);
        if (!script) throw new Error(`Worker not found: ${name}`);
        return {
          fetch: async (request: Request) =>
            respond(request, {
              name,
              bindings: script.bindings,
              tags: script.tags,
            }),
        };
      },
    };
  }

  /** `cf workflows instances create|list|get|<status change>`. */
  private workflowInstances(call: RecordedCfCall): FakeCfResponse {
    const action = call.args[2]!;
    const name =
      action === "create" ? call.args[3]! : flag(call.args, "--workflow-name")!;
    const workflow = this.workflows.get(name);
    if (!workflow) return workflowNotFound(name);
    if (action === "create") {
      const id = flag(call.args, "--instance-id") ?? `instance-${(this.counter += 1)}`;
      const params = flag(call.args, "--params");
      workflow.instances.set(id, {
        status: "queued",
        ...(params ? { params: JSON.parse(params) } : {}),
      });
      return { stdout: JSON.stringify({ id, status: "queued" }) };
    }
    if (action === "list") {
      const status = flag(call.args, "--status");
      return {
        stdout: JSON.stringify(
          [...workflow.instances]
            .filter(([, instance]) => !status || instance.status === status)
            .slice(0, Number(flag(call.args, "--per-page") ?? "25"))
            .map(([id, instance]) => ({ id, status: instance.status })),
        ),
      };
    }
    const instance = workflow.instances.get(call.args[3]!);
    if (!instance) return cfError(`Instance ${call.args[3]} not found`);
    if (action === "get") return { stdout: JSON.stringify(instance) };
    if (action === "terminate") {
      const declined = unconfirmed(call, "This operation terminates the running Workflow instance.");
      if (declined) return declined;
    }
    instance.status = INSTANCE_STATUS[flag(call.args, "--status")!]!;
    return { stdout: JSON.stringify({ status: instance.status }) };
  }

  /**
   * `cf build`: the app's Worker (and helper Workers) as its
   * cloudflare.config.ts defines them for production (`appConfigs`, or
   * everyAppWorker() and everyAppAuxiliaryWorker() as they are), from the
   * manifest registered for its directory, or its own everyapp.config.ts,
   * with the build's environment (EVERYAPP_BUILD) as the config sees it.
   */
  private async build(call: RecordedCfCall): Promise<FakeCfResponse> {
    const cwd = call.cwd!;
    const manifest =
      this.apps.get(cwd) ?? (await loadEveryAppManifest(cwd).catch(() => null));
    if (!manifest) return cfError(`no app to build in ${cwd}`);
    let worker;
    // Helper Workers, as the Vite plugin builds auxiliary Workers: each in
    // its own directory, named after the Worker.
    const helpers: Record<string, any>[] = [];
    const buildEnv = process.env["EVERYAPP_BUILD"];
    try {
      if (call.env["EVERYAPP_BUILD"] === undefined) delete process.env["EVERYAPP_BUILD"];
      else process.env["EVERYAPP_BUILD"] = call.env["EVERYAPP_BUILD"];
      const built = (this.appConfigs.get(cwd) ?? plainAppConfig)({ manifest, root: cwd });
      const { entrypoint: _entrypoint, ...definition } = built.worker;
      worker = structuredClone(definition) as Record<string, any>;
      this.editBuild?.(worker);
      for (const helper of built.auxiliaryWorkers ?? []) {
        const { entrypoint: _helperEntry, ...helperDefinition } = helper;
        helpers.push(structuredClone(helperDefinition) as Record<string, any>);
      }
    } catch (error) {
      return cfError((error as Error).message);
    } finally {
      if (buildEnv === undefined) delete process.env["EVERYAPP_BUILD"];
      else process.env["EVERYAPP_BUILD"] = buildEnv;
    }
    const out = path.join(cwd, ".cloudflare/output/v0");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, "workers/default/bundle/assets"), { recursive: true });
    fs.writeFileSync(
      path.join(out, "config.json"),
      JSON.stringify({ buildContext: { isPreview: false, mode: "production" } }),
    );
    fs.writeFileSync(
      path.join(cwd, WORKER_CONFIG),
      JSON.stringify({
        ...worker,
        manifest: { type: "partial", mainModule: "index.js", modules: {} },
      }),
    );
    fs.writeFileSync(path.join(out, "workers/default/bundle/index.js"), "export {}");
    fs.writeFileSync(path.join(out, "workers/default/bundle/assets/x.js.map"), "{}");
    for (const helper of helpers) {
      const dir = path.join(out, "workers", String(helper["name"]));
      fs.mkdirSync(path.join(dir, "bundle"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "worker.config.json"),
        JSON.stringify({
          ...helper,
          manifest: { type: "partial", mainModule: "index.js", modules: {} },
        }),
      );
      fs.writeFileSync(path.join(dir, "bundle/index.js"), "export {}");
    }
    return { stdout: "◆  Build complete" };
  }

  /** `cf deploy --prebuilt`: validate and record what would be uploaded. */
  private deploy(call: RecordedCfCall): FakeCfResponse {
    if (this.failNextDeploy) {
      const message = this.failNextDeploy;
      this.failNextDeploy = null;
      return cfError(message);
    }
    if (this.strictAbortNextDeploy) {
      this.strictAbortNextDeploy = false;
      return STRICT_ABORT;
    }
    if (this.declineNextDeploy) {
      this.declineNextDeploy = false;
      return { stdout: "" };
    }
    // `--worker` picks a Worker by its name, as cf does, not by its directory.
    const selected = flag(call.args, "--worker");
    const config = selected
      ? fs
          .readdirSync(path.join(call.cwd!, WORKERS_OUTPUT))
          .map(
            (dir) =>
              JSON.parse(
                fs.readFileSync(path.join(call.cwd!, WORKERS_OUTPUT, dir, "worker.config.json"), "utf8"),
              ) as Record<string, any>,
          )
          .find((worker) => worker["name"] === selected)
      : (JSON.parse(fs.readFileSync(path.join(call.cwd!, WORKER_CONFIG), "utf8")) as Record<string, any>);
    if (!config) return cfError(`The Build Output has no Worker named "${selected}".`);
    const parsed = OutputWorkerSchema.safeParse(config);
    if (!parsed.success) return cfError(`Invalid Build Output: ${parsed.error.message}`);
    const secrets = call.files["secrets.json"]
      ? (JSON.parse(call.files["secrets.json"]) as Record<string, string>)
      : null;
    const workerName = String(config["name"]);
    const unresolved = Object.entries(config["env"] ?? {})
      .filter(([, binding]) => (binding as { type: string }).type === "worker")
      .map(([name, binding]) => [name, (binding as { worker: string }).worker])
      .filter(([, worker]) => worker !== workerName && !this.workers.has(worker!));
    if (unresolved.length > 0 && !call.args.includes("--dry-run")) {
      const [name, worker] = unresolved[0]!;
      return cfError(
        `Could not resolve service binding '${name}'. Target script '${worker}' not found. [code: 10143]`,
      );
    }
    // A class another Worker defines must be there, exported, first.
    const unexported = Object.entries(config["env"] ?? {})
      .filter(([, binding]) => (binding as { type: string }).type === "durable-object")
      .map(([name, binding]) => [name, binding as { worker: string; exportName: string }] as const)
      .filter(
        ([, binding]) =>
          binding.worker !== workerName &&
          !this.workers.get(binding.worker)?.config["exports"]?.[binding.exportName],
      );
    if (unexported.length > 0 && !call.args.includes("--dry-run")) {
      const [name, binding] = unexported[0]!;
      return cfError(
        `Durable Object binding '${name}' refers to class '${binding.exportName}' of script '${binding.worker}', which doesn't export it. [code: 10061]`,
      );
    }
    if (call.args.includes("--dry-run")) {
      return { stdout: `Dry run: ${workerName} with ${Object.keys(config["env"] ?? {}).join(", ")}` };
    }
    const existing = this.workers.get(workerName);
    const missingSecrets = Object.entries(config["env"] ?? {})
      .filter(([, binding]) => (binding as { type: string }).type === "secret")
      .map(([name]) => name)
      .filter((name) => !existing?.secrets[name] && !secrets?.[name]);
    if (missingSecrets.length > 0) {
      return cfError(`Missing required secrets: ${missingSecrets.join(", ")}`);
    }
    const versionId = `${workerName}-version-${(this.counter += 1)}`;
    this.workers.set(workerName, {
      versions: [...(existing?.versions ?? []), versionId],
      config,
      secrets: { ...existing?.secrets, ...secrets },
    });
    this.deployedAt.set(workerName, this.clock());
    this.deploys.push({ workerName, config, secrets, args: call.args, mode: call.mode });
    // cf deploys the version first, then publishes its triggers.
    const answer = this.afterUpload?.(workerName);
    if (answer) return answer;
    this.publishDomains(workerName, config["domains"]);
    this.putWorkflows(workerName, config);
    // Last, the workers.dev route: an account without a subdomain stops
    // here, its version and Custom Domains live.
    if (!this.workersDevSubdomain) return workersDevSubdomainMissing();
    return { stdout: `Current Version ID: ${versionId}` };
  }

  /** A Custom Domain leaves a Worker: its placeholder record goes with it. */
  private dropCustomDomain(host: string): void {
    this.customDomains.delete(host);
    for (let i = this.dnsRecords.length - 1; i >= 0; i -= 1) {
      const record = this.dnsRecords[i]!;
      if (record.name === host && isPlaceholderRecord(record)) this.dnsRecords.splice(i, 1);
    }
  }

  /**
   * Create or update the Workflows the Worker defines, as cf does: a PUT
   * per name, which takes a Workflow over from another Worker.
   */
  private putWorkflows(workerName: string, config: Record<string, any>): void {
    const defined = [
      ...Object.entries(config["exports"] ?? {})
        .filter(([, entry]) => (entry as { type: string }).type === "workflow")
        .map(([className, entry]) => [(entry as { name: string }).name, className]),
      ...Object.values(config["env"] ?? {})
        .filter(
          (binding: any) => binding.type === "workflow" && binding.worker === workerName,
        )
        .map((binding: any) => [binding.name, binding.exportName]),
    ] as Array<[string, string]>;
    for (const [name, className] of defined) {
      this.workflows.set(name, {
        scriptName: workerName,
        className,
        instances: this.workflows.get(name)?.instances ?? new Map(),
      });
    }
  }

  /**
   * Publish a Worker's Custom Domains as Cloudflare does: only when the
   * config declares some, as the whole list (its others are removed), one
   * taken from another Worker when unattended, each with its placeholder
   * DNS record (`AAAA 100::`, proxied; it goes with the domain), and a
   * certificate pack per new hostname that stays when the domain goes:
   * [apex, host, *.host], or [apex, *.apex] for the apex itself.
   */
  private publishDomains(workerName: string, domains: unknown): void {
    if (!Array.isArray(domains) || domains.length === 0) return;
    for (const [host, worker] of [...this.customDomains]) {
      if (worker === workerName && !domains.includes(host)) {
        this.dropCustomDomain(host);
      }
    }
    for (const host of domains as string[]) {
      if (this.customDomains.get(host) === workerName) continue;
      this.customDomains.set(host, workerName);
      const zone = [...this.zones]
        .sort((a, b) => b.name.length - a.name.length)
        .find((candidate) => host === candidate.name || host.endsWith(`.${candidate.name}`));
      if (!zone) continue;
      if (!this.dnsRecords.some((record) => record.name === host && isPlaceholderRecord(record))) {
        this.dnsRecords.push({ zoneId: zone.id, name: host, ...PLACEHOLDER_RECORD });
      }
      const hosts =
        host === zone.name ? [host, `*.${host}`] : [zone.name, host, `*.${host}`];
      if (!this.certificatePacks.some((pack) => pack.hosts.join() === hosts.join())) {
        this.certificatePacks.push({
          id: `pack-${(this.counter += 1)}`,
          zoneId: zone.id,
          hosts,
        });
      }
    }
  }
}
