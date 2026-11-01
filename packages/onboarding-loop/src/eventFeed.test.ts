import { describe, expect, it } from "vitest";
import { createEventFeed } from "./eventFeed";
import type { ScriptedUserInput } from "./types";

const invocation = (pid: number, argv: string[]) =>
  JSON.stringify({
    type: "invocation",
    pid,
    ts: "t",
    argv: ["node", "/work/every-app/packages/cli/dist/cli.js", ...argv],
    cwd: "/work/every-app",
    json: true,
    isatty: { stdin: false, stdout: false, stderr: false },
    ci: false,
  });
const event = (pid: number, fields: Record<string, unknown>) =>
  JSON.stringify({ v: 1, ts: "t", pid, ...fields });
const exit = (pid: number, code: number) =>
  JSON.stringify({ type: "exit", pid, ts: "t", code, ms: 10 });

function feed() {
  const inputs: ScriptedUserInput[] = [];
  const setups: number[] = [];
  const f = createEventFeed({
    onInput: (input) => inputs.push(input),
    onSetupInvocation: (pid) => setups.push(pid),
  });
  return { f, inputs, setups };
}

describe("createEventFeed", () => {
  it("turns a setup's life into setup_started, the actions and errors it emits, and setup_ended with its status", () => {
    const { f, inputs, setups } = feed();
    for (const line of [
      invocation(11, ["setup", "--domain", "apps.x.com", "--json"]),
      event(11, { type: "step", step: "setup.gateway", status: "start" }),
      event(11, {
        type: "action_required",
        action: "claim_owner",
        message: "m",
        data: { url: "u" },
      }),
      event(11, { type: "done", data: {} }),
      exit(11, 0),
    ])
      f.onLine(line);
    expect(inputs).toEqual([
      { kind: "setup_started" },
      { kind: "action_required", action: "claim_owner", data: { url: "u" } },
      { kind: "setup_ended", status: "done" },
    ]);
    expect(setups).toEqual([11]);
    expect(f.lines).toHaveLength(5);
    expect(f.raw).toHaveLength(5);
  });

  it("a setup that stops on an action ends as action_required; one that errors ends as error; a deploy's done is app_deployed", () => {
    const { f, inputs } = feed();
    for (const line of [
      invocation(1, ["setup", "--json"]),
      event(1, {
        type: "action_required",
        action: "upgrade_workers_paid",
        message: "m",
      }),
      exit(1, 2),
      invocation(2, ["setup", "--json"]),
      event(2, {
        type: "error",
        code: "DOMAIN_REQUIRED",
        message: "m",
        retryable: false,
      }),
      exit(2, 1),
      invocation(3, ["deploy", "--json"]),
      event(3, { type: "done", data: { url: "https://hello.apps.x.com" } }),
      exit(3, 0),
      "",
      "not json at all",
    ])
      f.onLine(line);
    expect(
      inputs.map((i) =>
        i.kind === "setup_ended"
          ? `${i.kind}:${i.status}`
          : i.kind === "cli_error"
            ? `${i.kind}:${i.code}`
            : i.kind,
      ),
    ).toEqual([
      "setup_started",
      "action_required",
      "setup_ended:action_required",
      "setup_started",
      "cli_error:DOMAIN_REQUIRED",
      "setup_ended:error",
      "app_deployed",
    ]);
    expect(f.lines).toHaveLength(9);
  });

  it("attributes events without a pid to the process that opened last, and tells concurrent processes apart by pid", () => {
    const { f, inputs } = feed();
    for (const line of [
      invocation(5, ["setup", "--json"]),
      invocation(6, ["status", "--json"]),
      JSON.stringify({
        v: 1,
        ts: "t",
        type: "error",
        code: "X",
        message: "m",
        retryable: false,
      }),
      exit(6, 0),
      event(5, { type: "done", data: {} }),
      exit(5, 0),
    ])
      f.onLine(line);
    expect(inputs).toEqual([
      { kind: "setup_started" },
      { kind: "cli_error", code: "X" },
      { kind: "setup_ended", status: "done" },
    ]);
  });
  it("names the setups still in flight, and marks one the driver found dead as ended killed", () => {
    const { f, inputs } = feed();
    f.onLine(invocation(11, ["setup", "--json"]));
    f.onLine(invocation(12, ["status", "--json"]));
    expect(f.inFlightSetupPids()).toEqual([11]);
    f.markSetupKilled(12);
    f.markSetupKilled(11);
    expect(f.inFlightSetupPids()).toEqual([]);
    expect(inputs.at(-1)).toEqual({ kind: "setup_ended", status: "killed" });
    // A later exit line for it is nothing: the process is already accounted for.
    f.onLine(exit(11, 137));
    expect(inputs.filter((i) => i.kind === "setup_ended")).toHaveLength(1);
  });
});
