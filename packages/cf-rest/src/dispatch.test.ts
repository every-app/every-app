import { describe, expect, it } from "vitest";
import { createCloudflareRest } from "./index";
import {
  ACCOUNT_ID,
  API,
  envelope,
  mockFetch,
  noSleep,
} from "./test/mockFetch";
import type { WorkerMetadata } from "./types";

function client(fetch: typeof globalThis.fetch) {
  return createCloudflareRest({
    apiToken: "t",
    accountId: ACCOUNT_ID,
    fetch,
    sleep: noSleep,
  });
}

const SCRIPTS = `${API}/workers/dispatch/namespaces/apps/scripts`;

const metadata: WorkerMetadata = {
  main_module: "index.js",
  compatibility_date: "2026-10-01",
  compatibility_flags: ["nodejs_compat"],
  bindings: [
    { type: "d1", name: "DB", id: "db-uuid" },
    { type: "secret_text", name: "API_KEY", text: "s3cret" },
    {
      type: "service",
      name: "EVERYAPP",
      service: "every-app-gateway",
      entrypoint: "AppGateway",
      props: {
        organizationId: "org_1",
        appId: "todo",
        workerName: "acme--todo",
      },
    },
  ],
  limits: { cpu_ms: 50, subrequests: 100 },
  tags: ["org=acme", "app=todo"],
  observability: { enabled: true, head_sampling_rate: 1 },
};

