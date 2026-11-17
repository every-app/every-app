/**
 * `everyapp telemetry`: which Gateway tool each form calls, and what a
 * person reads. The report and the switch are the Gateway's
 * (apps/every-app-gateway/src/server/telemetry/telemetry.sqlite.test.ts).
 */
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayApi, JsonObject } from "@/lib/gatewayApi";

const calls: Array<[string, JsonObject]> = [];
let answer: JsonObject = {};

vi.mock("@/lib/gatewayApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gatewayApi")>()),
  openGatewayApi: async (): Promise<GatewayApi> => ({
    gateway: "https://apps.example.com",
    call: async (name, args = {}) => {
      calls.push([name, args]);
      return answer;
    },
    list: async () => [],
  }),
}));

const { telemetry } = await import(".");

const lines: string[] = [];
beforeEach(() => {
  calls.length = 0;
  lines.length = 0;
  vi.stubEnv("CI", "");
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const printed = () => stripVTControlCharacters(lines.join(""));
const done = () => lines.map((line) => JSON.parse(line) as JsonObject).find((event) => event["type"] === "done")!;

const REPORT = { schema: 1, install: "5f0c1e9a7b3d4e21a8c6d2f4b9e07a13", day: "2026-11-20", members: 7 };
const WAITING = {
  usageReports: "on",
  reason: null,
  canChange: true,
  startsAt: "2026-11-23T12:00:00.000Z",
  notice: { headline: "Usage reports start on 23 November for this Gateway.", detail: "Once a day it will send Every App a few rounded counts." },
  nextReport: REPORT,
  lastReport: null,
  lastReportedDay: null,
};

describe("everyapp telemetry", () => {
  it("shows where things stand, the exact next report and how to turn it off", async () => {
    answer = WAITING;
    await telemetry({});
    expect(calls).toEqual([["everyapp_workspace_telemetry_show", {}]]);
    expect(printed()).toBe(
      [
        "Usage reports are on",
        "",
        "Usage reports start on 23 November for this Gateway.",
        "",
        "The next report, exactly as it is sent:",
        ...JSON.stringify(REPORT, null, 2).split("\n"),
        "",
        "Turn them off:  pnpm everyapp telemetry off",
        "",
      ].join("\n"),
    );

    lines.length = 0;
    answer = { ...WAITING, startsAt: null, notice: null, lastReportedDay: "2026-11-20" };
    await telemetry({}, "show");
    expect(printed()).toContain("The last report was for 2026-11-20.");
  });

  it("gives a script the Gateway's whole answer", async () => {
    answer = WAITING;
    await telemetry({ json: true });
    expect(done()).toMatchObject({
      message: "Usage reports are on",
      data: { gateway: "https://apps.example.com", tool: "everyapp_workspace_telemetry_show", usageReports: "on", nextReport: REPORT },
    });
  });

  it("off turns it off and says nothing more is sent", async () => {
    answer = { usageReports: "off", reason: "off", canChange: true, changed: true, nextReport: null };
    await telemetry({}, "off");
    expect(calls).toEqual([["everyapp_workspace_telemetry", { on: false }]]);
    expect(printed()).toBe("✓ Turned off usage reports\n\nNothing more is sent. The random ID the reports carried is deleted.\n");

    lines.length = 0;
    answer = { ...answer, changed: false };
    await telemetry({}, "off");
    expect(printed()).toContain("✓ Usage reports are already off\n");
  });

  it("on turns it on and says when the first report goes", async () => {
    answer = { ...WAITING, changed: true };
    await telemetry({}, "on");
    expect(calls).toEqual([["everyapp_workspace_telemetry", { on: true }]]);
    expect(printed()).toBe("✓ Turned on usage reports\n\nUsage reports start on 23 November for this Gateway.\n");
  });

  it("says why nothing is sent when the Gateway can't send", async () => {
    answer = { usageReports: "off", reason: "setting", canChange: false, nextReport: null };
    await telemetry({});
    expect(printed()).toBe("Usage reports are off\n\nThe TELEMETRY_DISABLED setting is set, so nothing is sent and reports can't be turned on.\n");

    lines.length = 0;
    answer = { usageReports: "off", reason: "unpublished", canChange: true, nextReport: REPORT };
    await telemetry({});
    expect(printed()).toContain("This Gateway was built from source, so it sends nothing.");
    expect(printed()).toContain("Turn them off:  pnpm everyapp telemetry off");

    lines.length = 0;
    answer = { usageReports: "off", reason: "off", canChange: true, nextReport: null };
    await telemetry({});
    expect(printed()).toBe("Usage reports are off\n\nNothing is sent.\n\nTurn them on:  pnpm everyapp telemetry on\n");
  });
});
