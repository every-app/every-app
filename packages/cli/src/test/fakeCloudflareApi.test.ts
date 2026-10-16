/**
 * The fake Cloudflare's REST API, driven through @every-app/cf-rest as the
 * hosted deployer will drive the real one: if the client and the fake
 * disagree about a path or a body, these fail.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloudflareApiError,
  createCloudflareRest,
  isCloudflareNotFound,
  type CloudflareRest,
  type WorkerMetadata,
  type WorkerModule,
} from "@every-app/cf-rest";
import { FakeCloudflare } from "./fakeCloudflare";
import { FAKE_API_TOKEN } from "./fakeCloudflareApi";

let account: FakeCloudflare;
let cf: CloudflareRest;

const NS = "every-app-apps";
const modules: WorkerModule[] = [
  { name: "index.js", type: "esm", content: "export default { fetch() {} }" },
  { name: "chunk.js", type: "esm", content: "export const x = 1" },
];

function metadata(overrides: Partial<WorkerMetadata> = {}): WorkerMetadata {
  return {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    bindings: [{ type: "plain_text", name: "MODE", text: "hosted" }],
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<CloudflareApiError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CloudflareApiError);
  return error as CloudflareApiError;
}

beforeEach(() => {
  account = new FakeCloudflare();
  cf = createCloudflareRest({
    apiToken: FAKE_API_TOKEN,
    accountId: account.accountId,
    fetch: account.api.fetch,
    sleep: async () => {},
  });
});

describe("the fake's REST API", () => {
  it("refuses another token or another account", async () => {
    const other = createCloudflareRest({
      apiToken: "someone-else",
      accountId: account.accountId,
      fetch: account.api.fetch,
    });
    expect(await rejection(other.dispatchNamespaces.list())).toMatchObject({
      status: 403,
      code: 10000,
    });
    const elsewhere = createCloudflareRest({
      apiToken: FAKE_API_TOKEN,
      accountId: "f".repeat(32),
      fetch: account.api.fetch,
    });
    expect(await rejection(elsewhere.dispatchNamespaces.list())).toMatchObject({
      status: 403,
    });
  });

  it("answers an unknown route with 7000, which isn't a missing object", async () => {
    const response = await account.api.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/workers/nope`,
      { headers: { Authorization: `Bearer ${FAKE_API_TOKEN}` } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      errors: [{ code: 7000 }],
    });
  });

  it("records each call", async () => {
    await cf.dispatchNamespaces.list();
    expect(account.api.calls).toEqual([
      {
        method: "GET",
        path: `/accounts/${account.accountId}/workers/dispatch/namespaces`,
        search: "",
      },
    ]);
  });
});

describe("dispatch namespaces", () => {
  it("creates, lists, gets and deletes a namespace", async () => {
    const created = await cf.dispatchNamespaces.create(NS);
    expect(created).toMatchObject({ namespace_name: NS, script_count: 0 });
    expect(account.dispatchNamespaces.get(NS)?.id).toBe(created.namespace_id);
    expect(await cf.dispatchNamespaces.list()).toEqual([created]);
    expect(await cf.dispatchNamespaces.get(NS)).toEqual(created);

    expect(await rejection(cf.dispatchNamespaces.create(NS))).toMatchObject({
      status: 409,
    });

    await cf.dispatchNamespaces.delete(NS);
    expect(account.dispatchNamespaces.size).toBe(0);
    expect(isCloudflareNotFound(await rejection(cf.dispatchNamespaces.get(NS)))).toBe(true);
  });

  it("refuses scripts in a namespace that doesn't exist", async () => {
    const error = await rejection(
      cf.dispatchScripts.upload("missing", "s", { metadata: metadata(), modules }),
    );
    expect(isCloudflareNotFound(error)).toBe(true);
  });
});

describe("dispatch scripts", () => {
  beforeEach(async () => {
    await cf.dispatchNamespaces.create(NS);
  });

  it("stores an upload's modules, metadata, limits and tags, and echoes its bindings", async () => {
    const { uuid } = account.createDatabase("acme--todo");
    const result = await cf.dispatchScripts.upload(NS, "acme--todo", {
      metadata: metadata({
        bindings: [
          { type: "d1", name: "DB", id: uuid },
          { type: "secret_text", name: "API_KEY", text: "s3cret" },
          { type: "plain_text", name: "MODE", text: "hosted" },
        ],
        limits: { cpu_ms: 50, subrequests: 100 },
        tags: ["org=acme", "app=todo"],
        observability: { enabled: true, head_sampling_rate: 0.5 },
      }),
      modules,
    });
    expect(result).toMatchObject({
      id: "acme--todo",
      tags: ["org=acme", "app=todo"],
      compatibility_date: "2026-10-01",
      has_assets: false,
    });

    const stored = account.dispatchNamespaces.get(NS)!.scripts.get("acme--todo")!;
    expect(stored.mainModule).toBe("index.js");
    expect(stored.modules["chunk.js"]).toEqual({
      contentType: "application/javascript+module",
      content: "export const x = 1",
    });
    expect(stored.limits).toEqual({ cpu_ms: 50, subrequests: 100 });
    expect(stored.observability).toEqual({ enabled: true, head_sampling_rate: 0.5 });

    // Secrets come back without their text.
    expect(await cf.dispatchScripts.bindings(NS, "acme--todo")).toEqual([
      { type: "d1", name: "DB", id: uuid },
      { type: "secret_text", name: "API_KEY" },
      { type: "plain_text", name: "MODE", text: "hosted" },
    ]);
    expect(await cf.dispatchScripts.get(NS, "acme--todo")).toMatchObject({
      dispatch_namespace: NS,
      script: { id: "acme--todo", etag: stored.etag },
    });
    expect(await cf.dispatchNamespaces.get(NS)).toMatchObject({ script_count: 1 });
  });

  it("refuses bindings to things that don't exist, and a main module that isn't ESM", async () => {
    expect(
      await rejection(
        cf.dispatchScripts.upload(NS, "s", {
          metadata: metadata({ bindings: [{ type: "d1", name: "DB", id: "nope" }] }),
          modules,
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await rejection(
        cf.dispatchScripts.upload(NS, "s", {
          metadata: metadata({
            bindings: [{ type: "service", name: "EVERYAPP", service: "every-app-gateway" }],
          }),
          modules,
        }),
      ),
    ).toMatchObject({ status: 400, code: 10143 });
    expect(
      await rejection(
        cf.dispatchScripts.upload(NS, "s", {
          metadata: metadata(),
          modules: [{ name: "index.js", type: "cjs", content: "" }],
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(account.dispatchNamespaces.get(NS)!.scripts.size).toBe(0);
  });

  it("resolves a service binding with props to an account Worker", async () => {
    account.workers.set("every-app-gateway", { versions: ["v1"], config: {}, secrets: {} });
    const props = { organizationId: "org_1", appId: "todo", workerName: "acme--todo" };
    await cf.dispatchScripts.upload(NS, "acme--todo", {
      metadata: metadata({
        bindings: [
          {
            type: "service",
            name: "EVERYAPP",
            service: "every-app-gateway",
            entrypoint: "AppGateway",
            props,
          },
        ],
      }),
      modules,
    });
    expect(await cf.dispatchScripts.bindings(NS, "acme--todo")).toEqual([
      {
        type: "service",
        name: "EVERYAPP",
        service: "every-app-gateway",
        entrypoint: "AppGateway",
        props,
      },
    ]);
  });

  it("carries secrets over with keep_bindings and inherit, and keeps tags an upload doesn't set", async () => {
    await cf.dispatchScripts.upload(NS, "s", {
      metadata: metadata({
        bindings: [
          { type: "secret_text", name: "API_KEY", text: "v1" },
          { type: "plain_text", name: "MODE", text: "a" },
        ],
        tags: ["org=acme"],
      }),
      modules,
    });
    await cf.dispatchScripts.upload(NS, "s", {
      metadata: metadata({
        bindings: [{ type: "plain_text", name: "MODE", text: "b" }],
        keep_bindings: ["secret_text"],
      }),
      modules,
    });
    const script = account.dispatchNamespaces.get(NS)!.scripts.get("s")!;
    expect(script.bindings).toEqual([
      { type: "secret_text", name: "API_KEY", text: "v1" },
      { type: "plain_text", name: "MODE", text: "b" },
    ]);
    expect(script.tags).toEqual(["org=acme"]);
    expect(script.versions).toBe(2);

    await cf.dispatchScripts.upload(NS, "s", {
      metadata: metadata({ bindings: [{ type: "inherit", name: "MODE" }] }),
      modules,
    });
    expect(account.dispatchNamespaces.get(NS)!.scripts.get("s")!.bindings).toEqual([
      { type: "plain_text", name: "MODE", text: "b" },
    ]);
  });

  it("patches settings: replaced bindings with inherit, limits, tags", async () => {
    await cf.dispatchScripts.upload(NS, "s", {
      metadata: metadata({
        bindings: [
          { type: "secret_text", name: "API_KEY", text: "v1" },
          { type: "plain_text", name: "MODE", text: "a" },
        ],
      }),
      modules,
    });
    const settings = await cf.dispatchScripts.patchSettings(NS, "s", {
      bindings: [
        { type: "inherit", name: "API_KEY" },
        { type: "plain_text", name: "TIER", text: "free" },
      ],
      limits: { cpu_ms: 10 },
      tags: ["org=acme"],
    });
    expect(settings).toMatchObject({
      bindings: [
        { type: "secret_text", name: "API_KEY" },
        { type: "plain_text", name: "TIER", text: "free" },
      ],
      limits: { cpu_ms: 10 },
      tags: ["org=acme"],
    });
    expect(await cf.dispatchScripts.getSettings(NS, "s")).toEqual(settings);
    expect(account.dispatchNamespaces.get(NS)!.scripts.get("s")!.bindings[0]).toEqual({
      type: "secret_text",
      name: "API_KEY",
      text: "v1",
    });
  });

  it("puts, lists, bulk-patches and deletes secrets", async () => {
    await cf.dispatchScripts.upload(NS, "s", { metadata: metadata(), modules });
    await cf.dispatchScripts.putSecret(NS, "s", "A", "1");
    await cf.dispatchScripts.patchSecrets(NS, "s", { B: "2", C: "3" });
    await cf.dispatchScripts.patchSecrets(NS, "s", { A: null, B: "22" });
    expect(await cf.dispatchScripts.listSecrets(NS, "s")).toEqual([
      { type: "secret_text", name: "C" },
      { type: "secret_text", name: "B" },
    ]);
    const script = account.dispatchNamespaces.get(NS)!.scripts.get("s")!;
    expect(script.bindings.find((b) => b["name"] === "B")).toMatchObject({ text: "22" });

    await cf.dispatchScripts.deleteSecret(NS, "s", "C");
    expect(
      await rejection(cf.dispatchScripts.deleteSecret(NS, "s", "C")),
    ).toMatchObject({ status: 404 });
    // A secret can't take a plain binding's name.
    expect(
      await rejection(cf.dispatchScripts.putSecret(NS, "s", "MODE", "x")),
    ).toMatchObject({ status: 400 });
  });

  it("reads, replaces, adds and removes tags", async () => {
    await cf.dispatchScripts.upload(NS, "s", {
      metadata: metadata({ tags: ["org=acme"] }),
      modules,
    });
    await cf.dispatchScripts.addTag(NS, "s", "app=todo");
    expect(await cf.dispatchScripts.getTags(NS, "s")).toEqual(["org=acme", "app=todo"]);
    await cf.dispatchScripts.removeTag(NS, "s", "org=acme");
    expect(await cf.dispatchScripts.getTags(NS, "s")).toEqual(["app=todo"]);
    await cf.dispatchScripts.setTags(NS, "s", ["org=beta"]);
    expect(await cf.dispatchScripts.getTags(NS, "s")).toEqual(["org=beta"]);
  });

  it("lists and deletes by tag", async () => {
    for (const [name, tags] of [
      ["acme--todo", ["org=acme", "app=todo"]],
      ["acme--chef", ["org=acme", "app=chef"]],
      ["beta--todo", ["org=beta", "app=todo"]],
    ] as const) {
      await cf.dispatchScripts.upload(NS, name, {
        metadata: metadata({ tags: [...tags] }),
        modules,
      });
    }
    const ids = (details: Array<{ script: { id: string } }>) =>
      details.map((detail) => detail.script.id).sort();
    expect(ids(await cf.dispatchScripts.list(NS))).toEqual([
      "acme--chef",
      "acme--todo",
      "beta--todo",
    ]);
    expect(ids(await cf.dispatchScripts.list(NS, { "org=acme": true }))).toEqual([
      "acme--chef",
      "acme--todo",
    ]);
    expect(
      ids(await cf.dispatchScripts.list(NS, { "app=todo": true, "org=acme": false })),
    ).toEqual(["beta--todo"]);

    expect(await cf.dispatchScripts.deleteByTags(NS, { "org=acme": true })).toEqual({
      deleted: [{ id: "acme--todo" }, { id: "acme--chef" }],
      deleted_count: 2,
      has_more: false,
    });
    expect([...account.dispatchNamespaces.get(NS)!.scripts.keys()]).toEqual(["beta--todo"]);
  });

  it("deletes a script; a missing one is not found", async () => {
    await cf.dispatchScripts.upload(NS, "s", { metadata: metadata(), modules });
    await cf.dispatchScripts.delete(NS, "s", { force: true });
    const error = await rejection(cf.dispatchScripts.get(NS, "s"));
    expect(error).toMatchObject({ status: 404, code: 10007 });
    expect(isCloudflareNotFound(error)).toBe(true);
  });

  it("serves assets uploaded through a session and refuses an unknown completion token", async () => {
    const files = {
      "index.html": { bytes: new TextEncoder().encode("<h1>hi</h1>"), contentType: "text/html" },
      "app.js": { bytes: new TextEncoder().encode("1") },
    };
    const jwt = await cf.dispatchAssets.upload(NS, "s", files);
    await cf.dispatchScripts.upload(NS, "s", {
      metadata: metadata({
        bindings: [{ type: "assets", name: "ASSETS" }],
        assets: { jwt, config: { not_found_handling: "single-page-application" } },
      }),
      modules,
    });
    const script = account.dispatchNamespaces.get(NS)!.scripts.get("s")!;
    expect(Object.keys(script.assets ?? {}).sort()).toEqual(["/app.js", "/index.html"]);
    expect(script.assetsConfig).toEqual({ not_found_handling: "single-page-application" });
    expect(account.api.assetBlobs.size).toBe(2);

    // Cloudflare already has both: nothing to upload, the session JWT completes.
    const again = await cf.dispatchAssets.upload(NS, "s", files);
    expect(account.api.calls.filter((call) => call.path.endsWith("/assets/upload"))).toHaveLength(1);
    await cf.dispatchScripts.upload(NS, "s", {
      metadata: metadata({ assets: { jwt: again } }),
      modules,
    });

    expect(
      await rejection(
        cf.dispatchScripts.upload(NS, "s", {
          metadata: metadata({ assets: { jwt: "forged" } }),
          modules,
        }),
      ),
    ).toMatchObject({ status: 400 });
  });
});

describe("D1 over REST", () => {
  it("creates a database the cf fake also sees, queries and batches against SQLite, deletes it", async () => {
    const { uuid } = await cf.d1.create("acme--todo");
    expect(account.database("acme--todo")).toBeDefined();
    await cf.d1.batch(uuid, [
      { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, done INTEGER)" },
      { sql: "INSERT INTO t (name, done) VALUES (?, ?)", params: ["a", true] },
      { sql: "INSERT INTO t (name, done) VALUES (?, ?)", params: ["b", false] },
    ]);
    expect(
      (await cf.d1.query(uuid, "SELECT name, done FROM t WHERE done = ?", [1])).results,
    ).toEqual([{ name: "a", done: 1 }]);
    expect(account.database("acme--todo").all("SELECT count(*) AS n FROM t")).toEqual([
      { n: 2 },
    ]);

    expect(await rejection(cf.d1.query(uuid, "SELECT * FROM missing"))).toMatchObject({
      status: 400,
      code: 7500,
    });
    // A failing batch is one transaction: nothing of it stays.
    await rejection(
      cf.d1.batch(uuid, [
        { sql: "INSERT INTO t (name) VALUES ('c')" },
        { sql: "INSERT INTO missing VALUES (1)" },
      ]),
    );
    expect(account.database("acme--todo").all("SELECT count(*) AS n FROM t")).toEqual([
      { n: 2 },
    ]);

    await cf.d1.delete(uuid);
    expect(isCloudflareNotFound(await rejection(cf.d1.get(uuid)))).toBe(true);
  });
});

describe("account Workers over REST", () => {
  it("lists, gets and deletes the Workers cf deployed", async () => {
    for (const name of ["every-app-gateway", "todo"]) {
      account.workers.set(name, { versions: ["v1"], config: {}, secrets: {} });
    }
    expect((await cf.workers.list()).map((worker) => worker.name)).toEqual([
      "every-app-gateway",
      "todo",
    ]);
    expect(await cf.workers.get("todo")).toMatchObject({ name: "todo" });
    await cf.workers.delete("todo");
    expect(account.workers.has("todo")).toBe(false);
    expect(isCloudflareNotFound(await rejection(cf.workers.get("todo")))).toBe(true);
  });
});
