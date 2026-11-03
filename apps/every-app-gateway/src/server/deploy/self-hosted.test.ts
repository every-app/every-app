/**
 * A browser install of a release on a self-hosted Gateway
 * (runSelfHostedInstall): the install engine `everyapp deploy` runs
 * (@every-app/perimeter/install app-install.ts) with this Gateway's REST
 * ports, against a small fake of the account's Workers API. The engine's
 * own order and refusals are pinned with in-memory ports in perimeter's
 * app-install.test.ts; these pin the REST wiring: each helper Worker is
 * found by its directory and uploaded before the app's, a setting default
 * is written only when no secret_text holds it, a Worker changed outside
 * EveryApp is refused unless the person confirmed replacing it (the
 * registry's version counts as EveryApp's), and the registry keeps the
 * secret names it had when Cloudflare can't list them.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  everyAppAuxiliaryWorker,
  everyAppWorker,
} from "@every-app/sdk/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  updates: [] as unknown[],
}));

vi.mock("cloudflare:workers", () => ({ env: hoisted.env }));
// The only `@/db` write a browser install makes itself: the secret names.
vi.mock("@/db", () => ({
  db: {
    update: () => ({
      set: (values: unknown) => ({
        where: async () => void hoisted.updates.push(values),
      }),
    }),
  },
}));
vi.mock("./registry", () => ({
  recordDispatchDeployed: async (
    id: string,
    deployed: { versionId: string },
  ) => ({ id, versionId: deployed.versionId }),
}));

import {
  recordOwnedResource,
  type InstallationDatabase,
} from "@every-app/perimeter/install";
import type { Manifest } from "@every-app/perimeter/manifest";
import type { AppRow } from "@every-app/perimeter/registry";
import { version as gatewayVersion } from "../../../package.json";
import type { DeployBundle } from "./bundle";
import type { CfRestDeployer } from "./cfRestDeployer";
import {
  runSelfHostedInstall,
  type AppInstallConfiguration,
} from "./self-hosted";

const ACCOUNT_ID = "0123456789abcdef0123456789abcd01";
const PREFIX = `/client/v4/accounts/${ACCOUNT_ID}/`;
const WORKER = "every-acme-todo";
const HELPER = `${WORKER}--audit`;
const KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----";

const MANIFEST = {
  id: "todo",
  workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
  settings: [{ name: "THEME", default: "dark" }],
} as const;

interface Binding {
  type: string;
  name: string;
  text?: string;
}

/** An account Worker as the fake keeps it. */
interface Script {
  bindings: Binding[];
  /** Its serving version. */
  version: string;
}

/** The account's Workers API, as much of it as a browser install uses. */
class FakeAccount {
  readonly scripts = new Map<string, Script>();
  /** Every request, as `METHOD path` under the account. */
  readonly log: string[] = [];
  /** Uploaded metadata bindings, by Worker, text included. */
  readonly uploads = new Map<string, Binding[]>();
  /** Requests the fake has no answer for. */
  readonly unserved: string[] = [];
  /** Each uploaded Worker's main module. */
  readonly mains = new Map<string, string>();
  /** Answer 403 to a settings read of this Worker once it was uploaded. */
  failSettingsAfterUpload: string | null = null;
  private versions = 0;

  fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.slice(PREFIX.length);
    this.log.push(`${request.method} ${path}`);
    const [kind, sub, name, part] = path.split("/").map(decodeURIComponent);
    if (kind === "workers" && sub === "scripts") {
      if (name === undefined && request.method === "GET")
        return ok([...this.scripts.keys()].map((id) => ({ id })));
      const script = this.scripts.get(name!);
      if (part === undefined && request.method === "PUT") {
        const form = await request.formData();
        this.mains.set(name!, await (form.get("index.js") as File).text());
        const metadata = JSON.parse(
          await (form.get("metadata") as File).text(),
        ) as { bindings: Binding[]; keep_bindings?: string[] };
        this.uploads.set(name!, metadata.bindings);
        const uploaded = new Set(metadata.bindings.map((b) => b.name));
        const kept = (script?.bindings ?? []).filter(
          (binding) =>
            metadata.keep_bindings?.includes(binding.type) &&
            !uploaded.has(binding.name),
        );
        this.scripts.set(name!, {
          bindings: [
            ...kept,
            ...metadata.bindings.map(({ text: _text, ...binding }) => binding),
          ],
          version: `v-${++this.versions}`,
        });
        return ok({ id: name });
      }
      if (part === "deployments" && request.method === "GET")
        return script
          ? ok({
              deployments: [
                {
                  created_on: "2026-11-01T00:00:00Z",
                  versions: [{ version_id: script.version, percentage: 100 }],
                },
              ],
            })
          : notFound();
      if (part === "settings" && request.method === "GET") {
        if (name === this.failSettingsAfterUpload && this.uploads.has(name))
          return fail(403);
        return script ? ok({ bindings: script.bindings }) : notFound();
      }
      if (part === "subdomain" && request.method === "POST") return ok({});
      if (part === "schedules" && request.method === "PUT") return ok({});
    }
    if (kind === "workflows" && request.method === "GET") return notFound();
    this.unserved.push(`${request.method} ${path}`);
    return fail(400);
  };

  /** The Workers uploaded, in order. */
  uploaded(): string[] {
    return this.log
      .filter((line) => /^PUT workers\/scripts\/[^/]+$/.test(line))
      .map((line) => line.split("/")[2]!);
  }
}

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result }), {
    headers: { "Content-Type": "application/json" },
  });
