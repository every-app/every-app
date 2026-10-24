import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyLedger, mergeFindings } from "./findings";
import {
  assertPublishable,
  publishableViolations,
  REPORT_DIR,
  renderCoverageMatrix,
  renderReadme,
  renderRunsTable,
  runFileName,
  scrub,
  toPublicRun,
  writeReport,
} from "./report";
import {
  SAMPLE_ACCOUNT_ID,
  SAMPLE_EMAIL,
  SAMPLE_ZONE,
  sampleRecord,
} from "./testing/sampleRecord";

describe("the whitelist", () => {
  const record = sampleRecord();
  const run = toPublicRun(record);
  const text = JSON.stringify(run);
  it("drops the zone, the email, the account id, the est_ link, the URL, the session and raw text", () => {
    expect(text).not.toContain(SAMPLE_ZONE);
    expect(text).not.toContain(SAMPLE_EMAIL);
    expect(text).not.toContain(SAMPLE_ACCOUNT_ID);
    expect(text).not.toContain("est_ABC");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("commandLine");
    expect(text).not.toContain("reply");
    expect(publishableViolations(text)).toEqual([]);
  });
  it("keeps what the table needs", () => {
    expect(run).toMatchObject({
      runId: record.runId,
      cliCommit: "9821d457",
      promptSha: "b5bb9d8014a0",
      harness: { name: "claude", version: "2.1.309" },
      verdict: { value: "pass", reportedUrlMatched: true },
    });
    expect(run.everyappCommands[0]!.argv).toEqual([
      "setup",
      "--domain",
      "apps.<zone>",
      "--json",
    ]);
    expect(run.steps.claim).toEqual({
      how: "event-log",
      latencyS: 3,
      linkSurfacedToPerson: false,
    });
    expect(run.hesitations[0]!.excerpt).toContain("<setup-link>");
    expect(run.hesitations[0]!.excerpt).toContain("<email>");
    expect(run.scriptedUserTurns).toEqual([
      { trigger: "domain_question", expected: true },
    ]);
  });
  it("names the file by date, harness, model and suffix", () => {
    expect(runFileName(run)).toBe(
      "2026-10-25T1402-claude-claudeopus55-a1b2c3.json",
    );
  });
});

describe("the no-32-hex / no-@ / no-est_ test", () => {
  it("finds each", () => {
    expect(
      publishableViolations("id 0123456789abcdef0123456789abcdef here"),
    ).toEqual(["a 32-hex id"]);
    expect(publishableViolations("mail owner@x.com")).toEqual(["an @"]);
    expect(publishableViolations("link est_abc")).toEqual(["an est_ link"]);
    expect(publishableViolations("Set-Cookie: a=b")).toEqual(["a set-cookie"]);
    // A 64-hex sha and an 8-char commit are not account ids.
    expect(
      publishableViolations(
        "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c 9821d457",
      ),
    ).toEqual([]);
    expect(() => assertPublishable("owner@x", "README.md")).toThrow(
      /README.md is not publishable: it contains an @/,
    );
  });
  it("scrubs the zone, the gateway host, URLs, apps.<host> names and provider keys out of an excerpt an agent wrote", () => {
    const record = sampleRecord({
      hesitations: [
        {
          kind: "ended_turn_without_done",
          at: "2026-10-25T14:30:00.000Z",
          excerpt: `I ran pnpm everyapp setup --domain apps.${SAMPLE_ZONE} --json and opened https://apps.${SAMPLE_ZONE}/setup#token=est_${"q".repeat(40)}; my domain is ${SAMPLE_ZONE}; key sk-ant-api03-abcdefghijklmnop; Bearer abcdefghijklmnop`,
          precededBy: null,
          triage: "unknown",
        },
      ],
    });
    const run = toPublicRun(record);
    const excerpt = run.hesitations[0]!.excerpt;
    expect(excerpt).not.toContain(SAMPLE_ZONE);
    expect(excerpt).not.toContain("sk-ant-api03");
    expect(excerpt).not.toContain("Bearer abcdef");
    expect(excerpt).toContain("apps.<zone>");
    expect(excerpt).toContain("<url>");
    expect(excerpt).toContain("my domain is <zone>");
    const ledger = mergeFindings(emptyLedger(), record);
    const ledgerText = JSON.stringify(ledger);
    expect(ledgerText).not.toContain(SAMPLE_ZONE);
    expect(ledgerText).not.toContain("sk-ant-api03");
    expect(
      publishableViolations(`fine ... apps.${SAMPLE_ZONE} ...`, [
        `apps.${SAMPLE_ZONE}`,
        SAMPLE_ZONE,
      ]),
    ).toHaveLength(2);
  });
  it("scrubs ids, links and addresses inside a value", () => {
    expect(
      scrub(
        `see ${SAMPLE_ACCOUNT_ID} and ${SAMPLE_EMAIL} and est_${"q".repeat(30)}`,
      ),
    ).toBe("see <id> and <email> and <setup-link>");
  });
});

