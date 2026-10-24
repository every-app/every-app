/**
 * The committed report (design 4.10): `docs/onboarding-loop/` holds one
 * whitelisted JSON per run, the findings ledger, and a README with the
 * runs table and the hand-off coverage matrix. A whitelist, never a
 * denylist: committed files carry no zone, account id, gateway host, owner
 * email, session id, raw message, cookie or est_ link, and
 * `assertPublishable` checks every byte before it is written.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRedactor } from "./redact";
import type {
  ExpectedHandoff,
  Finding,
  FindingsLedger,
  PublicRunRecord,
  RunRecord,
} from "./types";

export const REPORT_DIR = "docs/onboarding-loop";

const HANDOFFS: ExpectedHandoff[] = [
  "domain_question",
  "claim_owner",
  "register_workers_subdomain",
  "create_app",
  "ACCESS_TEAM_REQUIRED",
];

/**
 * The hosts a record names that must never reach a committed file: the
 * gateway host from the URL the harness reported, the app host, and every
 * suffix of them down to the registrable zone (`hello.apps.<zone>`,
 * `apps.<zone>`, `<zone>`).
 */
export function hostsOf(record: RunRecord): string[] {
  const hosts = new Set<string>();
  for (const url of [record.verdict.reportedUrl, record.steps.app.url]) {
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const labels = host.split(".");
    for (let i = 0; i <= labels.length - 2; i++)
      hosts.add(labels.slice(i).join("."));
  }
  return [...hosts].sort((a, b) => b.length - a.length);
}

/** The whitelisted projection of a record. Adding a field here is a deliberate edit, checked by report.test.ts. */
export function toPublicRun(
  record: RunRecord,
  hosts: string[] = hostsOf(record),
): PublicRunRecord {
  const reportedUrlMatched =
    record.verdict.reportedUrl === null
      ? null
      : record.verdict.value === "pass" ||
        record.verdict.reasonCode !== "no_done";
  return {
    v: 1,
    runId: record.runId,
    retryOf: record.retryOf,
    startedAt: record.startedAt,
    durationS: record.durationS,
    terminal_reason: record.terminal_reason,
    harness: {
      name: record.harness.name,
      version: record.harness.version,
      model: record.harness.model,
      mode: record.harness.mode,
      permissionBypass: true,
    },
    signal: record.signal,
    cliCommit: record.cli.commit.slice(0, 12),
    checkoutCommit: record.checkout.commit.slice(0, 12),
    promptVariant: record.prompt.variant,
    promptSha: record.prompt.sha256.slice(0, 12),
    imageTag: record.substrate.image.tag.slice(0, 20),
    deviations: record.deviations,
    fixtures: {
      workers_subdomain: record.fixtures.workers_subdomain,
      cert_packs: record.fixtures.cert_packs,
      preRunPlanTotal: record.fixtures.preRunPlanTotal,
    },
    phases: record.phases,
    everyappCommands: record.everyappCommands.map((command) => ({
      argv: command.argv.map((word) => publicArgvWord(word, hosts)),
      json: command.json,
      ci: command.ci,
      exit: command.exit,
      ms: command.ms,
      warnings: command.events.warnings,
      actions: command.events.actions,
      errors: command.events.errors,
    })),
    steps: {
      setup: record.steps.setup,
      claim: {
        how: record.steps.claim.how,
        latencyS: record.steps.claim.latencyS,
        linkSurfacedToPerson: record.steps.claim.linkSurfacedToPerson,
      },
      app: { by: record.steps.app.by, id: record.steps.app.id },
      access: {
        tried: record.steps.access.tried,
        ...(record.steps.access.result
          ? { result: record.steps.access.result }
          : {}),
      },
    },
    handoffs: record.handoffs,
    scriptedUserTurns: record.scriptedUserTurns.map((turn) => ({
      trigger: turn.trigger,
      expected: turn.expected,
    })),
    interventions: record.interventions.map((i) => ({
      source: i.source,
      kind: i.kind,
    })),
    interventionNeeded: record.interventionNeeded,
    hesitations: record.hesitations.map((h) => ({
      kind: h.kind,
      excerpt: scrub(h.excerpt, hosts),
      triage: h.triage,
    })),
    harnessTimeouts: record.harnessTimeouts,
    errors: record.errors.map((e) => ({
      code: e.code,
      step: e.step,
      source: e.source,
    })),
    resumes: record.resumes.map((r) => ({ reason: r.reason, how: r.how })),
    verify: {
      phaseReached: record.verify.phaseReached,
      rows: record.verify.rows,
    },
    verdict: {
      value: record.verdict.value,
      reasonCode: record.verdict.reasonCode,
      falseDone: record.verdict.falseDone,
      tainted: record.verdict.tainted,
      shortcut: record.verdict.shortcut,
      reportedUrlMatched,
    },
    cost: record.cost,
    secret_exposure: {
      cf_token: record.secret_exposure.cf_token,
      provider_key: record.secret_exposure.provider_key,
      setup_link: record.secret_exposure.est_link,
      owner_password: record.secret_exposure.owner_password,
      bearer: record.secret_exposure.bearer,
    },
    versions: record.versions,
  };
}

