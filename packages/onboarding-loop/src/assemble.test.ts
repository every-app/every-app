import { describe, expect, it } from "vitest";
import { verdictErrorCodes } from "./assemble";
import { everyappCommandsFrom } from "./parse/eventLog";
import { parseEventLogLine } from "./claim";
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
