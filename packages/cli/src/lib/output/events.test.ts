import { describe, expect, it } from "vitest";
import { createHumanSink, createNdjsonSink, type EventSink } from "./events";

const fixedNow = () => new Date("2026-10-12T12:00:00.000Z");

function ndjson() {
  const lines: string[] = [];
  const sink: EventSink = createNdjsonSink(
    (line) => lines.push(line),
    fixedNow,
  );
  const events = () => lines.map((line) => JSON.parse(line) as unknown);
  return { sink, lines, events };
}

describe("createNdjsonSink", () => {
  it("writes one versioned, timestamped JSON object per line", () => {
    const { sink, lines, events } = ndjson();
    sink.emit({ type: "step", step: "auth", status: "start" });
    sink.emit({
      type: "step",
      step: "auth",
      status: "ok",
      data: { email: "a@b.com" },
    });
    sink.emit({
      type: "done",
      data: { gatewayUrl: "https://apps.example.com" },
    });

    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(lines.every((line) => !line.slice(0, -1).includes("\n"))).toBe(true);
    expect(events()).toEqual([
      {
        v: 1,
        ts: "2026-10-12T12:00:00.000Z",
        type: "step",
        step: "auth",
        status: "start",
      },
      {
        v: 1,
        ts: "2026-10-12T12:00:00.000Z",
        type: "step",
        step: "auth",
        status: "ok",
        data: { email: "a@b.com" },
      },
      {
        v: 1,
        ts: "2026-10-12T12:00:00.000Z",
        type: "done",
        data: { gatewayUrl: "https://apps.example.com" },
      },
    ]);
    expect(sink.exitCode).toBe(0);
  });

  it("carries what a person must do in action_required and exits 2", () => {
    const { sink, events } = ndjson();
    sink.emit({
      type: "action_required",
      action: "cloudflare_login",
      message: "Log in to Cloudflare to continue.",
      data: { url: "https://dash.cloudflare.com/device", code: "ABCD-1234" },
    });

    expect(events()[0]).toMatchObject({
      type: "action_required",
      action: "cloudflare_login",
      data: { url: "https://dash.cloudflare.com/device", code: "ABCD-1234" },
    });
    expect(sink.exitCode).toBe(2);
  });

  it("exits 1 after an error unless an action is required", () => {
    const failed = ndjson();
    failed.sink.emit({
      type: "error",
      code: "MIGRATIONS_FAILED",
      message: "boom",
      retryable: false,
    });
    expect(failed.sink.exitCode).toBe(1);

    const blocked = ndjson();
    blocked.sink.emit({
      type: "action_required",
      action: "rerun_interactive",
      message: "Re-run in a terminal.",
    });
    blocked.sink.emit({
      type: "error",
      code: "STRICT_CONFLICT",
      message: "conflict",
      retryable: true,
    });
    expect(blocked.sink.exitCode).toBe(2);
  });
});

describe("createHumanSink", () => {
  it("prints progress and the action URL on stdout, warnings on stderr", () => {
    const lines: string[] = [];
    const problems: string[] = [];
    const sink = createHumanSink(
      (line) => lines.push(line),
      (line) => problems.push(line),
    );
    sink.emit({ type: "step", step: "db", status: "start" });
    sink.emit({
      type: "step",
      step: "db",
      status: "ok",
      message: "Applied 0000_init.sql.",
    });
    sink.emit({
      type: "action_required",
      action: "claim_owner",
      message: "Open the setup link to claim the gateway.",
      data: { url: "https://apps.example.com/setup#token=est_x" },
    });
    sink.emit({ type: "warning", code: "W", message: "Careful." });

    const text = lines.join("\n");
    expect(lines).toHaveLength(3);
    expect(text).toContain("Applied 0000_init.sql.");
    expect(text).toContain("https://apps.example.com/setup#token=est_x");
    expect(problems).toEqual([expect.stringContaining("Careful.")]);
    expect(sink.exitCode).toBe(2);
  });
});
