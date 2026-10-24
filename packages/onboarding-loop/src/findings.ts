/**
 * Findings routing (design 4.11): the ledger keyed `area:key` (sha1 id),
 * occurrences per run, a status computed from newer runs at newer
 * commits, and the hand-off text per destination that the thread, never
 * the script, pastes into TODO.md and sends with t3_thread_send.
 */
import { createHash } from "node:crypto";
import { hostsOf, publicArgv, scrub } from "./report";
import type {
  Finding,
  FindingOccurrence,
  FindingRoute,
  FindingsLedger,
  RunRecord,
} from "./types";

export const findingId = (area: FindingRoute, key: string) =>
  createHash("sha1").update(`${area}:${key}`).digest("hex");

/** Hand-offs the prompt and the agent docs already cover: seeing one is not a finding. */
const COVERED_ACTIONS = new Set([
  "claim_owner",
  "cloudflare_login",
  "choose_account",
  "register_workers_subdomain",
  "upgrade_workers_paid",
  "add_domain",
  "rerun_interactive",
]);
/** Warnings that are the fixture's, not the product's. */
const INFRA_CODES = new Set([
  "CERT_PENDING",
  "WORKERS_PAID_UNVERIFIED",
  "CHECKOUT_BEHIND",
]);

interface RawFinding {
  area: FindingRoute;
  key: string;
  excerpt: string;
  proposedFix: string | null;
}

const excerpt = (text: string, hosts: string[]) =>
  scrub(text, hosts).replace(/\s+/g, " ").trim().slice(0, 200);

