import { describe, expect, it, vi } from "vitest";
import {
  GatewayApiError,
  OutdatedGatewayError,
  type SyncAppToolsResponse,
} from "@/lib/gateway/api";
import type { EventSink } from "@/lib/output/events";
import { syncAppToolsWithGateway } from "./syncTools";

type Emitted = Parameters<EventSink["emit"]>[0];

const OK: SyncAppToolsResponse = {
  appId: "todo",
  status: "ok",
  toolCount: 4,
  catalogHash: "sha256:abc",
  sdkVersion: "0.3.0",
  warnings: [],
};

const notReady = () =>
  new GatewayApiError({
    message: "binding rolling out",
    status: 503,
    code: "BINDING_NOT_READY",
  });

function run(
  syncAppTools: () => Promise<SyncAppToolsResponse>,
  extra: { verbose?: boolean } = {},
) {
  let clock = 0;
  // Every event, and every message as it comes.
  const events: Emitted[] = [];
  const lines: string[] = [];
  const out: EventSink = {
    emit: (event) => {
      events.push(event);
      if ("message" in event && event.message) lines.push(event.message);
    },
    exitCode: 0,
  };
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const result = syncAppToolsWithGateway({
    gatewayUrl: "https://gateway.example.com",
    appId: "todo",
    mcpUrl: "https://todo.apps.example.com/mcp",
    out,
    client: { syncAppTools: vi.fn(syncAppTools) },
    sleep,
    now: () => clock,
    ...extra,
  });
  // The warnings' codes: a sync that didn't happen is one.
  const warnings = () =>
    events.flatMap((event) => (event.type === "warning" ? [event.code] : []));
  return { result, lines, warnings, sleep };
}

describe("syncAppToolsWithGateway", () => {
  it("reports the synced tool count and the MCP URL", async () => {
    const { result, lines, warnings } = run(async () => OK);
    await expect(result).resolves.toEqual(OK);
    expect(lines.join("\n")).toContain("Agent tools for todo: 4 synced");
    expect(lines.join("\n")).toContain("https://todo.apps.example.com/mcp");
    expect(warnings()).toEqual([]);
  });

  it("waits out a binding that is still rolling out", async () => {
    let attempts = 0;
    const { result, sleep } = run(async () => {
      attempts += 1;
      if (attempts < 3) throw notReady();
      return OK;
    });
    await expect(result).resolves.toEqual(OK);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
  });

  it("gives up after a minute without failing the deploy", async () => {
    const { result, lines, warnings, sleep } = run(async () => {
      throw notReady();
    });
    await expect(result).resolves.toBeNull();
    const waited = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(waited).toBeLessThanOrEqual(60_000);
    expect(waited).toBeGreaterThan(40_000);
    expect(lines.join("\n")).toContain("sync the first time /mcp is used");
    expect(warnings()).toEqual(["TOOLS_SYNC_DEFERRED"]);
  });

  it("explains an outdated gateway and other failures", async () => {
    for (const error of [
      new OutdatedGatewayError(),
      new GatewayApiError({
        message: "Gateway request failed (404)",
        status: 404,
      }),
    ]) {
      const { result, lines, warnings } = run(async () => {
        throw error;
      });
      await expect(result).resolves.toBeNull();
      expect(lines.join("\n")).toContain("everyapp gateway upgrade");
      expect(warnings()).toEqual(["GATEWAY_OUTDATED"]);
    }

    const { result, lines, warnings } = run(async () => {
      throw new Error("socket hang up");
    });
    await expect(result).resolves.toBeNull();
    expect(lines.join("\n")).toContain(
      "Agent tools for todo were not synced: socket hang up",
    );
    expect(warnings()).toEqual(["TOOLS_NOT_SYNCED"]);
  });

  it("reports catalog problems and skipped tools", async () => {
    const failed = run(async () => ({
      ...OK,
      status: "error",
      toolCount: 0,
      error: "the app answered 500",
      warnings: [],
    }));
    await failed.result;
    expect(failed.lines.join("\n")).toContain("the app answered 500");
    expect(failed.warnings()).toEqual(["TOOLS_NOT_SYNCED"]);

    const warned = run(async () => ({
      ...OK,
      warnings: ["huge_tool: skipped, inputSchema is larger than 20 KB"],
    }));
    await warned.result;
    expect(warned.lines.join("\n")).toContain("todo: huge_tool: skipped");
    expect(warned.warnings()).toEqual(["TOOL_SKIPPED"]);
  });

  it("never fails the deploy on an answer it doesn't understand", async () => {
    const empty = run(async () => ({}) as SyncAppToolsResponse);
    await expect(empty.result).resolves.toBeNull();
    expect(empty.lines.join("\n")).toContain("wasn't understood");

    const noWarnings = run(async () => {
      const { warnings: _warnings, ...rest } = OK;
      return rest as SyncAppToolsResponse;
    });
    await expect(noWarnings.result).resolves.toMatchObject({ status: "ok" });
    expect(noWarnings.lines.join("\n")).toContain(
      "Agent tools for todo: 4 synced",
    );

    const odd = run(async () => ({ ...OK, warnings: 3 as never }));
    await expect(odd.result).resolves.toBeNull();
    expect(odd.lines.join("\n")).toContain(
      "Agent tools for todo were not synced",
    );
  });

  it("stays quiet about apps without tools unless verbose", async () => {
    const quiet = run(async () => ({ ...OK, status: "empty", toolCount: 0 }));
    await quiet.result;
    expect(quiet.lines).toEqual([]);

    const verbose = run(
      async () => ({ ...OK, status: "unsupported", toolCount: 0 }),
      { verbose: true },
    );
    await verbose.result;
    expect(verbose.lines.join("\n")).toContain("@every-app/sdk 0.3");
  });
});