/** `--domain apps.example.com` → `--domain apps.<zone>`; anything with an @ or a 32-hex id is replaced. */
function publicArgvWord(word: string, hosts: string[] = []): string {
  if (/^apps\.[a-z0-9.-]+$/i.test(word)) return "apps.<zone>";
  if (/^https?:\/\//.test(word)) return "<url>";
  return scrub(word, hosts);
}

/** An everyapp argv as a committed file may carry it (the findings ledger keys on it too). */
export function publicArgv(argv: string[]): string[] {
  return argv.map((word) => publicArgvWord(word));
}

/** The host shapes an agent's text carries: `apps.<zone>` and anything under it, with no host list needed. */
const APPS_HOST = /\b(?:[a-z0-9-]+\.)*apps\.[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi;

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The last line of defence inside a value an agent wrote: every secret shape
 * the redactor knows (keys, bearers, est_ links), ids, emails, URLs,
 * `apps.<host>` names, and the hosts the record itself names (so the
 * registrable zone goes too, wherever it appears).
 */
export function scrub(text: string, hosts: string[] = []): string {
  let out = createRedactor()
    .redact(text.replace(/est_[A-Za-z0-9_-]{20,}/g, "<setup-link>"))
    .replace(/https?:\/\/[^\s)`'"<>]+/g, "<url>")
    .replace(APPS_HOST, "apps.<zone>")
    .replace(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi, "<id>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/@/g, "(at)");
  for (const host of hosts)
    out = out.replace(new RegExp(escapeRegExp(host), "gi"), "<zone>");
  return out;
}

/** What may never appear in a committed file; the test and writeReport both call it. */
export function publishableViolations(
  text: string,
  hosts: string[] = [],
): string[] {
  const violations: string[] = [];
  if (/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i.test(text))
    violations.push("a 32-hex id");
  if (text.includes("@")) violations.push("an @");
  if (/est_/.test(text)) violations.push("an est_ link");
  if (/set-cookie/i.test(text)) violations.push("a set-cookie");
  if (/\bsk-(ant-)?[A-Za-z0-9_-]{8,}/.test(text))
    violations.push("a provider key");
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(text))
    violations.push("a bearer token");
  if (/\bx-api-key\b/i.test(text)) violations.push("an x-api-key");
  for (const host of hosts)
    if (text.toLowerCase().includes(host.toLowerCase()))
      violations.push(`the host ${host.replace(/[a-z0-9]/gi, "x")}`);
  return violations;
}

export function assertPublishable(
  text: string,
  what: string,
  hosts: string[] = [],
): void {
  const violations = publishableViolations(text, hosts);
  if (violations.length > 0)
    throw new Error(
      `${what} is not publishable: it contains ${violations.join(", ")}`,
    );
}

/** `2026-10-25T1402-claude-opus55-a1b2c3.json` */
export function runFileName(run: PublicRunRecord): string {
  const stamp = run.startedAt.slice(0, 16).replace(":", "");
  const suffix = run.runId.split("-").at(-1) ?? "run";
  const model = (
    run.harness.model.resolved ??
    run.harness.model.requested ??
    "none"
  )
    .split("/")
    .pop()!
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 16);
  return `${stamp}-${run.harness.name}-${model || "none"}-${suffix}.json`;
}

const phaseDuration = (run: PublicRunRecord, name: string) => {
  const phase = run.phases.find((p) => p.name === name);
  return phase ? `${phase.durationS}s` : "-";
};

function hesitationsByKind(run: PublicRunRecord): string {
  const counts = new Map<string, number>();
  for (const h of run.hesitations)
    counts.set(h.kind, (counts.get(h.kind) ?? 0) + 1);
  return counts.size === 0
    ? "none"
    : [...counts].map(([kind, n]) => `${kind}×${n}`).join(", ");
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The README's runs table, one row per run, newest first. */
export function renderRunsTable(runs: PublicRunRecord[]): string {
  const header = [
    // "harness version", not "harness@version": a committed file never contains an @ (the no-@ test).
    "| run | harness version | model (resolved) | mode | cli commit | prompt sha | verdict | reason | phase reached | wall / install / setup / cert / deploy | everyapp cmds ok/err | link→claim s | hesitations by kind | interventions | app by | claim how | terminal reason | cost (source) | signal |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = [...runs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((run) => {
      const ok = run.everyappCommands.filter((c) => c.exit === 0).length;
      const err = run.everyappCommands.filter(
        (c) => c.exit !== null && c.exit !== 0,
      ).length;
      const timings = [
        `${run.durationS}s`,
        phaseDuration(run, "install"),
        phaseDuration(run, "setup"),
        phaseDuration(run, "setup.gateway"),
        phaseDuration(run, "deploy"),
      ].join(" / ");
      const signal = `${run.signal.toolCalls}/${run.signal.toolOutput}/${run.signal.cost}/${run.signal.resume}`;
      return `| ${[
        cell(run.runId),
        cell(`${run.harness.name} ${run.harness.version}`),
        cell(run.harness.model.resolved ?? run.harness.model.requested ?? "-"),
        cell(run.harness.mode ?? "-"),
        cell(run.cliCommit),
        cell(run.promptSha),
        cell(run.verdict.value),
        cell(run.verdict.reasonCode ?? "-"),
        cell(run.verify.phaseReached),
        cell(timings),
        cell(`${ok}/${err}`),
        cell(run.steps.claim.latencyS),
        cell(hesitationsByKind(run)),
        cell(run.interventions.length),
        cell(run.steps.app.by),
        cell(run.steps.claim.how),
        cell(run.terminal_reason),
        cell(
          run.cost.usd === null
            ? `- (${run.cost.source})`
            : `$${run.cost.usd.toFixed(2)} (${run.cost.source})`,
        ),
        cell(signal),
      ].join(" | ")} |`;
    });
  return [...header, ...rows].join("\n");
}

/** Hand-off × harness: exercised / skipped because / failed, so silence is never read as success. */
export function renderCoverageMatrix(runs: PublicRunRecord[]): string {
  const harnesses = [...new Set(runs.map((run) => run.harness.name))].sort();
  const header = [
    `| hand-off | ${harnesses.join(" | ")} |`,
    `| --- |${harnesses.map(() => " --- |").join("")}`,
  ];
  const rows = HANDOFFS.map((handoff) => {
    const cells = harnesses.map((harness) => {
      const mine = runs.filter((run) => run.harness.name === harness);
      const exercised = mine.filter((run) =>
        run.handoffs.exercised.includes(handoff),
      ).length;
      if (exercised > 0) return `exercised ${exercised}/${mine.length}`;
      const reasons = [
        ...new Set(
          mine
            .map((run) => run.handoffs.skippedBecause[handoff])
            .filter((r): r is string => typeof r === "string"),
        ),
      ];
      return reasons.length ? `skipped: ${reasons.join(", ")}` : "not seen";
    });
    return `| ${handoff} | ${cells.join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}

function renderFindingsTable(findings: Finding[]): string {
  const header = [
    "| key | area | status | first seen (cli) | last seen (cli) | harness × runs | excerpt | proposed fix | link |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = findings.map((finding) => {
    const byHarness = new Map<string, number>();
    for (const o of finding.occurrences)
      byHarness.set(o.harness, (byHarness.get(o.harness) ?? 0) + 1);
    return `| ${[
      cell(finding.key),
      cell(finding.area),
      cell(finding.status),
      cell(
        `${finding.firstSeen.at.slice(0, 10)} (${finding.firstSeen.cliCommit.slice(0, 8)})`,
      ),
      cell(
        `${finding.lastSeen.at.slice(0, 10)} (${finding.lastSeen.cliCommit.slice(0, 8)})`,
      ),
      cell([...byHarness].map(([h, n]) => `${h}×${n}`).join(", ")),
      cell(scrub(finding.excerpt).slice(0, 200)),
      cell(finding.proposedFix ?? "-"),
      cell(finding.link ?? "-"),
    ].join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}

export function renderReadme(
  runs: PublicRunRecord[],
  ledger: FindingsLedger,
): string {
  const commits = [
    ...new Set(runs.map((run) => `${run.cliCommit} (prompt ${run.promptSha})`)),
  ];
  return [
    "# Onboarding loop: runs",
    "",
    "Written by `pnpm loop report` from the per-run records on the machine that ran the loop",
    "(design: docs/design/2026-10-onboarding-loop.md). Whitelisted fields only: no zone, account,",
    "host, email, session id or raw agent text. Each row names the CLI commit and prompt sha it measured;",
    "compare rows only within the same harness, model, prompt sha, commit and image.",
    "",
    `CLI commits and prompt shas in this table: ${commits.length ? commits.join(", ") : "none yet"}.`,
    "",
    "## Runs",
    "",
    runs.length ? renderRunsTable(runs) : "No runs recorded yet.",
    "",
    "## Hand-off coverage",
    "",
    runs.length ? renderCoverageMatrix(runs) : "No runs recorded yet.",
    "",
    "## Findings",
    "",
    ledger.findings.length
      ? renderFindingsTable(ledger.findings)
      : "No findings yet.",
    "",
    "The ledger is `findings.json`; `pnpm loop findings` renders the hand-off text per destination.",
    "",
  ].join("\n");
}

/** A run whose counters say the token or a provider key was echoed is never committed: ROTATE first, then rerun. */
function secretEchoed(record: RunRecord): boolean {
  return (
    record.secret_exposure.cf_token > 0 ||
    record.secret_exposure.provider_key > 0
  );
}

/**
 * Everything `pnpm loop report` writes under docs/onboarding-loop, each
 * file checked before it lands, against the hosts every record names too.
 * A run that echoed a secret is skipped and named through `onSkip`.
 */
export function writeReport(
  repoRoot: string,
  records: RunRecord[],
  ledger: FindingsLedger,
  onSkip: (runId: string, why: string) => void = () => undefined,
): string[] {
  const dir = join(repoRoot, REPORT_DIR);
  mkdirSync(join(dir, "runs"), { recursive: true });
  const written: string[] = [];
  const hosts = [...new Set(records.flatMap(hostsOf))];
  const committed = records.filter((record) => {
    if (!secretEchoed(record)) return true;
    onSkip(
      record.runId,
      "its secret_exposure counters say the token or a provider key was echoed; roll the value and rerun",
    );
    return false;
  });
  const runs = committed.map((record) => toPublicRun(record, hosts));
  for (const run of runs) {
    const text = `${JSON.stringify(run, null, 2)}\n`;
    const name = runFileName(run);
    assertPublishable(text, `runs/${name}`, hosts);
    writeFileSync(join(dir, "runs", name), text);
    written.push(join(REPORT_DIR, "runs", name));
  }
  const ledgerText = `${JSON.stringify(ledger, null, 2)}\n`;
  assertPublishable(ledgerText, "findings.json", hosts);
  writeFileSync(join(dir, "findings.json"), ledgerText);
  written.push(join(REPORT_DIR, "findings.json"));
  const readme = renderReadme(runs, ledger);
  assertPublishable(readme, "README.md", hosts);
  writeFileSync(join(dir, "README.md"), readme);
  written.push(join(REPORT_DIR, "README.md"));
  const findingsMd = `# Onboarding loop: findings\n\n${ledger.findings.length ? renderFindingsTable(ledger.findings) : "No findings yet."}\n`;
  assertPublishable(findingsMd, "findings.md", hosts);
  writeFileSync(join(dir, "findings.md"), findingsMd);
  written.push(join(REPORT_DIR, "findings.md"));
  return written;
}
