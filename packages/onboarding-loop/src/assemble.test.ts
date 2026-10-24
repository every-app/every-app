import { describe, expect, it } from "vitest";
import { assemble, verdictErrorCodes } from "./assemble";
import { everyappCommandsFrom } from "./parse/eventLog";
import { parseEventLogLine } from "./claim";
import { sampleRecord } from "./testing/sampleRecord";
import type { EventLogLine } from "./types";

const invocation = (pid: number, argv: string[]) =>
  JSON.stringify({
    type: "invocation",
    pid,
    ts: "t",
    argv: ["node", "cli.js", ...argv],
    cwd: "/work/every-app",
    json: true,
    isatty: { stdin: false, stdout: false, stderr: false },
    ci: false,
  });
const event = (pid: number, fields: Record<string, unknown>) =>
  JSON.stringify({ v: 1, ts: "t", pid, ...fields });
const exit = (pid: number, code: number) =>
  JSON.stringify({ type: "exit", pid, ts: "t", code, ms: 10 });

const traces = (lines: string[]) =>
  everyappCommandsFrom(
    lines.flatMap((line) => {
      const parsed = parseEventLogLine(line);
      return parsed ? [parsed as EventLogLine] : [];
    }),
  );

describe("verdictErrorCodes", () => {
  it("ignores an exploratory status before setup and a deploy that was corrected; the last setup/create/deploy/access decide", () => {
    const lines = [
      invocation(1, ["status", "--json"]),
      event(1, { type: "error", code: "GATEWAY_NOT_FOUND", message: "none" }),
      exit(1, 1),
      invocation(2, ["setup", "--domain", "apps.x.com", "--json"]),
      event(2, { type: "done", data: {} }),
      exit(2, 0),
      invocation(3, ["deploy", "--json"]),
      event(3, { type: "error", code: "NOT_AN_APP_FOLDER", message: "x" }),
      exit(3, 1),
      invocation(4, ["deploy", "--json"]),
      event(4, { type: "done", data: { url: "https://hello.apps.x.com" } }),
      exit(4, 0),
    ];
    expect(verdictErrorCodes(traces(lines))).toEqual([]);
  });
  it("keeps a non-infra error from the last run of a verdict command and drops an infra one", () => {
    const lines = [
      invocation(1, ["setup", "--json"]),
      event(1, { type: "error", code: "DOMAIN_REQUIRED", message: "x" }),
      exit(1, 1),
      invocation(2, ["create", "hello", "--json"]),
      event(2, { type: "error", code: "CfTimeoutError", message: "x" }),
      exit(2, 1),
    ];
    expect(verdictErrorCodes(traces(lines))).toEqual(["DOMAIN_REQUIRED"]);
  });
});

/** The record and decision from an event log alone: a run that ended on the harness's BLOCKED, no verifier. */
function assembleFrom(lines: string[]) {
  return assemble({
    seed: sampleRecord(),
    startedAt: "2026-10-25T14:02:00.000Z",
    finishedAt: "2026-10-25T14:10:00.000Z",
    eventLog: lines.flatMap((line) => {
      const parsed = parseEventLogLine(line);
      return parsed ? [parsed as EventLogLine] : [];
    }),
    processes: [],
    exits: [{ exitCode: 1, signal: null, durationMs: 1000, killed: false }],
    resumes: [],
    turns: { terminal: "blocked", fixtureCode: null },
    user: null,
    claim: {
      how: "none",
      linkEmittedAt: null,
      claimedAt: null,
      latencyS: null,
      harnessSelfClaimed: false,
    },
    verify: null,
    preflight: { ok: true, reasonCode: null },
    preRunPlanTotal: 0,
    driverErrors: [],
    exposure: {
      cf_token: 0,
      provider_key: 0,
      est_link: 0,
      owner_password: 0,
      bearer: 0,
    },
    statsPeakMiB: null,
    memoryLimitMiB: 6144,
    withAccess: false,
    team: null,
    gatewayOrigin: "https://apps.x.com",
    verifierInconclusive: false,
    dnsNegativeCache: false,
    extraPhases: [],
    toolEnv: null,
    driverFailure: null,
  });
}

describe("assemble reads the CLI's error message, not only its code", () => {
  const setupFailed = (message: string) => [
    invocation(1, ["setup", "--domain", "apps.x.com", "--json"]),
    event(1, { type: "error", code: "GATEWAY_BUILD_FAILED", message }),
    exit(1, 1),
  ];
  it("a Cloudflare 5xx inside a setup error is fail-infra cloudflare_5xx, and errors[] says so", () => {
    const { record } = assembleFrom(
      setupFailed(
        "Uploading the Gateway failed\ncf deploy: Cloudflare API 502 Bad Gateway",
      ),
    );
    expect(record.verdict).toMatchObject({
      value: "fail-infra",
      reasonCode: "cloudflare_5xx",
    });
    expect(record.errors).toEqual([
      {
        code: "GATEWAY_BUILD_FAILED",
        step: "setup",
        source: "infra",
        message:
          "GATEWAY_BUILD_FAILED from everyapp setup --domain apps.x.com --json (exit 1): Uploading the Gateway failed\ncf deploy: Cloudflare API 502 Bad Gateway",
      },
    ]);
  });
  it("a timed-out upload is cf_timeout from the message alone", () => {
    const { record } = assembleFrom(
      setupFailed("cf workers deploy timed out after 120s"),
    );
    expect(record.verdict).toMatchObject({
      value: "fail-infra",
      reasonCode: "cf_timeout",
    });
  });
  it("a plain build tail is the product's: fail-onboarding everyapp_error:<CODE>, even when it names @cloudflare and counts 524 modules", () => {
    const tail = [
      "Building the Gateway failed",
      "pnpm run build:release exited with code 1",
      "> vite build",
      "✓ 524 modules transformed.",
      "[@cloudflare/vite-plugin] prerender: Error: connect ECONNREFUSED 127.0.0.1:50321",
    ].join("\n");
    const { record, decision } = assembleFrom(setupFailed(tail));
    expect(decision.everyappErrorCodes).toEqual(["GATEWAY_BUILD_FAILED"]);
    expect(record.verdict).toMatchObject({
      value: "fail-onboarding",
      reasonCode: "everyapp_error:GATEWAY_BUILD_FAILED",
    });
    expect(record.errors[0]).toMatchObject({
      source: "cli",
      message: expect.stringContaining("524 modules transformed"),
    });
    expect(record.everyappCommands[0]).toMatchObject({
      exit: 1,
      events: { errors: ["GATEWAY_BUILD_FAILED"] },
    });
  });
  it("keeps 500 characters of a long message", () => {
    const { record } = assembleFrom(setupFailed("x".repeat(2000)));
    expect(record.errors[0]!.message).toHaveLength(500);
  });
});
