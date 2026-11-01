import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TOOLS_LIST_PATH } from "@every-app/sdk/internal";
import { defineTools, everyApp } from "@every-app/sdk/server";
import { modernRequest, rpcBody, testKeys } from "../test-fixtures";
import { createDevToolBus, type DevToolBusApp } from "./index";

const DEV_ISSUER = "https://gateway.dev.localhost";
const DEV_USER = {
  sub: "dev-user",
  email: "dev@everyapp.localhost",
  orgId: "dev-org",
  orgRole: "owner",
};

let keys: Awaited<ReturnType<typeof testKeys>>;
beforeAll(async () => {
  keys = await testKeys();
});

function devApp(withTools = true) {
  const listCalls = { count: 0 };
  const app = everyApp(
    async () => new Response("app"),
    { id: "todo" },
    {
      publicKeys: [keys.publicKeyPem],
      issuer: DEV_ISSUER,
      allowDevIdentities: true,
      ...(withTools
        ? {
            tools: defineTools({
              list_todos: {
                description: "List todos.",
                risk: "read",
                input: z.object({}).strict(),
                handler: (_input, { user }) => `todos for ${user.email}`,
              },
            }),
          }
        : {}),
    },
  );
  const target: DevToolBusApp = {
    appId: "todo",
    name: "Todos",
    baseUrl: "http://todo.localhost:8787",
    fetcher: {
      fetch: (request) => {
        if (new URL(request.url).pathname === TOOLS_LIST_PATH) {
          listCalls.count += 1;
        }
        // TODO(integration): PR 2 types everyApp()'s ctx as the runtime ExecutionContext.
        return app.fetch(request, {}, {
          waitUntil: () => undefined,
        } as unknown as ExecutionContext);
      },
    },
  };
  return { target, listCalls };
}

function devBus(target: DevToolBusApp, onCatalogProblem = vi.fn()) {
  return {
    onCatalogProblem,
    bus: createDevToolBus({
      apps: [target],
      privateKeyPem: keys.privateKeyPem,
      issuer: DEV_ISSUER,
      onCatalogProblem,
    }),
  };
}

const devRequest = (method: string, params: Record<string, unknown> = {}) =>
  modernRequest(
    method,
    params,
    { host: "todo.localhost:8787" },
    "http://todo.localhost:8787/mcp",
  );

describe("createDevToolBus", () => {
  it("serves the app's live catalog to the dev user with dev-kid identities", async () => {
    const { target } = devApp();
    const { bus } = devBus(target);

    const list = await bus.serveAppHost(
      devRequest("tools/list"),
      "todo",
      DEV_USER,
    );
    expect((await rpcBody(list!)).result.tools).toEqual([
      expect.objectContaining({ name: "list_todos" }),
    ]);

    const call = await bus.serveAppHost(
      devRequest("tools/call", { name: "list_todos", arguments: {} }),
      "todo",
      DEV_USER,
    );
    expect((await rpcBody(call!)).result.content).toEqual([
      { type: "text", text: "todos for dev@everyapp.localhost" },
    ]);
  });

  it("refetches the catalog after a short cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { target, listCalls } = devApp();
      const { bus } = devBus(target);
      await bus.serveAppHost(devRequest("tools/list"), "todo", DEV_USER);
      await bus.serveAppHost(devRequest("tools/list"), "todo", DEV_USER);
      expect(listCalls.count).toBe(1);
      vi.setSystemTime(Date.now() + 2_001);
      await bus.serveAppHost(devRequest("tools/list"), "todo", DEV_USER);
      expect(listCalls.count).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves /mcp to apps without tools and to apps without the contract", async () => {
    const empty = devBus(devApp(false).target);
    expect(
      await empty.bus.serveAppHost(devRequest("tools/list"), "todo", DEV_USER),
    ).toBeNull();
    expect(empty.onCatalogProblem).not.toHaveBeenCalled();

    const oldSdk = devBus({
      appId: "todo",
      baseUrl: "http://todo.localhost:8787",
      fetcher: {
        fetch: async () =>
          Response.json({ error: "unauthenticated" }, { status: 401 }),
      },
    });
    for (let i = 0; i < 2; i += 1) {
      expect(
        await oldSdk.bus.serveAppHost(
          devRequest("tools/list"),
          "todo",
          DEV_USER,
        ),
      ).toBeNull();
    }
    expect(oldSdk.onCatalogProblem).toHaveBeenCalledOnce();
    expect(oldSdk.onCatalogProblem).toHaveBeenCalledWith(
      "todo",
      expect.stringContaining("SDK 0.3"),
    );
  });

  it("refuses personal tokens without MCP scopes", async () => {
    const { bus } = devBus(devApp().target);
    const response = await bus.serveAppHost(devRequest("tools/list"), "todo", {
      ...DEV_USER,
      credential: { kind: "pat", actor: "pat:t1", scopes: ["todos:read"] },
    });
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: "forbidden",
      reason: "token_scope",
    });
  });
});