const fail = (status: number) =>
  new Response(
    JSON.stringify({ success: false, errors: [{ message: "no" }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
const notFound = () =>
  new Response(
    JSON.stringify({
      success: false,
      errors: [{ code: 10007, message: "not found" }],
    }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );

/** The Gateway's D1 as `env.DB`: the ledger and the apps row's email. */
function d1(sqlite: DatabaseSync) {
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...bound: unknown[]) => statement(sql, bound),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<ReturnType<typeof statement>>) =>
      statements.map(({ sql, params }) => ({
        results: (
          sqlite.prepare(sql).all(...(params as SQLInputValue[])) as Array<
            Record<string, unknown>
          >
        ).map((row) => ({ ...row })),
      })),
  };
}

/** The release's bundle: `cf build`'s tenant-neutral Workers for MANIFEST. */
function bundle(): DeployBundle {
  const options = {
    manifest: MANIFEST,
    ctx: { mode: "production" },
    root: "/app",
  } as const;
  const worker = (config: object) => ({
    ...structuredClone(config),
    manifest: { type: "partial", mainModule: "index.js", modules: {} },
  });
  const { entrypoint: _app, ...app } = everyAppWorker({
    ...options,
    entrypoint: "./src/entry.worker.ts",
  });
  const { entrypoint: _helper, ...helper } = everyAppAuxiliaryWorker({
    ...options,
    worker: "audit",
    entrypoint: "./src/audit.ts",
  });
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const of = (config: object, main: string): DeployBundle => ({
    manifest: MANIFEST,
    stamp: { protocol: 1, sdkVersion: null, cliVersion: gatewayVersion },
    worker: worker(config),
    modules: new Map([["index.js", new TextEncoder().encode(main)]]),
    assets: new Map(),
    migrations: [],
  });
  return {
    ...of(app, "export default { app: true };"),
    helpers: new Map([
      ["audit", of(helper, "export default { audit: true };")],
    ]),
    releaseFiles: new Map([
      ["release.json", encode({ minCli: "0.3.0" })],
      [
        ".cloudflare/output/v0/config.json",
        encode({
          version: 0,
          buildContext: { mode: "production", isPreview: false },
        }),
      ],
    ]),
  };
}

let account: FakeAccount;
let sqlite: DatabaseSync;
let realFetch: typeof fetch;

const ledger: InstallationDatabase = {
  run: async (statements) =>
    statements.map(({ sql, params = [] }) =>
      (
        sqlite.prepare(sql).all(...(params as SQLInputValue[])) as Array<
          Record<string, unknown>
        >
      ).map((row) => ({ ...row })),
    ),
};

/** An earlier install of the app: its Workers claimed and serving `version`. */
async function installedBefore(version: string, bindings: Binding[] = []) {
  for (const [binding, name] of [
    ["", WORKER],
    ["audit", HELPER],
  ] as const) {
    await recordOwnedResource(ledger, WORKER, {
      kind: "worker",
      binding,
      name,
      resourceId: name,
    });
    account.scripts.set(name, {
      bindings: name === WORKER ? bindings : [],
      version: name === WORKER ? version : "v-helper",
    });
  }
  await ledger.run([
    {
      sql: "UPDATE _everyapp_app_resources SET version_id = 'v-helper' WHERE binding = 'audit'",
    },
  ]);
}

function install(
  configuration: AppInstallConfiguration = {},
  versionId: string | null = null,
) {
  return runSelfHostedInstall({
    app: {
      id: "app-1",
      appSlug: "todo",
      workerName: WORKER,
      versionId,
      organizationId: "org-1",
    } as unknown as AppRow,
    manifest: MANIFEST as unknown as Manifest,
    bundle: bundle(),
    gatewayUrl: "https://apps.example.com",
    identityPublicKey: KEY,
    deployer: {
      publishBoundApp: async () => undefined,
    } as unknown as CfRestDeployer,
    renew: async () => undefined,
    actor: "user-1",
    configuration,
  });
}

beforeEach(() => {
  vi.stubEnv("EVERYAPP_BUILD", "1");
  account = new FakeAccount();
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE apps (id TEXT PRIMARY KEY, email_senders TEXT, email_inbound TEXT)",
  );
  Object.assign(hoisted.env, {
    DB: d1(sqlite),
    CF_DEPLOY_TOKEN: "fake-token",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  });
  hoisted.updates.length = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = account.fetch as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("runSelfHostedInstall", () => {
  it("uploads the helper Worker before the app's, each from its own directory", async () => {
    const deployed = await install();
    expect(account.uploaded()).toEqual([HELPER, WORKER]);
    expect(account.mains.get(HELPER)).toContain("audit: true");
    expect(account.mains.get(WORKER)).toContain("app: true");
    expect(deployed.versionId).toBe(account.scripts.get(WORKER)!.version);
    // Each version names the Gateway and the organization, and carries the
    // default of the setting nobody set.
    for (const name of [HELPER, WORKER])
      expect(
        Object.fromEntries(
          account.uploads
            .get(name)!
            .filter((binding) => binding.type === "secret_text")
            .map((binding) => [binding.name, binding.text]),
        ),
      ).toMatchObject({
        THEME: "dark",
        GATEWAY_URL: "https://apps.example.com",
        EVERY_APP_ORG_ID: "org-1",
      });
    expect(account.unserved).toEqual([]);
    expect(hoisted.updates).toEqual([
      { secretNames: JSON.stringify(["THEME"]) },
    ]);
  });

  it("never writes a setting's default over the secret_text that holds it", async () => {
    await installedBefore("v-registry", [
      { type: "secret_text", name: "THEME" },
      { type: "plain_text", name: "NOT_A_SECRET" },
    ]);
    await install({}, "v-registry");
    expect(
      account.uploads.get(WORKER)!.some((binding) => binding.name === "THEME"),
    ).toBe(false);
    expect(hoisted.updates).toEqual([
      { secretNames: JSON.stringify(["THEME"]) },
    ]);
  });

  it("writes a setting's default a plain binding of the same name doesn't hold", async () => {
    await installedBefore("v-registry", [
      { type: "plain_text", name: "THEME" },
    ]);
    await install({}, "v-registry");
    expect(
      account.uploads.get(WORKER)!.find((binding) => binding.name === "THEME"),
    ).toMatchObject({ type: "secret_text", text: "dark" });
  });

  describe("a Worker changed outside EveryApp", () => {
    it("is refused, after its resources are prepared and before anything is uploaded", async () => {
      await installedBefore("v-outside");
      await expect(install({}, "v-registry")).rejects.toMatchObject({
        code: "WORKER_CHANGED",
      });
      expect(account.uploaded()).toEqual([]);
    });

    it("is replaced when the person confirmed it", async () => {
      await installedBefore("v-outside");
      await install({ replaceChangedWorkers: true }, "v-registry");
      expect(account.uploaded()).toEqual([HELPER, WORKER]);
    });

    it("is not one when the registry recorded its version", async () => {
      await installedBefore("v-registry");
      await install({}, "v-registry");
      expect(account.uploaded()).toEqual([HELPER, WORKER]);
    });
  });

  it("keeps the secret names recorded before when Cloudflare can't list them", async () => {
    account.failSettingsAfterUpload = WORKER;
    const deployed = await install();
    expect(deployed.versionId).toBe(account.scripts.get(WORKER)!.version);
    expect(hoisted.updates).toEqual([]);
  });
});
