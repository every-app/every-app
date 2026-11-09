import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePromptId, PromptLedger } from "../src/main/calendar/ledger";
import { planReminders, reminderId, startedId } from "../src/main/calendar/planner";

const now = Date.parse("2026-11-02T10:00:00Z");
const tempPath = () => join(mkdtempSync(join(tmpdir(), "everyapp-ledger-")), "prompts.json");
const event = (id: string, minutes: number) => ({
  id,
  title: id,
  start: new Date(now + minutes * 60_000).toISOString(),
  attendees: [{ email: "me", self: true }, { email: "you" }],
});

describe("prompt ids", () => {
  it("parses the planner's ids, including event ids with dots", () => {
    const e = event("abc.def@google.com", 30);
    expect(parsePromptId(reminderId(e))).toEqual({ kind: "meeting", eventId: "abc.def@google.com", startMs: Date.parse(e.start) });
    expect(parsePromptId(startedId(e))).toMatchObject({ kind: "started", eventId: "abc.def@google.com" });
    expect(parsePromptId("call.us.zoom.xos")).toBeUndefined();
    expect(parsePromptId("meeting.x")).toBeUndefined();
    expect(parsePromptId("meeting.x.notanumber")).toBeUndefined();
  });
});

describe("PromptLedger", () => {
  it("remembers delivered and nudged prompts across a restart, so they don't fire again", () => {
    const path = tempPath();
    const soon = event("soon", 0.5); // its one-minute mark has passed: fires now unless delivered
    const first = new PromptLedger(path, () => now).load();
    expect(planReminders([soon], now, first.delivered)).toHaveLength(1);
    first.markDelivered(reminderId(soon));
    first.markNudged(startedId(soon));
    const again = new PromptLedger(path, () => now).load();
    expect(again.delivered.has(reminderId(soon))).toBe(true);
    expect(again.nudged.has(startedId(soon))).toBe(true);
    expect(planReminders([soon], now, again.delivered)).toEqual([]);
  });

  it("drops prompts for meetings that started over a day ago, and junk", () => {
    const path = tempPath();
    const old = event("old", -25 * 60);
    const recent = event("recent", -60);
    writeFileSync(path, JSON.stringify({ delivered: [reminderId(old), reminderId(recent), 5, "call.x"], nudged: "nope" }));
    const ledger = new PromptLedger(path, () => now).load();
    expect([...ledger.delivered]).toEqual([reminderId(recent)]);
    expect(ledger.nudged.size).toBe(0);
  });

  it("starts empty when the file is missing or broken, and works in memory without a path", () => {
    const path = tempPath();
    writeFileSync(path, "{broken");
    expect(new PromptLedger(path).load().delivered.size).toBe(0);
    const memory = new PromptLedger("", () => now).load();
    memory.markDelivered(reminderId(event("a", 10)));
    expect(memory.delivered.size).toBe(1);
  });
});