describe("rendering and writing", () => {
  const records = [
    sampleRecord(),
    sampleRecord({
      runId: "2026-10-25T16:00-codex-gpt53codex-bbbbbb",
      startedAt: "2026-10-25T16:00:00.000Z",
      harness: {
        ...sampleRecord().harness,
        name: "codex",
        version: "0.163.0",
        model: { requested: "gpt-5.3-codex", resolved: null },
      },
      verdict: {
        value: "fail-onboarding",
        reasonCode: "false_done",
        falseDone: true,
        tainted: false,
        shortcut: false,
        reportedUrl: null,
      },
      interventions: [{ at: "t", source: "loop", kind: "nudge" }],
    }),
  ];
  const runs = records.map((record) => toPublicRun(record));
  it("renders one row per run, newest first, with the design's columns", () => {
    const table = renderRunsTable(runs);
    const lines = table.split("\n");
    expect(lines[0]).toContain(
      "| run | harness version | model (resolved) | mode | cli commit | prompt sha | verdict | reason | phase reached |",
    );
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("codex 0.163.0");
    expect(lines[2]).toContain("fail-onboarding | false_done");
    expect(lines[3]).toContain("claude 2.1.309");
    expect(lines[3]).toContain("$7.84 (harness)");
    expect(lines[3]).toContain("moved_to_background×1");
    expect(lines[3]).toContain("2910s / 184s / 540s / 412s / 140s");
  });
  it("renders the hand-off coverage matrix so a skipped hand-off is never silent", () => {
    const matrix = renderCoverageMatrix(runs);
    expect(matrix).toContain(
      "| domain_question | exercised 1/1 | exercised 1/1 |",
    );
    expect(matrix).toContain(
      "| ACCESS_TEAM_REQUIRED | skipped: no --with-access | skipped: no --with-access |",
    );
    expect(matrix).toContain(
      "| register_workers_subdomain | not seen | not seen |",
    );
  });
  it("writes docs/onboarding-loop with every file publishable", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-report-"));
    const ledger = records.reduce((l, r) => mergeFindings(l, r), emptyLedger());
    const written = writeReport(root, records, ledger);
    expect(written).toEqual(
      expect.arrayContaining([
        "docs/onboarding-loop/README.md",
        "docs/onboarding-loop/findings.json",
        "docs/onboarding-loop/findings.md",
        "docs/onboarding-loop/runs/2026-10-25T1402-claude-claudeopus55-a1b2c3.json",
      ]),
    );
    expect(REPORT_DIR).toBe("docs/onboarding-loop");
    const dir = join(root, REPORT_DIR);
    for (const name of [
      "README.md",
      "findings.json",
      "findings.md",
      ...readdirSync(join(dir, "runs")).map((f) => `runs/${f}`),
    ]) {
      expect(
        publishableViolations(readFileSync(join(dir, name), "utf8")),
        name,
      ).toEqual([]);
    }
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("## Runs");
    expect(readme).toContain("## Hand-off coverage");
    expect(readme).toContain("## Findings");
    expect(readme).toContain("9821d457 (prompt b5bb9d8014a0)");
  });
  it("does not commit a run whose counters say the token or a provider key was echoed, and says which", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-report-"));
    const echoed = sampleRecord({
      runId: "2026-10-25T15:02-claude-opus55-e0e0e0",
      secret_exposure: {
        cf_token: 1,
        provider_key: 0,
        est_link: 0,
        owner_password: 0,
        bearer: 0,
      },
    });
    const skipped: string[] = [];
    const written = writeReport(
      root,
      [sampleRecord(), echoed],
      emptyLedger(),
      (runId) => skipped.push(runId),
    );
    expect(skipped).toEqual([echoed.runId]);
    expect(written.filter((f) => f.includes("/runs/"))).toHaveLength(1);
    expect(readdirSync(join(root, REPORT_DIR, "runs"))).toHaveLength(1);
  });
  it("refuses to write a record that smuggles a secret through a whitelisted field", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-report-"));
    const bad = sampleRecord({
      runId: `2026-10-25T14:02-claude-opus55-${"a".repeat(32)}`,
    });
    expect(() => writeReport(root, [bad], emptyLedger())).toThrow(
      /not publishable/,
    );
  });
  it("renders an empty README", () => {
    expect(renderReadme([], emptyLedger())).toContain("No runs recorded yet.");
  });
});
