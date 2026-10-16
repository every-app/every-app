/**
 * `everyapp deploy --gateway <url>` with EVERYAPP_DEPLOY_TOKEN, against a test
 * double of the hosted gateway's deploy API (the API itself is tested end
 * to end in apps/every-app-gateway/src/server/deploy/): the app is built
 * by the fake Cloudflare's `cf build` with the SDK's real everyAppWorker()
 * from the sentinel deploy inputs, and the double reads the multipart
 * upload the CLI sends.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOSTED_DEPLOY_SENTINEL } from "@every-app/perimeter/manifest";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import { deployToGateway, hostedDeployTarget } from "./deployToGateway";

const GATEWAY = "https://app.everyapp.com";
const TOKEN = "epat_deploykey";
const TODO: EveryAppCliManifest = {
  id: "todo",
  name: "Todos",
  resources: { d1: ["DB"], durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }] },
};

type JobStatus = "running" | "succeeded" | "failed";

/** The hosted gateway's deploy API, as far as the CLI meets it. */
class GatewayDouble {
  readonly requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  registered: unknown = null;
  upload: FormData | null = null;
  /** What each answer about the job says, in turn. */
  jobStatuses: JobStatus[] = ["running", "succeeded"];
  jobError: { code: string; message: string } | null = null;
  deployApi = true;

  private job(): Response {
    const status = this.jobStatuses.shift() ?? "succeeded";
    return Response.json({
      job: {
        id: "job-1",
        status,
        error: status === "failed" ? this.jobError : null,
        app: {
          workerName: "every-acme-todo",
          hostname: "todo-acme.everyapp.dev",
          url: "https://todo-acme.everyapp.dev",
          status: status === "succeeded" ? "binding" : "pending",
          versionId: status === "succeeded" ? "etag-1" : null,
        },
      },
    }, { status: 202 });
  }

  readonly fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization"),
    });
    if (url.origin !== GATEWAY || !this.deployApi) {
      return new Response("control plane", { status: 404 });
    }
    if (url.pathname === "/api/v1/deploy-key") {
      return Response.json({ organizationId: "org-acme", userEmail: "alice@example.com", role: "owner" });
    }
    if (url.pathname === "/api/v1/orgs/org-acme/apps" && request.method === "POST") {
      this.registered = await request.json();
      return Response.json(
        { app: { id: "todo", workerName: "every-acme-todo", hostname: "todo-acme.everyapp.dev", status: "pending" } },
        { status: 201 },
      );
    }
    if (url.pathname === "/api/v1/orgs/org-acme/apps/todo/deploys" && request.method === "POST") {
      this.upload = await request.formData();
      return this.job();
    }
    if (url.pathname === "/api/v1/orgs/org-acme/deploys/job-1") return this.job();
    return Response.json({ error: "NOT_FOUND", message: "No such route." }, { status: 404 });
  }) as typeof fetch;
}

let account: FakeCloudflare;
let gateway: GatewayDouble;
let appDir: string;
let events: Array<Record<string, any>>;

function run(overrides: Partial<Parameters<typeof deployToGateway>[0]> = {}) {
  return deployToGateway({
    cwd: appDir,
    manifest: TODO,
    gatewayUrl: GATEWAY,
    token: TOKEN,
    out: createNdjsonSink((line) => events.push(JSON.parse(line))),
    fetch: gateway.fetch,
    createCf: () => account.cf,
    installDeps: async () => undefined,
    sleep: async () => undefined,
    ...overrides,
  });
}

async function part(name: string): Promise<string> {
  const value = gateway.upload?.get(name);
  if (value === null || value === undefined) throw new Error(`no part ${name}`);
  return typeof value === "string" ? value : value.text();
}

