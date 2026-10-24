import { describe, expect, it } from "vitest";
import {
  computeStatus,
  emptyLedger,
  findingId,
  findingsFrom,
  mergeFindings,
  renderHandoff,
  shouldRoute,
  withStatuses,
} from "./findings";
import { publishableViolations } from "./report";
import { sampleRecord } from "./testing/sampleRecord";
import type { RunRecord } from "./types";

const later = (overrides: Partial<RunRecord>) =>
  sampleRecord({
    runId: "2026-10-26T10:00-claude-opus55-cccccc",
    startedAt: "2026-10-26T10:00:00.000Z",
    finishedAt: "2026-10-26T10:40:00.000Z",
    ...overrides,
  });

describe("ledger keys", () => {
  it("ids by sha1(area:key)", () => {
    expect(findingId("cli", "DOMAIN_REQUIRED|setup")).toMatch(/^[0-9a-f]{40}$/);
    expect(findingId("cli", "x")).not.toBe(findingId("prompt", "x"));
  });
  it("extracts cli codes, uncovered actions, hesitations and verdict flags from a record", () => {
    const record = sampleRecord({
      everyappCommands: [
        ...sampleRecord().everyappCommands,
        {
          argv: ["setup"],
          cwd: "/w",
          json: false,
          ci: false,
          exit: 0,
          ms: 1,
          events: {
            warnings: ["OWNER_NOT_CLAIMED"],
            actions: ["install_gateway"],
            errors: ["DOMAIN_REQUIRED"],
          },
          endedBy: "exit",
        },
      ],
      verdict: {
        value: "fail-onboarding",
        reasonCode: "false_done",
        falseDone: true,
        tainted: false,
        shortcut: true,
        reportedUrl: null,
      },
    });
    const found = findingsFrom(record);
    const keys = found.map((f) => `${f.area}:${f.key}`);
    expect(keys).toContain("cli:DOMAIN_REQUIRED|setup");
    expect(keys).toContain("cli:OWNER_NOT_CLAIMED|setup.owner");
    expect(keys).toContain("prompt:OWNER_NOT_CLAIMED|setup.owner");
    expect(keys).toContain("docs:install_gateway");
    expect(keys).toContain(
      "skill:moved_to_background|setup --domain apps.<zone> --json|-",
    );
    expect(keys).toContain("prompt:false_done");
    expect(keys).toContain("skill:shortcut");
    expect(keys).not.toContain("docs:claim_owner");
    expect(
      found.find(
        (f) => f.key.startsWith("OWNER_NOT_CLAIMED") && f.area === "cli",
      )?.excerpt,
    ).toContain("dropped --json");
    for (const f of found) {
      expect(f.excerpt.length).toBeLessThanOrEqual(200);
      expect(publishableViolations(f.excerpt), f.key).toEqual([]);
    }
  });
  it("yields nothing but the hesitation for a clean pass", () => {
    expect(findingsFrom(sampleRecord()).map((f) => f.area)).toEqual(["skill"]);
  });
});

