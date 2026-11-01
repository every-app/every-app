/**
 * EVERYAPP_EVENT_LOG: the sinks tee each event to the file it names, and a
 * process brackets them with its invocation and exit (run as a child
 * against dist/, when it is built).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHumanSink, createNdjsonSink } from "./events";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/index.js");

const dirs: string[] = [];
afterEach(() => {
  delete process.env["EVERYAPP_EVENT_LOG"];
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A fresh log path in a temp dir of its own, named in the environment. */
function logPath(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-event-log-")));
  dirs.push(dir);
  const file = path.join(dir, "events.ndjson");
  process.env["EVERYAPP_EVENT_LOG"] = file;
  return file;
}

function lines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("EVERYAPP_EVENT_LOG", () => {
  it("appends each event the NDJSON sink emits, as its --json line plus the pid", () => {
    const file = logPath();
    expect(fs.existsSync(file)).toBe(false);
    const written: string[] = [];
    const sink = createNdjsonSink(
      (line) => written.push(line),
      () => new Date("2026-10-24T12:00:00.000Z"),
    );
    sink.emit({ type: "step", step: "setup.auth", status: "start" });
    sink.emit({ type: "warning", code: "X", message: "Said once." });
    sink.emit({ type: "warning", code: "X", message: "Said once." });
    sink.emit({ type: "done", data: { gatewayUrl: "https://apps.example.com" }, display: "a table" });

    const logged = lines(file);
    expect(logged.map((line) => ({ ...line, pid: undefined }))).toEqual(
      written.map((line) => ({ ...(JSON.parse(line) as object), pid: undefined })),
    );
    expect(logged).toHaveLength(3);
    expect(logged.every((line) => line["pid"] === process.pid)).toBe(true);
    expect(logged[2]).toEqual({
      v: 1,
      ts: "2026-10-24T12:00:00.000Z",
      type: "done",
      data: { gatewayUrl: "https://apps.example.com", durationMs: 0 },
      pid: process.pid,
    });
    expect("display" in logged[2]!).toBe(false);
    // Created readable by this user only: the owner link in it is a password.
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("logs a run for a person the same way: every event, whatever reached the screen", () => {
    const file = logPath();
    const sink = createHumanSink({ write: () => undefined, writeProblem: () => undefined });
    sink.emit({ type: "step", step: "setup.plan", status: "start", message: "Checking the plan" });
    sink.emit({ type: "progress", step: "setup.plan", message: "bookkeeping, not shown" });
    sink.emit({
      type: "action_required",
      action: "claim_owner",
      step: "setup.owner",
      message: "Open this link to create the owner account",
      data: { url: "https://apps.example.com/setup#token=est_test", waiting: true },
    });
    expect(lines(file)).toEqual([
      expect.objectContaining({ v: 1, type: "step", step: "setup.plan", status: "start" }),
      expect.objectContaining({ type: "progress", message: "bookkeeping, not shown" }),
      expect.objectContaining({
        type: "action_required",
        action: "claim_owner",
        data: { url: "https://apps.example.com/setup#token=est_test", waiting: true },
      }),
    ]);
    expect(lines(file).every((line) => typeof line["ts"] === "string")).toBe(true);
  });

  it("writes nothing when the variable is unset", () => {
    const file = logPath();
    delete process.env["EVERYAPP_EVENT_LOG"];
    createNdjsonSink(() => undefined).emit({ type: "done" });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("says once on stderr that the path can't be written, and the run goes on", () => {
    const file = logPath();
    process.env["EVERYAPP_EVENT_LOG"] = path.join(file, "no-such-dir", "events.ndjson");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sink = createNdjsonSink(() => undefined);
    sink.emit({ type: "step", step: "a", status: "start" });
    sink.emit({ type: "done" });
    expect(sink.exitCode).toBe(0);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(
      /^everyapp: can't write EVERYAPP_EVENT_LOG=.* \(.*\); not logging\n$/,
    );
  });

  // The built CLI as a child: skipped before `pnpm -C packages/cli build` (CI builds first).
  it.skipIf(!fs.existsSync(DIST))(
    "brackets a process's events with its invocation and exit, with or without --json",
    () => {
      const file = logPath();
      const cwd = path.dirname(file);
      const run = (args: string[]) =>
        spawnSync(process.execPath, [DIST, ...args], {
          cwd,
          encoding: "utf8",
          env: { ...process.env, EVERYAPP_EVENT_LOG: file, CI: "", NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });

      const json = run(["no-such-command", "--json"]);
      const human = run(["no-such-command"]);
      expect(json.status).toBeGreaterThan(0);
      expect(human.status).toBe(json.status);

      const logged = lines(file);
      const [invocation, event, exit] = logged;
      expect(logged).toHaveLength(6);
      expect(invocation).toEqual({
        type: "invocation",
        ts: expect.any(String),
        argv: ["no-such-command", "--json"],
        cwd,
        json: true,
        isatty: { stdin: false, stdout: false, stderr: false },
        ci: false,
        pid: expect.any(Number),
      });
      expect(event).toEqual(
        expect.objectContaining({ v: 1, type: "error", retryable: false, pid: invocation!["pid"] }),
      );
      // stdout carries the same event without the log's pid; the two are stamped
      // separately, so their ts may differ by a millisecond.
      const { pid: _pid, ts: _ts, ...stable } = event as Record<string, unknown>;
      expect(JSON.parse(json.stdout.trim())).toEqual({ ...stable, ts: expect.any(String) });
      expect(exit).toEqual({
        type: "exit",
        ts: expect.any(String),
        code: json.status,
        ms: expect.any(Number),
        pid: invocation!["pid"],
      });

      // Without --json the person saw lines on stderr; the log got the same event.
      expect(human.stdout).toBe("");
      expect(human.stderr).not.toBe("");
      expect(logged[3]).toEqual(expect.objectContaining({ type: "invocation", json: false }));
      expect(logged[4]).toEqual({ ...event, ts: expect.any(String), pid: logged[3]!["pid"] });
      expect(logged[5]).toEqual(expect.objectContaining({ type: "exit", code: human.status }));
    },
  );
});