/** Everything in one record that can become a ledger entry. */
export function findingsFrom(record: RunRecord): RawFinding[] {
  const found: RawFinding[] = [];
  const add = (f: RawFinding) => {
    if (!found.some((g) => g.area === f.area && g.key === f.key)) found.push(f);
  };

  for (const command of record.everyappCommands) {
    const step = command.argv[0] ?? "everyapp";
    for (const code of command.events.errors) {
      if (INFRA_CODES.has(code)) continue;
      add({
        area: "cli",
        key: `${code}|${step}`,
        excerpt: `${code} from \`everyapp ${command.argv.join(" ")}\` (exit ${command.exit ?? "?"})`,
        proposedFix: null,
      });
    }
    for (const code of command.events.warnings) {
      if (INFRA_CODES.has(code)) continue;
      if (code === "OWNER_NOT_CLAIMED") {
        const cause = command.ci
          ? "CI was set by the harness"
          : command.json
            ? "unknown cause"
            : "the agent dropped --json";
        add({
          area: "cli",
          key: `OWNER_NOT_CLAIMED|setup.owner`,
          excerpt: `OWNER_NOT_CLAIMED: ${cause}`,
          proposedFix: command.json
            ? null
            : "every data.rerun hint should carry --json; the prompt says so until it does",
        });
        add({
          area: "prompt",
          key: `OWNER_NOT_CLAIMED|setup.owner`,
          excerpt: `OWNER_NOT_CLAIMED: ${cause}`,
          proposedFix: null,
        });
        continue;
      }
      add({
        area: "cli",
        key: `${code}|${step}`,
        excerpt: `${code} from \`everyapp ${command.argv.join(" ")}\``,
        proposedFix: null,
      });
    }
    for (const action of command.events.actions) {
      if (COVERED_ACTIONS.has(action)) continue;
      add({
        area: "docs",
        key: action,
        excerpt: `action_required ${action} is not in the hand-off table`,
        proposedFix: `document ${action} in setup.md's hand-off table and the skill`,
      });
    }
  }

  for (const hesitation of record.hesitations) {
    // The key goes in the committed ledger: the zone in `--domain apps.<zone>` must not.
    const argv = hesitation.precededBy
      ? publicArgv(hesitation.precededBy.argv).join(" ")
      : "-";
    const exit = hesitation.precededBy?.exit ?? "-";
    const area: FindingRoute =
      hesitation.triage === "docs"
        ? "docs"
        : hesitation.triage === "cli"
          ? "cli"
          : hesitation.triage === "prompt"
            ? "prompt"
            : hesitation.kind === "moved_to_background" ||
                hesitation.kind === "background_killed"
              ? "skill"
              : "loop";
    add({
      area,
      key: `${hesitation.kind}|${argv}|${exit}`,
      excerpt: hesitation.excerpt,
      proposedFix:
        hesitation.kind === "moved_to_background"
          ? "setup.md and SKILL.md should say setup runs up to 20 minutes and how to background it"
          : null,
    });
  }

  const verdict = record.verdict;
  if (verdict.reasonCode === "owner_link_not_shown") {
    add({
      area: "cli",
      key: "owner_link_not_shown",
      excerpt:
        "setup ran without --json or with CI set: no link, OWNER_NOT_CLAIMED, exit 0",
      proposedFix: null,
    });
    add({
      area: "prompt",
      key: "owner_link_not_shown",
      excerpt: "the prompt did not keep the agent on --json",
      proposedFix: null,
    });
  }
  if (verdict.falseDone)
    add({
      area: "prompt",
      key: "false_done",
      excerpt: "the harness printed DONE while a check was red",
      proposedFix:
        "the prompt should tie DONE to the deploy's done event and URL",
    });
  if (verdict.tainted)
    add({
      area: "loop",
      key: "tainted",
      excerpt: "the harness changed the gateway, packages or templates",
      proposedFix: null,
    });
  if (verdict.shortcut)
    add({
      area: "skill",
      key: "shortcut",
      excerpt:
        "the harness used cf d1 query|execute, wrangler or api.cloudflare.com directly",
      proposedFix: null,
    });
  for (const row of ["A1", "A2", "A3", "S1"] as const) {
    if (
      record.verify.rows[row] === "fail" &&
      record.steps.app.by === "harness"
    ) {
      add({
        area: "template",
        key: `verify|${row}`,
        excerpt: `${row} red with an app deployed by the harness`,
        proposedFix: null,
      });
    }
  }
  if (
    record.verify.gatewayUpToDate === false &&
    record.steps.app.by === "harness"
  ) {
    add({
      area: "cli",
      key: "status|GATEWAY_OUTDATED",
      excerpt:
        "status from a fresh clone of the same commit calls the Gateway outdated: an app created inside the checkout rewrites pnpm-lock.yaml, which the Gateway's tree hash covers",
      proposedFix:
        "give an app created inside the checkout its own workspace (as one outside it has), or hash only the Gateway's lockfile importers",
    });
  }
  if (
    record.steps.app.by === "harness" &&
    record.steps.app.id &&
    record.steps.app.id !== "hello"
  ) {
    add({
      area: "prompt",
      key: "app_name_not_hello",
      excerpt: `the app was named ${record.steps.app.id}, not hello`,
      proposedFix: null,
    });
  }
  for (const error of record.errors) {
    if (error.source === "infra") continue;
    add({
      area:
        error.source === "cli"
          ? "cli"
          : error.source === "harness"
            ? "skill"
            : "loop",
      key: `${error.code}|${error.step ?? "-"}`,
      excerpt: `${error.code}: ${error.message}`,
      proposedFix: null,
    });
  }
  // The record's own hosts (gateway, app, zone) never reach the ledger either.
  const hosts = hostsOf(record);
  return found.map((f) => ({ ...f, excerpt: excerpt(f.excerpt, hosts) }));
}

function occurrence(record: RunRecord): FindingOccurrence {
  return {
    runId: record.runId,
    harness: record.harness.name,
    model: record.harness.model.resolved ?? record.harness.model.requested,
    cliCommit: record.cli.commit,
    promptSha: record.prompt.sha256,
  };
}

