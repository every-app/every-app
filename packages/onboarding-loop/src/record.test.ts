import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultRunsRoot,
  emptyRunRecord,
  ensureRunDir,
  listRunRecords,
  modelSlug,
  newRunId,
  readRunRecord,
  RUN_FILES,
  runDir,
  runKeyOf,
  runKeyString,
  validateRunRecord,
  writeRunRecord,
} from "./record";
import { sampleRecord } from "./testing/sampleRecord";

describe("run ids and directories", () => {
  it("names a run by time, harness, model slug and a suffix", () => {
    expect(
      newRunId(
        new Date("2026-10-25T14:02:33.000Z"),
        "claude",
        "claude-opus-5-5-20261001",
        "a1b2c3",
      ),
    ).toBe("2026-10-25T14:02-claude-opus55-a1b2c3");
    expect(
      newRunId(
        new Date("2026-10-25T14:02:33.000Z"),
        "opencode",
        "opencode/glm-5.3-flash",
        "ffffff",
      ),
    ).toBe("2026-10-25T14:02-opencode-glm53flash-ffffff");
    expect(
      newRunId(new Date("2026-10-25T14:02:33.000Z"), "script", null, "000000"),
    ).toBe("2026-10-25T14:02-script-none-000000");
    expect(newRunId(new Date(), "codex", "gpt-5.3-codex")).toMatch(
      /-codex-gpt53codex-[0-9a-f]{6}$/,
    );
  });
  it("slugs models", () => {
    expect(modelSlug("gpt-5.3-codex")).toBe("gpt53codex");
    expect(modelSlug(null)).toBe("none");
  });
  it("lives under ~/.config/everyapp/onboarding-loop/runs unless EVERYAPP_LOOP_HOME says otherwise", () => {
    const before = process.env["EVERYAPP_LOOP_HOME"];
    process.env["EVERYAPP_LOOP_HOME"] = "/tmp/loop-home";
    expect(defaultRunsRoot()).toBe("/tmp/loop-home/runs");
    delete process.env["EVERYAPP_LOOP_HOME"];
    expect(defaultRunsRoot()).toMatch(
      /\.config\/everyapp\/onboarding-loop\/runs$/,
    );
    if (before !== undefined) process.env["EVERYAPP_LOOP_HOME"] = before;
    const root = mkdtempSync(join(tmpdir(), "loop-runs-"));
    const dir = ensureRunDir(root, "2026-10-25T14:02-script-none-000000");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
  it("refuses a run id that could escape the root", () => {
    expect(() => runDir("/r", "../x")).toThrow(/run id/);
    expect(() => runDir("/r", "a/b")).toThrow(/run id/);
  });
});

describe("run.json", () => {
  it("round-trips a valid record with 700/600 modes, atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-runs-"));
    const record = sampleRecord();
    const path = writeRunRecord(root, record);
    expect(path).toBe(join(root, record.runId, RUN_FILES.record));
    expect(statSync(join(root, record.runId)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readRunRecord(root, record.runId)).toEqual(record);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    expect(listRunRecords(root)).toEqual([record]);
    expect(listRunRecords(join(root, "nope"))).toEqual([]);
  });
  it("refuses a record that is not schema v1 and names the field", () => {
    expect(() => validateRunRecord({ ...sampleRecord(), v: 2 })).toThrow(
      /run.json is not schema v1: v/,
    );
    expect(() =>
      validateRunRecord({ ...sampleRecord(), verdict: { value: "maybe" } }),
    ).toThrow(/verdict/);
    const tooLong = sampleRecord();
    tooLong.hesitations[0]!.excerpt = "x".repeat(201);
    expect(() => validateRunRecord(tooLong)).toThrow(/hesitations.0.excerpt/);
    const bad = sampleRecord() as unknown as Record<string, unknown>;
    delete bad["secret_exposure"];
    expect(() => validateRunRecord(bad)).toThrow(/secret_exposure/);
  });
  it("skips unreadable records when listing", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-runs-"));
    writeRunRecord(root, sampleRecord());
    const broken = sampleRecord({
      runId: "2026-10-26T10:00-codex-gpt53codex-bbbbbb",
    });
    writeRunRecord(root, broken);
    const brokenPath = join(root, broken.runId, RUN_FILES.record);
    // Corrupt it after the write.
    require("node:fs").writeFileSync(brokenPath, "{");
    expect(listRunRecords(root).map((r) => r.runId)).toEqual([
      sampleRecord().runId,
    ]);
  });
  it("builds an empty record the schema accepts", () => {
    const sample = sampleRecord();
    const empty = emptyRunRecord({
      runId: "2026-10-25T14:02-claude-opus55-000000",
      startedAt: sample.startedAt,
      accountName: "loop-1",
      harness: sample.harness,
      signal: sample.signal,
      checkout: sample.checkout,
      cli: sample.cli,
      prompt: sample.prompt,
      substrate: sample.substrate,
    });
    expect(() => validateRunRecord(empty)).not.toThrow();
    expect(empty.verdict).toMatchObject({
      value: "fail-infra",
      reasonCode: "inconclusive",
    });
    expect(empty.steps.setup.status).toBe("never_ran");
  });
  it("derives the run key", () => {
    const key = runKeyOf(sampleRecord());
    expect(key).toEqual({
      harness: "claude",
      model: "claude-opus-5-5",
      promptSha256: sampleRecord().prompt.sha256,
      checkoutCommit: "9821d457",
      imageTag: "sha-0f3a9c1d",
    });
    expect(runKeyString(key)).toBe(
      "claude|claude-opus-5-5|b5bb9d8014a0|9821d457|sha-0f3a9c1d",
    );
  });
});
