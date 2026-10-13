import { describe, expect, it, vi } from "vitest";
import type { syncAppToolsWithGateway } from "@/commands/app/deploy/steps/syncTools";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import type { EventSink } from "@/lib/output/events";
import { syncGatewayAppTools } from "./syncAppTools";

const CREDENTIAL = {
  gatewayUrl: "https://apps.example.com",
  token: "edt_x",
  organizationId: "org-1",
};

function run(
  over: Partial<Parameters<typeof syncGatewayAppTools>[0]> = {},
  rows: () => Promise<Record<string, unknown>[]> = async () => [],
) {
  const lines: string[] = [];
  const out: EventSink = {
    emit: (event) => {
      if ("message" in event && event.message) lines.push(event.message);
    },
    exitCode: 0,
  };
  const queries: D1Statement[] = [];
  const db: D1Database = {
    run: async (statements) => {
      queries.push(...statements);
      return [await rows()];
    },
  };
  const syncApp = vi.fn(
    async (_options: Parameters<typeof syncAppToolsWithGateway>[0]) => null,
  );
  const done = syncGatewayAppTools({
    gatewayUrl: "https://apps.example.com",
    db,
    out,
    verbose: false,
    readCredential: async () => CREDENTIAL,
    syncApp,
    ...over,
  });
  return { done, lines, queries, syncApp };
}

describe("syncGatewayAppTools", () => {
  it("syncs each active app of the deploy token's organization, one request each", async () => {
    const { done, syncApp, lines, queries } = run({}, async () => [
      { app_slug: "chef", hostname: "chef.apps.example.com", worker_name: "every-acme-chef" },
      { app_slug: "todo", hostname: "todo.apps.example.com", worker_name: "every-acme-todo" },
      { app_slug: "broken", hostname: null, worker_name: "every-acme-broken" },
    ]);
    await expect(done).resolves.toBeUndefined();

    expect(queries).toEqual([
      {
        sql: expect.stringContaining(
          "WHERE organization_id = ? AND status = 'active'",
        ),
        params: ["org-1"],
      },
    ]);
    expect(syncApp.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({
        gatewayUrl: "https://apps.example.com",
        appId: "chef",
        mcpUrl: "https://chef.apps.example.com/mcp",
        step: "gateway.tools",
        retryForMs: 20_000,
      }),
      expect.objectContaining({
        appId: "todo",
        mcpUrl: "https://todo.apps.example.com/mcp",
      }),
    ]);
    expect(lines).toContain("Syncing agent tools...");
  });

  it("leaves out apps the deployed version doesn't bind", async () => {
    const { done, syncApp } = run({ boundWorkers: ["every-acme-todo"] }, async () => [
      { app_slug: "chef", hostname: "chef.apps.example.com", worker_name: "every-acme-chef" },
      { app_slug: "todo", hostname: "todo.apps.example.com", worker_name: "every-acme-todo" },
    ]);
    await done;
    expect(syncApp.mock.calls.map(([options]) => options.appId)).toEqual(["todo"]);
  });

  it("does nothing without a deploy token for the gateway", async () => {
    const { done, syncApp, lines, queries } = run({
      readCredential: async () => null,
    });
    await done;
    expect(queries).toEqual([]);
    expect(syncApp).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("never fails the gateway deploy", async () => {
    const { done, syncApp, lines } = run({}, async () => {
      throw new Error("D1 unavailable");
    });
    await expect(done).resolves.toBeUndefined();
    expect(syncApp).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain(
      "Agent tools were not synced (D1 unavailable)",
    );
  });
});