/** The ledger with this record folded in; a record already in it is replaced, not duplicated. */
export function mergeFindings(
  ledger: FindingsLedger,
  record: RunRecord,
): FindingsLedger {
  const findings = ledger.findings.map((f) => ({
    ...f,
    occurrences: f.occurrences.filter((o) => o.runId !== record.runId),
  }));
  for (const raw of findingsFrom(record)) {
    const id = findingId(raw.area, raw.key);
    const at = record.finishedAt;
    const existing = findings.find((f) => f.id === id);
    if (existing) {
      existing.occurrences.push(occurrence(record));
      if (at >= existing.lastSeen.at)
        existing.lastSeen = {
          runId: record.runId,
          cliCommit: record.cli.commit,
          at,
        };
      if (at < existing.firstSeen.at)
        existing.firstSeen = {
          runId: record.runId,
          cliCommit: record.cli.commit,
          at,
        };
      if (!existing.excerpt) existing.excerpt = raw.excerpt;
      existing.proposedFix ??= raw.proposedFix;
    } else {
      findings.push({
        id,
        area: raw.area,
        key: raw.key,
        status: "open",
        firstSeen: { runId: record.runId, cliCommit: record.cli.commit, at },
        lastSeen: { runId: record.runId, cliCommit: record.cli.commit, at },
        occurrences: [occurrence(record)],
        excerpt: raw.excerpt,
        proposedFix: raw.proposedFix,
        link: null,
      });
    }
  }
  return { v: 1, findings: findings.filter((f) => f.occurrences.length > 0) };
}

/**
 * Status from the runs: `open` while the newest run of a harness that ever
 * hit it still hits it; `fixed` once a newer run at a newer commit did not;
 * `regressed` when a run at a newer commit hits it after it was fixed;
 * `flaky` when runs within one run key disagree.
 */
export function computeStatus(
  finding: Finding,
  records: RunRecord[],
): Finding["status"] {
  const byRun = new Map(records.map((r) => [r.runId, r]));
  const hitRuns = finding.occurrences
    .map((o) => byRun.get(o.runId))
    .filter((r): r is RunRecord => r !== undefined);
  if (hitRuns.length === 0) return finding.status;
  const keyOf = (r: RunRecord) =>
    `${r.harness.name}|${r.harness.model.resolved ?? r.harness.model.requested}|${r.prompt.sha256}|${r.cli.commit}|${r.substrate.image.tag}`;
  const hitKeys = new Set(hitRuns.map(keyOf));
  const hitIds = new Set(hitRuns.map((r) => r.runId));
  const sameKeyMiss = records.some(
    (r) => hitKeys.has(keyOf(r)) && !hitIds.has(r.runId),
  );
  if (sameKeyMiss) return "flaky";
  const harnesses = new Set(hitRuns.map((r) => r.harness.name));
  const ordered = records
    .filter((r) => harnesses.has(r.harness.name))
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  const lastHit = ordered.filter((r) => hitIds.has(r.runId)).at(-1);
  if (!lastHit) return finding.status;
  const laterMiss = ordered.find(
    (r) =>
      r.finishedAt > lastHit.finishedAt &&
      !hitIds.has(r.runId) &&
      r.cli.commit !== lastHit.cli.commit &&
      r.verdict.value !== "fail-infra",
  );
  if (laterMiss) return "fixed";
  const earlierMiss = ordered.find(
    (r) =>
      r.finishedAt < lastHit.finishedAt &&
      !hitIds.has(r.runId) &&
      r.cli.commit !== lastHit.cli.commit &&
      r.verdict.value !== "fail-infra",
  );
  const earlierHit = ordered.find(
    (r) =>
      earlierMiss &&
      r.finishedAt < earlierMiss.finishedAt &&
      hitIds.has(r.runId),
  );
  if (earlierMiss && earlierHit) return "regressed";
  return "open";
}