beforeEach(() => {
  events = [];
  account = new FakeCloudflare();
  gateway = new GatewayDouble();
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-hosted-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(appDir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "drizzle", "0000_init.sql"), "CREATE TABLE todos (id text PRIMARY KEY);");
  fs.writeFileSync(path.join(appDir, "drizzle", "meta", "_journal.json"), "{}");
  account.apps.set(appDir, TODO);
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe("everyapp deploy --gateway (hosted deploy API)", () => {
  it("registers, builds with the sentinel inputs, uploads and follows the job", async () => {
    const result = await run();
    expect(result).toEqual({
      liveUrl: "https://todo-acme.everyapp.dev",
      workerName: "every-acme-todo",
      versionId: "etag-1",
      jobId: "job-1",
      status: "succeeded",
    });
    expect(gateway.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v1/deploy-key",
      "POST /api/v1/orgs/org-acme/apps",
      "POST /api/v1/orgs/org-acme/apps/todo/deploys",
      "GET /api/v1/orgs/org-acme/deploys/job-1",
    ]);
    expect(gateway.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(gateway.registered).toEqual({ appId: "todo", manifest: TODO });

    // Placeholders only, for the deployer to rewrite.
    const worker = JSON.parse(await part("worker"));
    expect(worker.name).toBe(HOSTED_DEPLOY_SENTINEL.workerName);
    expect(worker.env.EVERYAPP_AUDIENCE.value).toBe(HOSTED_DEPLOY_SENTINEL.workerName);
    expect(worker.env.EVERY_APP_GATEWAY.props).toEqual({
      organizationId: HOSTED_DEPLOY_SENTINEL.organizationId,
      appId: "todo",
      workerName: HOSTED_DEPLOY_SENTINEL.workerName,
    });
    expect(worker.env.DB.id).toBe(HOSTED_DEPLOY_SENTINEL.d1Id);
    expect(JSON.parse(await part("manifest"))).toEqual(TODO);
    expect(JSON.parse(await part("stamp"))).toMatchObject({ protocol: 1, cliVersion: expect.any(String) });
    expect(await part("module:index.js")).toBe("export {}");
    expect(await part("module:assets/x.js.map")).toBe("{}");
    expect(await part("migration:0000_init.sql")).toContain("CREATE TABLE todos");
    // The build's inputs never outlive it.
    expect(fs.existsSync(path.join(appDir, ".everyapp", "deploy.json"))).toBe(false);
    expect(events.find((e) => e["step"] === "app.register")?.["data"]).toMatchObject({
      workerName: "every-acme-todo",
      organizationId: "org-acme",
    });
    expect(events.filter((e) => e["type"] === "progress" && e["step"] === "app.upload")).toHaveLength(1);
    // No browser session reaches a third-party host yet: no promise it opens on a visit.
    const done = events.find((e) => e["type"] === "step" && e["step"] === "app.upload" && e["status"] === "ok");
    expect(done?.["message"]).toBe(
      "Deployed version etag-1; todo is at https://todo-acme.everyapp.dev.",
    );
  });

  it("only starts the job with --no-wait", async () => {
    const result = await run({ wait: false });
    expect(result.status).toBe("running");
    expect(gateway.requests.at(-1)?.path).toBe("/api/v1/orgs/org-acme/apps/todo/deploys");
  });

  it("reports a failed job with its code and how to deploy again", async () => {
    gateway.jobStatuses = ["failed"];
    gateway.jobError = { code: "BINDINGS_MISMATCH", message: "Cloudflare lists other bindings." };
    await expect(run()).rejects.toMatchObject({
      code: "BINDINGS_MISMATCH",
      message: "Cloudflare lists other bindings.",
      rerun: `pnpm everyapp deploy --gateway ${GATEWAY}`,
      data: { jobId: "job-1" },
    });
  });

  it("stops before building on a gateway without the deploy API", async () => {
    gateway.deployApi = false;
    await expect(run()).rejects.toMatchObject({ code: "DEPLOY_API_UNAVAILABLE" });
    expect(account.cf.calls.some((call) => call.args[0] === "build")).toBe(false);
  });
});

describe("hostedDeployTarget", () => {
  it("leaves a deploy without EVERYAPP_DEPLOY_TOKEN to the self-host path", () => {
    expect(hostedDeployTarget({ gateway: GATEWAY }, {})).toBeNull();
    expect(hostedDeployTarget({ shared: true }, { EVERYAPP_DEPLOY_TOKEN: " " })).toBeNull();
    // A self-hoster's MCP bearer and gateway selector leave their deploy alone.
    expect(
      hostedDeployTarget({ gateway: GATEWAY }, { EVERYAPP_TOKEN: TOKEN, EVERYAPP_GATEWAY_URL: GATEWAY }),
    ).toBeNull();
  });

  it("needs a gateway URL with EVERYAPP_DEPLOY_TOKEN, and refuses self-host flags", () => {
    expect(() => hostedDeployTarget({}, { EVERYAPP_DEPLOY_TOKEN: TOKEN })).toThrow(
      expect.objectContaining({ code: "GATEWAY_URL_REQUIRED" }),
    );
    expect(() =>
      hostedDeployTarget({ gateway: GATEWAY, shared: true, "force-dns": false }, { EVERYAPP_DEPLOY_TOKEN: TOKEN }),
    ).toThrow(expect.objectContaining({ code: "FLAG_NOT_FOR_HOSTED_DEPLOY", message: expect.stringContaining("--shared is") }));
    expect(hostedDeployTarget({ gateway: GATEWAY }, { EVERYAPP_DEPLOY_TOKEN: TOKEN })).toEqual({
      gatewayUrl: GATEWAY,
      token: TOKEN,
    });
  });
});
