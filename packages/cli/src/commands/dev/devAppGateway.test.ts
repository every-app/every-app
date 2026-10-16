import { describe, expect, it, vi } from "vitest";
import type { SessionAuthenticator } from "@every-app/perimeter/dev";
import { createNdjsonSink } from "@/lib/output/events";
import { createDevAppGateway } from "./devAppGateway";
import { registerDevApp } from "./registerDevApp";
const HASH = `sha256:${"a".repeat(64)}`;
const APP_URL = "http://todo.localhost:8787";

/** A stand-in for the app's dev server that speaks the tools contract. */
function devApp() {
  const paths: string[] = [];
  const fetcher = {
    fetch: async (request: Request) => {
      const { pathname } = new URL(request.url);
      paths.push(pathname);
      if (pathname === "/__everyapp/tools/list") {
        return Response.json({
          v: 1,
          sdk: "0.3.0",
          hash: HASH,
          tools: [
            {
              name: "list_todos",
              description: "List todos.",
              risk: "read",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      }
      if (pathname === "/__everyapp/tools/call") {
        return Response.json({
          v: 1,
          catalogHash: HASH,
          result: { content: [{ type: "text", text: "[]" }] },
        });
      }
      return new Response("app page");
    },
  };
  return { fetcher, paths };
}

function gateway(authenticator?: SessionAuthenticator) {
  const app = devApp();
  const handle = createDevAppGateway({
    app: registerDevApp({ id: "todo", name: "Todos" } as never),
    appName: "Todos",
    appUrl: APP_URL,
    appFetcher: app.fetcher,
    authenticator,
    out: createNdjsonSink(() => undefined),
  });
  return { handle, paths: app.paths };
}

function mcp(init: RequestInit & { headers?: Record<string, string> }) {
  return new Request(`${APP_URL}/mcp`, {
    ...init,
    headers: { host: "todo.localhost:8787", ...init.headers },
  });
}

const LIST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});

describe("everyapp dev /mcp", () => {
  it("serves the app's tools through the perimeter, as the dev user", async () => {
    const { handle, paths } = gateway();
    const response = await handle(
      mcp({
        method: "POST",
        headers: {
          authorization: "Bearer epat_dev",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: LIST,
      }),
    );
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(result.tools.map((tool) => tool.name)).toEqual(["list_todos"]);
    expect(paths).toEqual(["/__everyapp/tools/list"]);
  });

  it("answers MCP Inspector's preflight from a localhost origin", async () => {
    const { handle } = gateway();
    const preflight = await handle(
      mcp({
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:6274",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization, content-type, mcp-protocol-version",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:6274",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );

    const foreign = await handle(
      mcp({
        method: "POST",
        headers: {
          origin: "https://evil.example",
          authorization: "Bearer epat_dev",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: LIST,
      }),
    );
    expect(foreign.status).toBe(403);
  });

  it("leaves a credential-less preflight to the perimeter in mirror mode", async () => {
    // Like the real gateway: a preflight carries no credentials, so it is
    // challenged before it could reach the ToolBus.
    const authenticate = vi.fn(async () => null);
    const { handle, paths } = gateway({
      authenticate,
      hasAppAccess: async () => true,
    });
    const preflight = await handle(
      mcp({
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:6274",
          "access-control-request-method": "POST",
        },
      }),
    );
    expect(preflight.status).toBe(401);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(paths).toEqual([]);
  });
});