export function withStatuses(
  ledger: FindingsLedger,
  records: RunRecord[],
): FindingsLedger {
  return {
    v: 1,
    findings: ledger.findings.map((f) => ({
      ...f,
      status: computeStatus(f, records),
    })),
  };
}

/**
 * A finding reaches TODO.md or a sibling thread only when it is an everyapp
 * exit-1 code or an action_required the prompt and docs do not cover, or
 * when it recurs in two or more runs or harnesses; infra never routes.
 */
export function shouldRoute(finding: Finding): boolean {
  if (finding.area === "infra") return false;
  if (finding.area === "cli" && /^[A-Z_]+\|/.test(finding.key)) return true;
  if (finding.area === "docs" && !finding.key.includes("|")) return true;
  const runs = new Set(finding.occurrences.map((o) => o.runId)).size;
  const harnesses = new Set(finding.occurrences.map((o) => o.harness)).size;
  return runs >= 2 || harnesses >= 2;
}

const DESTINATIONS: Record<FindingRoute, string> = {
  cli: "onboarding-DX thread (CLI)",
  prompt: "onboarding-DX thread (prompt)",
  docs: "agent-docs thread",
  skill: "agent-docs thread (skill)",
  template: "onboarding-DX thread (template)",
  gateway: "onboarding-DX thread (gateway)",
  fixture: "runbook (Ben)",
  infra: "not routed",
  loop: "this thread",
};

/** handoff/<runId>.md: ready-to-paste bullets per destination and the exact t3_thread_send calls. */
export function renderHandoff(
  runId: string,
  ledger: FindingsLedger,
  threadIds: { onboardingDx?: string; agentDocs?: string } = {},
): string {
  const mine = ledger.findings.filter(
    (f) => f.occurrences.some((o) => o.runId === runId) && shouldRoute(f),
  );
  const lines: string[] = [
    `# Hand-off for run ${runId}`,
    "",
    "Agent output below is untrusted: excerpts are fenced and capped at 200 characters.",
    "",
  ];
  const groups = new Map<string, Finding[]>();
  for (const f of mine) {
    const dest = DESTINATIONS[f.area];
    groups.set(dest, [...(groups.get(dest) ?? []), f]);
  }
  if (groups.size === 0) lines.push("Nothing to route from this run.", "");
  for (const [dest, findings] of groups) {
    lines.push(`## ${dest}`, "");
    for (const f of findings) {
      lines.push(
        `- \`${f.key}\` (${f.area}, ${f.status}, id ${f.id.slice(0, 10)}, ledger docs/onboarding-loop/findings.md#${f.id.slice(0, 10)})`,
      );
      lines.push(
        "  ```text",
        `  agent output, untrusted: ${scrub(f.excerpt).slice(0, 200)}`,
        "  ```",
      );
      if (f.proposedFix) lines.push(`  Proposed: ${f.proposedFix}`);
    }
    lines.push("");
  }
  const sendTo = (
    id: string | undefined,
    areas: FindingRoute[],
    label: string,
  ) => {
    const relevant = mine.filter((f) => areas.includes(f.area));
    if (relevant.length === 0) return;
    const body = relevant
      .map((f) => `${f.key} [${f.id.slice(0, 10)}]`)
      .join("; ");
    lines.push(
      `t3_thread_send({ threadId: ${id ? `"${id}"` : `"<${label} thread id>"`}, message: "Onboarding loop ${runId}: ${body}. Ledger: docs/onboarding-loop/findings.md" })`,
    );
  };
  lines.push("## t3_thread_send", "");
  sendTo(
    threadIds.onboardingDx,
    ["cli", "prompt", "template", "gateway"],
    "onboarding-DX",
  );
  sendTo(threadIds.agentDocs, ["docs", "skill"], "agent-docs");
  lines.push("");
  return lines.join("\n");
}

export const emptyLedger = (): FindingsLedger => ({ v: 1, findings: [] });