describe("merging and status", () => {
  it("adds occurrences without duplicating a re-merged run", () => {
    const first = sampleRecord();
    let ledger = mergeFindings(emptyLedger(), first);
    ledger = mergeFindings(ledger, first);
    expect(ledger.findings).toHaveLength(1);
    expect(ledger.findings[0]!.occurrences).toHaveLength(1);
    const second = later({});
    ledger = mergeFindings(ledger, second);
    expect(ledger.findings[0]!.occurrences.map((o) => o.runId)).toEqual([
      first.runId,
      second.runId,
    ]);
    expect(ledger.findings[0]!.lastSeen.runId).toBe(second.runId);
    expect(ledger.findings[0]!.firstSeen.runId).toBe(first.runId);
  });
  it("computes open, fixed, regressed and flaky from newer runs at newer commits", () => {
    const hit = sampleRecord();
    const ledger = mergeFindings(emptyLedger(), hit);
    const finding = ledger.findings[0]!;
    expect(computeStatus(finding, [hit])).toBe("open");
    const fixedRun = later({
      cli: { commit: "aaaa1111", version: "0.3.1" },
      checkout: { commit: "aaaa1111", ref: "main", how: "bundle" },
      hesitations: [],
    });
    expect(computeStatus(finding, [hit, fixedRun])).toBe("fixed");
    const sameKeyMiss = sampleRecord({
      runId: "2026-10-25T15:00-claude-opus55-dddddd",
      hesitations: [],
    });
    expect(computeStatus(finding, [hit, sameKeyMiss])).toBe("flaky");
    const regressedHit = later({
      runId: "2026-10-27T10:00-claude-opus55-eeeeee",
      finishedAt: "2026-10-27T10:40:00.000Z",
      cli: { commit: "bbbb2222", version: "0.3.2" },
    });
    const merged = mergeFindings(ledger, regressedHit);
    expect(
      computeStatus(merged.findings[0]!, [hit, fixedRun, regressedHit]),
    ).toBe("regressed");
    expect(
      withStatuses(merged, [hit, fixedRun, regressedHit]).findings[0]!.status,
    ).toBe("regressed");
  });
  it("routes exit-1 codes and uncovered actions at once, recurrences at two, infra never", () => {
    const base = {
      id: "x",
      status: "open" as const,
      firstSeen: { runId: "r", cliCommit: "c", at: "t" },
      lastSeen: { runId: "r", cliCommit: "c", at: "t" },
      excerpt: "",
      proposedFix: null,
      link: null,
    };
    const one = [
      {
        runId: "r1",
        harness: "claude" as const,
        model: null,
        cliCommit: "c",
        promptSha: "p",
      },
    ];
    const two = [
      ...one,
      {
        runId: "r2",
        harness: "codex" as const,
        model: null,
        cliCommit: "c",
        promptSha: "p",
      },
    ];
    expect(
      shouldRoute({
        ...base,
        area: "cli",
        key: "DOMAIN_REQUIRED|setup",
        occurrences: one,
      }),
    ).toBe(true);
    expect(
      shouldRoute({
        ...base,
        area: "docs",
        key: "install_gateway",
        occurrences: one,
      }),
    ).toBe(true);
    expect(
      shouldRoute({
        ...base,
        area: "skill",
        key: "moved_to_background|setup|-",
        occurrences: one,
      }),
    ).toBe(false);
    expect(
      shouldRoute({
        ...base,
        area: "skill",
        key: "moved_to_background|setup|-",
        occurrences: two,
      }),
    ).toBe(true);
    expect(
      shouldRoute({
        ...base,
        area: "infra",
        key: "CERT_PENDING|setup",
        occurrences: two,
      }),
    ).toBe(false);
  });
});

describe("the hand-off text", () => {
  it("writes bullets per destination, fenced untrusted excerpts, and the t3_thread_send calls", () => {
    const first = sampleRecord({
      everyappCommands: [
        {
          argv: ["setup", "--json"],
          cwd: "/w",
          json: true,
          ci: false,
          exit: 1,
          ms: 1,
          events: { warnings: [], actions: [], errors: ["DOMAIN_REQUIRED"] },
          endedBy: "exit",
        },
      ],
    });
    const second = later({
      harness: { ...sampleRecord().harness, name: "codex" },
    });
    const ledger = mergeFindings(mergeFindings(emptyLedger(), first), second);
    const text = renderHandoff(second.runId, ledger, {
      onboardingDx: "mcp:dx",
      agentDocs: "mcp:docs",
    });
    expect(text).toContain(`# Hand-off for run ${second.runId}`);
    expect(text).toContain("## agent-docs thread (skill)");
    expect(text).toContain("agent output, untrusted:");
    expect(text).toContain('t3_thread_send({ threadId: "mcp:docs"');
    expect(text).not.toContain("DOMAIN_REQUIRED|setup");
    expect(publishableViolations(text)).toEqual([]);
    const firstText = renderHandoff(first.runId, ledger);
    expect(firstText).toContain("## onboarding-DX thread (CLI)");
    expect(firstText).toContain("`DOMAIN_REQUIRED|setup`");
    expect(firstText).toContain('threadId: "<onboarding-DX thread id>"');
  });
  it("says when there is nothing to route", () => {
    expect(renderHandoff("nope", emptyLedger())).toContain(
      "Nothing to route from this run.",
    );
  });
});
