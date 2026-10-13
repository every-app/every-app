/**
 * A Cloudflare account for end-to-end tests of the deploy plane, behind
 * FakeCf: D1 databases are real SQLite (queries and `migrations apply` run
 * against them), KV namespaces hold values, `cf deploy --prebuilt` reads
 * the Build Output it would upload and validates it with @cloudflare/config,
 * and `cf build` builds an app's Worker config with the SDK's real
 * everyAppWorker() from the deploy inputs. Nothing is spawned or sent.
 */
import fs from "node:fs";
import path from "node:path";
import { OutputWorkerSchema } from "@cloudflare/config";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import {
  APP_BINDING_PREFIX,
  appBindingsDigest,
} from "@every-app/perimeter/manifest";
import { FakeCf, type FakeCfResponse, type RecordedCfCall } from "@/lib/cf/fakeCf";
import type { GatewayStatusResponse } from "@/lib/gateway/api";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createSqliteD1, sqliteD1Script, type SqliteD1 } from "./sqliteD1";

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

const WORKER_CONFIG = ".cloudflare/output/v0/workers/default/worker.config.json";

function cfError(message: string): FakeCfResponse {
  return { exitCode: 1, stderr: `┌ Error\n│ ${message}\n└\n` };
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
  readonly namespaces = new Map<string, { title: string; keys: Map<string, string> }>();
  readonly workers = new Map<string, DeployedWorker>();
  readonly deploys: RecordedDeploy[] = [];
  /** Apps `cf build` can build, by app root. */
  readonly apps = new Map<string, EveryAppCliManifest>();
  /** The next `cf deploy` fails with this stderr box message. */
  failNextDeploy: string | null = null;
  /** The next `cf deploy` uploads nothing and exits 0, as when a person declines its prompt. */
  declineNextDeploy = false;
  /** Changes what `cf build` writes, as an app's own cloudflare.config.ts could. */
  editBuild: ((config: Record<string, any>) => void) | null = null;
  /** Runs once a `cf deploy` has uploaded; what it returns is cf's answer instead. */
  afterUpload: ((workerName: string) => FakeCfResponse | undefined) | null = null;
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
      .on(["zones", "list"], (call) => ({
        stdout: JSON.stringify(
          flag(call.args, "--name") === "example.com"
            ? [{ id: "zone-1", name: "example.com", status: "active" }]
            : [],
        ),
      }))
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
      .on(["kv", "keys"], (call) => this.kvKeys(call))
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
      .on(["workers", "delete"], (call) => {
        const declined = unconfirmed(call, "This will permanently delete the Worker and its associated versions and deployments.");
        if (declined) return declined;
        this.workers.delete(call.args[2]!);
        return { stdout: "{}" };
      })
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
    this.namespaces.set(id, { title, keys: new Map() });
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

  /** What the live gateway's /api/deploy/status would answer. */
  async gatewayStatus(): Promise<GatewayStatusResponse> {
    const gateway = this.workers.get("every-app-gateway");
    if (!gateway) throw new Error("fetch failed: no gateway");
    const bindings = Object.keys(gateway.config["env"])
      .filter((name) => name.startsWith(APP_BINDING_PREFIX))
      .sort();
    return {
      release: gateway.config["env"].EVERYAPP_RELEASE.value,
      versionId: gateway.versions.at(-1)!,
      appBindingsDigest: await appBindingsDigest(bindings),
      gatewayHost: gateway.config["domains"]?.[0] ?? null,
      appBindings: bindings.map((name) => name.slice(APP_BINDING_PREFIX.length)),
    };
  }

  /** The app Workers the live gateway binds. */
  gatewayBindings(): string[] {
    const env = this.workers.get("every-app-gateway")?.config["env"] ?? {};
    return Object.keys(env)
      .filter((name) => name.startsWith(APP_BINDING_PREFIX))
      .map((name) => name.slice(APP_BINDING_PREFIX.length))
      .sort();
  }

  private kvKeys(call: RecordedCfCall): FakeCfResponse {
    const ns = this.namespaces.get(flag(call.args, "--namespace-id")!);
    if (!ns) return cfError("namespace not found [code: 10013]");
    const [, , action, key] = call.args;
    if (action === "list") {
      const prefix = flag(call.args, "--prefix") ?? "";
      return {
        stdout: JSON.stringify(
          [...ns.keys.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        ),
      };
    }
    if (action === "put") {
      ns.keys.set(key!, call.files["release.b64"]!);
      return { stdout: "{}" };
    }
    const value = ns.keys.get(key!);
    return value === undefined
      ? cfError("get: 'key not found' [code: 10009]")
      : { stdout: value };
  }

  /** `cf build`: the app's Worker as everyAppWorker() defines it for production. */
  private build(call: RecordedCfCall): FakeCfResponse {
    const cwd = call.cwd!;
    const manifest = this.apps.get(cwd);
    if (!manifest) return cfError(`no app to build in ${cwd}`);
    let worker;
    try {
      const { entrypoint: _entrypoint, ...definition } = everyAppWorker({
        manifest,
        entrypoint: "./src/entry.worker.ts",
        ctx: { mode: "production" },
        root: cwd,
      });
      worker = structuredClone(definition) as Record<string, any>;
      this.editBuild?.(worker);
    } catch (error) {
      return cfError((error as Error).message);
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
    return { stdout: "◆  Build complete" };
  }

  /** `cf deploy --prebuilt`: validate and record what would be uploaded. */
  private deploy(call: RecordedCfCall): FakeCfResponse {
    if (this.failNextDeploy) {
      const message = this.failNextDeploy;
      this.failNextDeploy = null;
      return cfError(message);
    }
    if (this.declineNextDeploy) {
      this.declineNextDeploy = false;
      return { stdout: "" };
    }
    const config = JSON.parse(
      fs.readFileSync(path.join(call.cwd!, WORKER_CONFIG), "utf8"),
    ) as Record<string, any>;
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
    return this.afterUpload?.(workerName) ?? { stdout: `Current Version ID: ${versionId}` };
  }
}
