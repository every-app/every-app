import { beforeAll, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import { SYSTEM_HEADER, TOOLS_LIST_PATH } from "@every-app/sdk/internal";
import {
  CATALOG_LIMITS,
  fetchAppCatalog,
  normalizeCatalog,
  type CatalogSnapshot,
} from "./catalog";
import { ISSUER, testKeys } from "./test-fixtures";

const HASH = `sha256:${"b".repeat(64)}`;

function tool(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    description: `Does ${name}.`,
    risk: "read",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

function catalog(tools: unknown[], extra: Record<string, unknown> = {}) {
  return { v: 1, sdk: "0.3.0", hash: HASH, tools, ...extra };
}

function served(snapshot: CatalogSnapshot) {
  if ("error" in snapshot) throw new Error(snapshot.error);
  return snapshot;
}

describe("normalizeCatalog", () => {
  it("keeps valid tools and reports ok, or empty when there are none", () => {
    const snapshot = served(
      normalizeCatalog(
        "todo",
        catalog([tool("list_todos")], { instructions: "Be brief." }),
      ),
    );
    expect(snapshot).toMatchObject({
      status: "ok",
      hash: HASH,
      sdkVersion: "0.3.0",
      instructions: "Be brief.",
      warnings: [],
    });
    expect(snapshot.tools).toEqual([
      {
        name: "list_todos",
        description: "Does list_todos.",
        risk: "read",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    expect(normalizeCatalog("todo", catalog([])).status).toBe("empty");
  });

  it("refuses responses that aren't a v1 catalog", () => {
    for (const body of [
      undefined,
      { v: 2, sdk: "x", hash: HASH, tools: [] },
      { v: 1, sdk: "x", hash: "md5:abc", tools: [] },
      { v: 1, hash: HASH, tools: [] },
      { v: 1, sdk: "x", hash: HASH, tools: {} },
    ]) {
      expect(normalizeCatalog("todo", body).status).toBe("error");
    }
  });

  it("skips tools that break the limits, with a warning for each", () => {
    const long = "a".repeat(48);
    const snapshot = served(
      normalizeCatalog(
        "a-very-long-application-identifier",
        catalog([
          tool("ok_tool"),
          tool(long),
          tool("BadName"),
          tool("no_description", { description: " " }),
          tool("long_description", {
            description: "x".repeat(CATALOG_LIMITS.descriptionChars + 1),
          }),
          tool("long_title", {
            title: "t".repeat(CATALOG_LIMITS.titleChars + 1),
          }),
          tool("odd_risk", { risk: "admin" }),
          tool("not_object", { inputSchema: { type: "string" } }),
          tool("bad_ref", {
            inputSchema: { type: "object", properties: { a: { $ref: "#/x" } } },
          }),
          tool("huge_schema", {
            inputSchema: {
              type: "object",
              description: "x".repeat(CATALOG_LIMITS.schemaBytes),
            },
          }),
          tool("bad_output", { outputSchema: { type: "array" } }),
          tool("ok_tool"),
        ]),
      ),
    );

    expect(snapshot.tools.map((t) => t.name)).toEqual(["ok_tool"]);
    expect(snapshot.warnings).toEqual([
      expect.stringContaining("longer than 64 characters"),
      expect.stringContaining("BadName: skipped, names must be"),
      "no_description: skipped, no description",
      expect.stringContaining("long_description: skipped"),
      expect.stringContaining("long_title: skipped"),
      'odd_risk: skipped, unknown risk "admin"',
      expect.stringContaining("not_object: skipped, inputSchema must be"),
      expect.stringContaining("bad_ref: skipped, inputSchema is not a usable"),
      expect.stringContaining("huge_schema: skipped, inputSchema is larger"),
      expect.stringContaining("bad_output: skipped, outputSchema must be"),
      "ok_tool: skipped, duplicate name",
    ]);
  });

  it("serves every tool an app has: 300 is a catalog, not a warning", () => {
    // No count per app; what bounds a catalog is each tool's own limits,
    // the response size and the gateway's one atomic write of the snapshot.
    expect(CATALOG_LIMITS).not.toHaveProperty("toolsPerApp");
    const tools = Array.from({ length: 300 }, (_, i) => tool(`tool_${i}`));
    const snapshot = served(normalizeCatalog("todo", catalog(tools)));
    expect(snapshot.status).toBe("ok");
    expect(snapshot.tools).toHaveLength(300);
    expect(snapshot.tools.at(-1)?.name).toBe("tool_299");
    expect(snapshot.warnings).toEqual([]);
  });

  it("keeps at most 100 of the app's own warnings", () => {
    const snapshot = served(
      normalizeCatalog(
        "todo",
        catalog([tool("a")], {
          warnings: Array.from({ length: 150 }, (_, i) => `warning ${i}`),
        }),
      ),
    );
    expect(snapshot.warnings).toHaveLength(CATALOG_LIMITS.warningsMax);
    expect(snapshot.warnings.at(-1)).toBe("warning 99");
  });

  it("strips x-mcp-header hints, defaults the risk to write and keeps known hints", () => {
    const snapshot = served(
      normalizeCatalog(
        "todo",
        catalog([
          tool("route", {
            risk: undefined,
            inputSchema: {
              type: "object",
              properties: { list: { type: "string", "x-mcp-header": "List" } },
            },
            annotations: {
              idempotentHint: true,
              readOnlyHint: true,
              destructiveHint: false,
            },
          }),
        ]),
      ),
    );
    expect(snapshot.tools[0]).toEqual({
      name: "route",
      description: "Does route.",
      risk: "write",
      inputSchema: { type: "object", properties: { list: { type: "string" } } },
      annotations: { idempotentHint: true },
    });
  });

  it("reports the tools the app itself left out", () => {
    const snapshot = served(
      normalizeCatalog(
        "todo",
        catalog([tool("ok_tool"), tool("BadName")], {
          warnings: [
            "find: skipped, input must describe an object",
            42,
            "w".repeat(CATALOG_LIMITS.warningChars + 10),
          ],
        }),
      ),
    );
    expect(snapshot.tools.map((t) => t.name)).toEqual(["ok_tool"]);
    expect(snapshot.warnings).toEqual([
      "find: skipped, input must describe an object",
      "w".repeat(CATALOG_LIMITS.warningChars),
      expect.stringContaining("BadName: skipped"),
    ]);
  });

  it("trims over-long instructions", () => {
    const snapshot = served(
      normalizeCatalog(
        "todo",
        catalog([tool("a")], { instructions: "i".repeat(3000) }),
      ),
    );
    expect(snapshot.instructions).toHaveLength(
      CATALOG_LIMITS.instructionsChars,
    );
    expect(snapshot.warnings).toEqual([
      expect.stringContaining("instructions trimmed"),
    ]);
  });
});

describe("fetchAppCatalog", () => {
  let keys: Awaited<ReturnType<typeof testKeys>>;
  beforeAll(async () => {
    keys = await testKeys();
  });

  const app = {
    appId: "todo",
    audience: "every-acme-todo",
    baseUrl: "https://todo-acme.example.com",
  };
  const fetchWith = (answer: (request: Request) => Response) =>
    fetchAppCatalog(app, {
      signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
      invoke: async (request) => answer(request),
    });

  it("asks the app with a one-purpose system token", async () => {
    let seen: Request | undefined;
    const snapshot = await fetchWith((request) => {
      seen = request;
      return Response.json(catalog([tool("list_todos")]));
    });
    expect(snapshot.status).toBe("ok");
    expect(seen?.method).toBe("POST");
    expect(new URL(seen!.url).pathname).toBe(TOOLS_LIST_PATH);
    expect(await seen!.json()).toEqual({ v: 1 });
    const claims = decodeJwt(seen!.headers.get(SYSTEM_HEADER) ?? "");
    expect(claims).toMatchObject({
      typ: "system",
      purpose: "tools.list",
      aud: "every-acme-todo",
      iss: ISSUER,
    });
  });

  it("tells apps without the contract from apps that failed", async () => {
    const oldSdk = await fetchWith(() =>
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
    expect(oldSdk).toMatchObject({ status: "unsupported" });

    const refused = await fetchWith(() =>
      Response.json(
        { v: 1, error: { code: "unauthenticated", message: "bad issuer" } },
        { status: 401 },
      ),
    );
    expect(refused).toMatchObject({
      status: "error",
      error: expect.stringContaining("bad issuer"),
    });

    const crashed = await fetchWith(
      () => new Response("boom", { status: 500 }),
    );
    expect(crashed).toMatchObject({ status: "error" });

    const huge = await fetchWith(
      () =>
        new Response("[]", {
          headers: {
            "content-length": String(CATALOG_LIMITS.responseBytes + 1),
          },
        }),
    );
    expect(huge).toMatchObject({ status: "error" });
  });

  it("gives up on a catalog whose body stalls", async () => {
    const startedAt = Date.now();
    await expect(
      fetchAppCatalog(app, {
        signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
        timeoutMs: 50,
        invoke: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"v":1,'));
              },
            }),
          ),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("lets an unreachable app's error propagate", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("no binding");
    });
    await expect(
      fetchAppCatalog(app, {
        signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
        invoke,
      }),
    ).rejects.toThrow("no binding");
  });
});