describe("dispatch namespaces", () => {
  it("creates, gets and deletes by name", async () => {
    const { fetch, requests } = mockFetch(
      envelope({ namespace_id: "id-1", namespace_name: "apps" }),
    );
    const cf = client(fetch);
    await expect(cf.dispatchNamespaces.create("apps")).resolves.toMatchObject({
      namespace_name: "apps",
    });
    await cf.dispatchNamespaces.get("apps");
    await cf.dispatchNamespaces.delete("apps");
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST ${API}/workers/dispatch/namespaces`,
      `GET ${API}/workers/dispatch/namespaces/apps`,
      `DELETE ${API}/workers/dispatch/namespaces/apps`,
    ]);
    expect(requests[0]!.headers.get("Content-Type")).toBe("application/json");
    expect(await requests[0]!.json()).toEqual({ name: "apps" });
  });
});

describe("dispatch scripts", () => {
  it("uploads a module Worker as multipart: metadata JSON, then each module with its MIME type", async () => {
    const { fetch, requests } = mockFetch(
      envelope({ id: "acme--todo", etag: "e1" }),
    );
    await expect(
      client(fetch).dispatchScripts.upload("apps", "acme--todo", {
        metadata,
        modules: [
          { name: "index.js", type: "esm", content: "export default {}" },
          { name: "lib.cjs", type: "cjs", content: "module.exports = {}" },
          {
            name: "q.wasm",
            type: "wasm",
            content: new Uint8Array([0, 97, 115, 109]),
          },
          { name: "index.js.map", type: "sourcemap", content: "{}" },
          { name: "words.txt", type: "text", content: "hi" },
          { name: "blob.bin", type: "data", content: new Uint8Array([1, 2]) },
        ],
      }),
    ).resolves.toEqual({ id: "acme--todo", etag: "e1" });

    const request = requests[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`${SCRIPTS}/acme--todo`);
    const contentType = request.headers.get("Content-Type")!;
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(
      contentType,
    )?.[1];
    expect(boundary).toBeTruthy();

    const raw = await request.clone().text();
    const parts = raw.split(`--${boundary}`).slice(1, -1);
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    expect(parts).toHaveLength(7);
    expect(parts[0]).toContain(
      'Content-Disposition: form-data; name="metadata"',
    );
    expect(parts[0]).toContain("Content-Type: application/json");
    expect(parts[1]).toContain('name="index.js"; filename="index.js"');
    expect(parts[1]).toContain("Content-Type: application/javascript+module");

    const form = await request.formData();
    expect(JSON.parse(await (form.get("metadata") as Blob).text())).toEqual(
      metadata,
    );
    expect(
      Object.fromEntries(
        [...form.entries()]
          .filter(([name]) => name !== "metadata")
          .map(([name, file]) => [name, (file as File).type]),
      ),
    ).toEqual({
      "index.js": "application/javascript+module",
      "lib.cjs": "application/javascript",
      "q.wasm": "application/wasm",
      "index.js.map": "application/source-map",
      "words.txt": "text/plain",
      "blob.bin": "application/octet-stream",
    });
    expect(
      new Uint8Array(await (form.get("q.wasm") as File).arrayBuffer()),
    ).toEqual(new Uint8Array([0, 97, 115, 109]));
  });

  it("refuses an upload whose main module isn't among the modules, before sending it", async () => {
    const { fetch, requests } = mockFetch(envelope({}));
    await expect(
      client(fetch).dispatchScripts.upload("apps", "x", {
        metadata,
        modules: [{ name: "worker.js", type: "esm", content: "" }],
      }),
    ).rejects.toThrow(/main_module index.js/);
    await expect(
      client(fetch).dispatchScripts.upload("apps", "x", {
        metadata,
        modules: [
          { name: "index.js", type: "esm", content: "" },
          { name: "index.js", type: "esm", content: "" },
        ],
      }),
    ).rejects.toThrow(/Duplicate module/);
    expect(requests).toHaveLength(0);
  });

  it("refuses tags the API can't store or filter on", async () => {
    const { fetch, requests } = mockFetch(envelope({}));
    const cf = client(fetch);
    await expect(
      cf.dispatchScripts.upload("apps", "x", {
        metadata: { ...metadata, tags: ["a,b"] },
        modules: [{ name: "index.js", type: "esm", content: "" }],
      }),
    ).rejects.toThrow(/Invalid Worker tag/);
    await expect(
      cf.dispatchScripts.setTags("apps", "x", ["org:acme"]),
    ).rejects.toThrow(/Invalid Worker tag/);
    await expect(
      cf.dispatchScripts.addTag("apps", "x", "a&b"),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("refuses more than the 10 tags a script can carry", async () => {
    const { fetch, requests } = mockFetch(envelope({}));
    const cf = client(fetch);
    const eleven = Array.from({ length: 11 }, (_, i) => `t${i}`);
    await expect(
      cf.dispatchScripts.upload("apps", "x", {
        metadata: { ...metadata, tags: eleven },
        modules: [{ name: "index.js", type: "esm", content: "" }],
      }),
    ).rejects.toThrow(/at most 10 tags, not 11/);
    await expect(
      cf.dispatchScripts.patchSettings("apps", "x", { tags: eleven }),
    ).rejects.toThrow(/at most 10 tags/);
    await expect(
      cf.dispatchScripts.setTags("apps", "x", eleven),
    ).rejects.toThrow(/at most 10 tags/);
    expect(requests).toHaveLength(0);

    await cf.dispatchScripts.setTags("apps", "x", eleven.slice(0, 10));
    expect(requests).toHaveLength(1);
  });

  it("reads a script, its bindings and its settings, and deletes it", async () => {
    const { fetch, requests } = mockFetch(envelope({}));
    const cf = client(fetch);
    await cf.dispatchScripts.get("apps", "s");
    await cf.dispatchScripts.bindings("apps", "s");
    await cf.dispatchScripts.getSettings("apps", "s");
    await cf.dispatchScripts.delete("apps", "s");
    await cf.dispatchScripts.delete("apps", "s", { force: true });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${SCRIPTS}/s`,
      `GET ${SCRIPTS}/s/bindings`,
      `GET ${SCRIPTS}/s/settings`,
      `DELETE ${SCRIPTS}/s`,
      `DELETE ${SCRIPTS}/s?force=true`,
    ]);
  });

  it("patches settings as a multipart `settings` JSON part", async () => {
    const { fetch, requests } = mockFetch(envelope({}));
    const settings = {
      bindings: [
        { type: "inherit" as const, name: "DB" },
        { type: "plain_text" as const, name: "MODE", text: "hosted" },
      ],
      limits: { cpu_ms: 30 },
      tags: ["org=acme"],
    };
    await client(fetch).dispatchScripts.patchSettings("apps", "s", settings);
    const request = requests[0]!;
    expect(`${request.method} ${request.url}`).toBe(
      `PATCH ${SCRIPTS}/s/settings`,
    );
    expect(request.headers.get("Content-Type")).toMatch(
      /^multipart\/form-data; boundary=/,
    );
    const part = (await request.formData()).get("settings") as File;
    expect(part.type).toBe("application/json");
    expect(JSON.parse(await part.text())).toEqual(settings);
  });

  it("puts, lists, deletes and bulk-patches secrets", async () => {
    const { fetch, requests } = mockFetch(envelope({}));
    const cf = client(fetch);
    await cf.dispatchScripts.putSecret("apps", "s", "API_KEY", "v1");
    await cf.dispatchScripts.listSecrets("apps", "s");
    await cf.dispatchScripts.deleteSecret("apps", "s", "OLD/KEY");
    await cf.dispatchScripts.patchSecrets("apps", "s", { A: "1", B: null });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `PUT ${SCRIPTS}/s/secrets`,
      `GET ${SCRIPTS}/s/secrets`,
      `DELETE ${SCRIPTS}/s/secrets/OLD%2FKEY`,
      `PATCH ${SCRIPTS}/s/secrets-bulk`,
    ]);
    expect(await requests[0]!.json()).toEqual({
      name: "API_KEY",
      text: "v1",
      type: "secret_text",
    });
    expect(await requests[3]!.json()).toEqual({
      secrets: { A: { name: "A", text: "1", type: "secret_text" }, B: null },
    });
  });

  it("reads, replaces, adds and removes tags", async () => {
    const { fetch, requests } = mockFetch(envelope(["org=acme"]));
    const cf = client(fetch);
    await expect(cf.dispatchScripts.getTags("apps", "s")).resolves.toEqual([
      "org=acme",
    ]);
    await cf.dispatchScripts.setTags("apps", "s", ["org=acme", "app=todo"]);
    await cf.dispatchScripts.addTag("apps", "s", "tier=free");
    await cf.dispatchScripts.removeTag("apps", "s", "tier=free");
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${SCRIPTS}/s/tags`,
      `PUT ${SCRIPTS}/s/tags`,
      `PUT ${SCRIPTS}/s/tags/tier%3Dfree`,
      `DELETE ${SCRIPTS}/s/tags/tier%3Dfree`,
    ]);
    expect(await requests[1]!.json()).toEqual(["org=acme", "app=todo"]);
  });

  it("lists by tag with the API's tag:yes|no filter", async () => {
    const { fetch, requests } = mockFetch(envelope([]));
    const cf = client(fetch);
    await cf.dispatchScripts.list("apps");
    await cf.dispatchScripts.list("apps", {
      "org=acme": true,
      "app=todo": false,
    });
    expect(requests[0]!.url).toBe(SCRIPTS);
    const url = new URL(requests[1]!.url);
    expect(url.searchParams.get("tags")).toBe("org=acme:yes,app=todo:no");
  });

  it("deletes by tag, and only with a required tag", async () => {
    const { fetch, requests } = mockFetch(
      // Documented without an envelope; accepted either way.
      new Response(
        JSON.stringify({
          deleted: [{ id: "s" }],
          deleted_count: 1,
          has_more: false,
        }),
      ),
    );
    const cf = client(fetch);
    await expect(
      cf.dispatchScripts.deleteByTags(
        "apps",
        { "org=acme": true },
        { limit: 50 },
      ),
    ).resolves.toEqual({
      deleted: [{ id: "s" }],
      deleted_count: 1,
      has_more: false,
    });
    const url = new URL(requests[0]!.url);
    expect(requests[0]!.method).toBe("DELETE");
    expect(url.pathname).toBe(new URL(SCRIPTS).pathname);
    expect(url.searchParams.get("tags")).toBe("org=acme:yes");
    expect(url.searchParams.get("limit")).toBe("50");

    await expect(cf.dispatchScripts.deleteByTags("apps", {})).rejects.toThrow(
      /without a required tag/,
    );
    await expect(
      cf.dispatchScripts.deleteByTags("apps", { "org=acme": false }),
    ).rejects.toThrow(/without a required tag/);
    expect(requests).toHaveLength(1);
  });
});
