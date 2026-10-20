/**
 * A Cloudflare account for end-to-end tests of the deploy plane, behind
 * FakeCf: D1 databases are real SQLite (queries and `migrations apply` run
 * against them), KV namespaces exist by title, `cf deploy --prebuilt` reads
 * the Build Output it would upload and validates it with @cloudflare/config,
 * and `cf build` builds an app's tenant-neutral Worker config with the SDK's
 * real everyAppWorker(), in the environment the build is given. Zones hold DNS records, a
 * deploy publishes its Worker's Custom Domains the way Cloudflare does (the
 * whole list, taken from other Workers, each with its own certificate pack
 * that outlives it, listing the zone apex, the hostname and its wildcard) and creates or takes over the Workflows the Worker
 * defines. Hyperdrive configs keep their origin, password apart, as the
 * API does (it never returns one). Each zone has Email Routing: its
 * settings, rules and catch-all (`emailRouting`), enabled on a domain by
 * adding Cloudflare's MX records there, with rules that may send mail only
 * to a Worker that exists. `api.fetch` is the account's REST API, for the hosted
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
}

interface FakeCertificatePack {
  id: string;
  zoneId: string;
  hosts: string[];
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
  /** Records the operator made; Custom Domains' own aren't listed (unverified). */
  readonly dnsRecords: FakeDnsRecord[] = [];
  /** Email Routing, by zone id; a zone's starts off, its catch-all dropping mail. */
  readonly emailRouting = new Map<string, FakeEmailRouting>();
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
            .map((record, index) => ({ id: `record-${index}`, ...record })),
        ),
      }))
      .on(["ssl", "certificate-packs", "list"], (call) => ({
        stdout: JSON.stringify(
          flag(call.args, "--page") === "1"
            ? this.certificatePacks
                .filter((pack) => pack.zoneId === flag(call.args, "-z"))
                .map(({ id, hosts }) => ({ id, type: "advanced", hosts, status: "active" }))
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
                created_on: "2026-10-12T00:00:00Z",
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
        return { stdout: "{}" };
      })
      .on(["workers", "delete"], (call) => {
        const declined = unconfirmed(call, "This will permanently delete the Worker and its associated versions and deployments.");
        if (declined) return declined;
        this.workers.delete(call.args[2]!);
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
      .on(["email-routing"], (call) => this.emailRoutingCommand(call))
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
    this.deploys.push({ workerName, config, secrets, args: call.args, mode: call.mode });
    // cf deploys the version first, then publishes its triggers.
    const answer = this.afterUpload?.(workerName);
    if (answer) return answer;
    this.publishDomains(workerName, config["domains"]);
    this.putWorkflows(workerName, config);
    return { stdout: `Current Version ID: ${versionId}` };
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
   * taken from another Worker when unattended, and a certificate pack per
   * new hostname that stays when the domain goes: [apex, host, *.host], or
   * [apex, *.apex] for the apex itself.
   */
  private publishDomains(workerName: string, domains: unknown): void {
    if (!Array.isArray(domains) || domains.length === 0) return;
    for (const [host, worker] of [...this.customDomains]) {
      if (worker === workerName && !domains.includes(host)) {
        this.customDomains.delete(host);
      }
    }
    for (const host of domains as string[]) {
      if (this.customDomains.get(host) === workerName) continue;
      this.customDomains.set(host, workerName);
      const zone = [...this.zones]
        .sort((a, b) => b.name.length - a.name.length)
        .find((candidate) => host === candidate.name || host.endsWith(`.${candidate.name}`));
      if (!zone) continue;
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
