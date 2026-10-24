/**
 * From what a run gathered to run.json and the decision (design 4.8, 4.9):
 * a pure function over the seeded record, the event log, the harness's
 * events per process, the scripted user's state, the claimer's result and
 * the verifier's result. `loop reparse` and `loop replay` call it again on
 * the saved artifacts, so nothing here reads a file or a clock.
 */
import { decide, decideInput, classifyInfraError } from "./decide";
import { DECISION_TABLE_VERSION } from "./decide";
import { computeCost, resolvedModel } from "./parse/cost";
import {
  appFrom,
  codesSeen,
  everyappCommandsFrom,
  PARSER_VERSION,
  phasesFrom,
  setupSummary,
  toEveryappCommands,
  type CommandTrace,
} from "./parse/eventLog";
import {
  detectHarnessTimeouts,
  detectHesitations,
  RULES_VERSION,
} from "./parse/hesitations";
import {
  linkSurfacedToPerson,
  printedDone,
  providerErrorAtExit,
} from "./parse/transcript";
import type { ClaimerResult } from "./claim";
import type { DecideInput } from "./decide";
import {
  EXPECTED_HANDOFFS,
  FIXTURE_ACTIONS,
  type ScriptedUserState,
} from "./scriptedUser";
import type { TurnsTerminal } from "./turns";
import { rowStatuses, VERIFIER_VERSION } from "./verify";
import type {
  EventLogLine,
  ExecResult,
  ExpectedHandoff,
  Intervention,
  NormalizedEvent,
  Phase,
  Resume,
  RunError,
  RunRecord,
  SecretExposure,
  TerminalReason,
  VerifyResult,
} from "./types";

export interface AssembleInput {
  /** The seeded record: substrate, checkout, cli, prompt, harness, signal, account, fixtures as known. */
  seed: RunRecord;
  startedAt: string;
  finishedAt: string;
  eventLog: EventLogLine[];
  processes: NormalizedEvent[][];
  exits: ExecResult[];
  resumes: Resume[];
  turns: { terminal: TurnsTerminal; fixtureCode: string | null } | null;
  user: ScriptedUserState | null;
  claim: ClaimerResult;
  verify: VerifyResult | null;
  preflight: { ok: boolean; reasonCode: string | null };
  preRunPlanTotal: number;
  /** Errors the driver itself saw (teardown, sibling, verifier container). */
  driverErrors: RunError[];
  exposure: SecretExposure;
  statsPeakMiB: number | null;
  memoryLimitMiB: number;
  withAccess: boolean;
  team: string | null;
  gatewayOrigin: string;
  /** The verifier's own container or install failed. */
  verifierInconclusive: boolean;
  dnsNegativeCache: boolean;
  /** Phases the driver timed itself (verify, teardown). */
  extraPhases: Phase[];
  /** The harness's CI, TERM and SHELL from /proc/<pid>/environ, when read. */
  toolEnv: RunRecord["toolEnv"] | null;
  /** A driver-level failure that ended the run before the harness could. */
  driverFailure: TerminalReason | null;
  /** `setup` processes the driver found dead with no exit line (the harness killed its background task). */
  backgroundKills?: Array<{ at: string; pid: number }>;
}

/** The commands whose last run decides the verdict; `status` and the rest are read-only and never do. */
const VERDICT_COMMANDS = ["setup", "create", "deploy", "access"];

/** The CLI's message is a build tail at worst; errors[] keeps this much of it. */
const CLI_MESSAGE_LIMIT = 500;

/**
 * An `error` line of the event log as errors[] carries it: the code, the
 * command and its exit, then the message the CLI gave, because that message
 * is where a Cloudflare 5xx or a `timed out after` lives (the code says
 * `GATEWAY_BUILD_FAILED` either way). The verdict probes the same text, so
 * what the signature table reads here is what it read there.
 */
function cliError(
  trace: CommandTrace,
  detail: { code: string; message: string },
): RunError {
  return {
    code: detail.code,
    step: trace.argv[0] ?? null,
    source: "cli",
    message:
      `${detail.code} from everyapp ${trace.argv.join(" ")} (exit ${trace.exit ?? "?"}): ${detail.message}`.slice(
        0,
        CLI_MESSAGE_LIMIT,
      ),
  };
}

/**
 * The error codes that fail the run: those of the last invocation of each of
 * setup, create, deploy and access, non-infra. A `status --json` run before
 * setup (`GATEWAY_NOT_FOUND`) or a `deploy` from the wrong folder that was
 * then corrected is a finding in `errors[]`, not the verdict.
 */
export function verdictErrorCodes(traces: CommandTrace[]): string[] {
  const last = new Map<string, CommandTrace>();
  for (const trace of traces) {
    const name = trace.argv[0] ?? "";
    if (VERDICT_COMMANDS.includes(name)) last.set(name, trace);
  }
  return [...last.values()].flatMap((trace) =>
    trace.events.errorDetails
      .filter((detail) => !classifyInfraError(cliError(trace, detail)))
      .map((detail) => detail.code),
  );
}

const terminalReasonOf = (input: AssembleInput): TerminalReason => {
  if (input.driverFailure) return input.driverFailure;
  if (!input.preflight.ok) return "preflight_failed";
  if (!input.turns) return "driver_error";
  switch (input.turns.terminal) {
    case "done":
      return "completed";
    case "blocked":
      return "blocked";
    case "caps_exceeded":
      return "caps_exceeded";
    case "fixture_error":
      return "fixture_error";
    case "time_cap":
      return "time_cap";
    case "budget":
      return "budget";
    case "no_resume":
      return "harness_exit";
  }
};

/** The `pnpm install` the harness ran, timed from its tool call to its result. */
function installPhase(events: NormalizedEvent[]): Phase | null {
  const index = events.findIndex(
    (event) =>
      event.kind === "tool_call" &&
      // Anywhere in the command: harnesses wrap it (`bash -lc 'pnpm install'`, `cat … && (pnpm install …)`).
      /\b(pnpm|npm|yarn)\b[^&|;]*\binstall\b/.test(
        (event.argv ?? []).join(" "),
      ),
  );
  if (index === -1) return null;
  const call = events[index]!;
  const result = events
    .slice(index + 1)
    .find((event) => event.kind === "tool_result");
  if (!result) return null;
  const start = Date.parse(call.ts ?? call.receivedAt);
  const end = Date.parse(result.ts ?? result.receivedAt);
  return {
    name: "install",
    startedAt: call.ts ?? call.receivedAt,
    durationS: Math.max(0, Math.round((end - start) / 1000)),
  };
}

export function assemble(input: AssembleInput): {
  record: RunRecord;
  decision: DecideInput;
} {
  const seed = input.seed;
  const events = input.processes.flat();
  const traces = everyappCommandsFrom(input.eventLog);
  const everyappCommands = toEveryappCommands(traces);
  const setup = setupSummary(traces);
  const app = appFrom(traces);
  const codes = codesSeen(traces);
  if (input.turns?.fixtureCode && !codes.includes(input.turns.fixtureCode))
    codes.push(input.turns.fixtureCode);
  const resolved = resolvedModel(events) ?? seed.harness.model.requested;

  const cliErrors: RunError[] = traces.flatMap((trace) =>
    trace.events.errorDetails.map((detail) => {
      const error = cliError(trace, detail);
      return classifyInfraError(error) ? { ...error, source: "infra" } : error;
    }),
  );
  const cliWarnings: RunError[] = traces.flatMap((trace) =>
    trace.events.warnings
      .filter((code) => code === "CERT_PENDING")
      .map((code) => ({
        code,
        step: trace.argv[0] ?? null,
        source: "infra" as const,
        message: `${code} from everyapp ${trace.argv.join(" ")}`,
      })),
  );
  const errors = [...cliErrors, ...cliWarnings, ...input.driverErrors];

  const user = input.user;
  const interventions: Intervention[] = [...(user?.interventions ?? [])];
  if (
    input.claim.harnessSelfClaimed &&
    !interventions.some((i) => i.kind === "harness_self_claimed")
  ) {
    interventions.push({
      at: input.finishedAt,
      source: "loop",
      kind: "harness_self_claimed",
    });
  }
  const printed = printedDone(events, input.gatewayOrigin);
  const didPrintDone = user?.done ? true : printed.done;
  const reportedUrl = user?.done?.url ?? printed.url;
  const blocked = user?.blocked ?? null;

  const phases: Phase[] = [
    ...(installPhase(events) ? [installPhase(events)!] : []),
    ...phasesFrom(traces),
    ...input.extraPhases,
  ];

  const expected: ExpectedHandoff[] = [
    "domain_question",
    "claim_owner",
    "create_app",
    ...(input.withAccess ? (["ACCESS_TEAM_REQUIRED"] as const) : []),
  ];
  const exercised = user?.exercised ?? [];
  const skippedBecause: Record<string, string> = {
    cloudflare_login: "api_token",
    upgrade_workers_paid: "runbook",
    add_domain: "runbook",
  };
  if (!input.withAccess)
    skippedBecause["ACCESS_TEAM_REQUIRED"] = "no --with-access";
  if (!exercised.includes("register_workers_subdomain"))
    skippedBecause["register_workers_subdomain"] =
      seed.fixtures.workers_subdomain === "preexisting"
        ? "workers.dev name preexisting"
        : "not asked";
  // The prompt tells the agent to create the app, so create_app is a question only when the
  // agent makes it one; likewise the domain once a reply or the nudge carried it.
  const ranCommand = (name: string) =>
    traces.some((trace) => trace.argv[0] === name);
  if (!exercised.includes("create_app") && ranCommand("create"))
    skippedBecause["create_app"] = "not a question: the harness ran create";
  if (!exercised.includes("domain_question") && ranCommand("setup"))
    skippedBecause["domain_question"] = "not asked: the harness ran setup";
  for (const handoff of EXPECTED_HANDOFFS) {
    if (
      !exercised.includes(handoff) &&
      expected.includes(handoff) &&
      !skippedBecause[handoff]
    )
      skippedBecause[handoff] = "not reached";
  }

  const actionsSeen = traces.flatMap((t) => t.events.actions);
  const unknownHandoff = actionsSeen.some(
    (action) =>
      !(EXPECTED_HANDOFFS as readonly string[]).includes(action) &&
      !FIXTURE_ACTIONS.includes(action) &&
      action !== "rerun_interactive",
  );
  const lastExit = input.exits.at(-1) ?? null;
  const lastProcess = input.processes.at(-1) ?? [];
  const g1 = input.verify?.rows.G1;
  const g1Evidence = g1?.evidence as { status?: number | null } | null;
  const gatewayUnreachable =
    g1?.status === "fail" &&
    !!g1Evidence &&
    typeof g1Evidence === "object" &&
    g1Evidence.status === null;
  const certPendingPast15m =
    codes.includes("CERT_PENDING") && setup.status !== "done";
  const everyappErrorCodes = verdictErrorCodes(traces);

  const decision = decideInput({
    gatewayOrigin: input.gatewayOrigin,
    preflight: {
      ok: input.preflight.ok,
      reason:
        input.preflight.reasonCode === "whoami_gate_failed"
          ? "whoami"
          : input.preflight.reasonCode,
    },
    killed: input.driverFailure === "killed",
    driverError: input.driverFailure === "driver_error",
    codesSeen: codes,
    preRunPlanTotal: input.preRunPlanTotal,
    harnessExit: {
      code: lastExit?.exitCode ?? null,
      signal: lastExit?.signal ?? null,
    },
    memoryPeakRatio:
      input.statsPeakMiB === null
        ? null
        : input.statsPeakMiB / input.memoryLimitMiB,
    providerErrorAtExit: providerErrorAtExit(lastProcess),
    errors,
    timeCapHit: input.turns?.terminal === "time_cap",
    idleLoop: false,
    budgetKill: input.turns?.terminal === "budget",
    accessTeamTaken: false,
    dnsNegativeCache: input.dnsNegativeCache,
    verifierInconclusive: input.verifierInconclusive,
    certPendingPast15m,
    gatewayUnreachable,
    verify: input.verify,
    everyappErrorCodes,
    blocked,
    unknownHandoff,
    capsExceeded: input.turns?.terminal === "caps_exceeded",
    ownerNotClaimed: codes.includes("OWNER_NOT_CLAIMED"),
    printedDone: didPrintDone,
    reportedUrl,
    interventions,
    scriptedUserTurns: user?.turns ?? [],
  });
  const verdict = decide(decision);

  const appStep: RunRecord["steps"]["app"] = app.deployed
    ? {
        by: "harness",
        id:
          app.created ??
          (app.url ? (new URL(app.url).hostname.split(".")[0] ?? null) : null),
        url: app.url,
      }
    : input.verify && input.verify.appDeploy.by !== "none"
      ? input.verify.appDeploy
      : { by: "none", id: null, url: null };

  const record: RunRecord = {
    ...seed,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    // Wall time less the preflight sleeps (a held lock, the wipe gap): those waits are the loop's, not the harness's.
    durationS: Math.max(
      0,
      Math.round(
        (Date.parse(input.finishedAt) - Date.parse(input.startedAt)) / 1000,
      ) -
        phases
          .filter((phase) => /^preflight\..*_wait$/.test(phase.name))
          .reduce((sum, phase) => sum + phase.durationS, 0),
    ),
    terminal_reason: terminalReasonOf(input),
    substrate: { ...seed.substrate, statsPeakMiB: input.statsPeakMiB },
    harness: {
      ...seed.harness,
      model: { requested: seed.harness.model.requested, resolved },
    },
    fixtures: { ...seed.fixtures, preRunPlanTotal: input.preRunPlanTotal },
    toolEnv: input.toolEnv ?? seed.toolEnv,
    phases,
    everyappCommands,
    steps: {
      setup,
      claim: {
        how: input.claim.how,
        linkEmittedAt: input.claim.linkEmittedAt,
        claimedAt: input.claim.claimedAt,
        latencyS: input.claim.latencyS,
        linkSurfacedToPerson: linkSurfacedToPerson(events),
      },
      app: appStep,
      access: input.withAccess
        ? {
            tried: true,
            ...(input.team ? { team: input.team } : {}),
            ...(input.verify ? { result: input.verify.access } : {}),
          }
        : { tried: false },
    },
    handoffs: { expected, exercised, skippedBecause },
    scriptedUserTurns: user?.turns ?? [],
    interventions,
    interventionNeeded: interventions.length > 0,
    hesitations: [
      ...detectHesitations(events, everyappCommands),
      ...(input.backgroundKills ?? []).map((kill) => ({
        kind: "background_killed" as const,
        at: kill.at,
        excerpt: `everyapp setup (pid ${kill.pid}) vanished with no exit line: the harness killed its background task`,
        precededBy: { argv: ["setup"], exit: null },
        triage: "harness" as const,
      })),
    ],
    harnessTimeouts: detectHarnessTimeouts(events),
    errors,
    resumes: input.resumes,
    verify: {
      phaseReached: input.verify?.phaseReached ?? "none",
      gatewayUpToDate: input.verify?.gatewayUpToDate ?? null,
      rows: input.verify ? rowStatuses(input.verify) : seed.verify.rows,
      evidence: seed.verify.evidence,
    },
    verdict,
    cost: computeCost(
      seed.harness.name,
      seed.signal,
      resolved,
      input.processes,
    ),
    secret_exposure: input.exposure,
    versions: {
      verifier: input.verify?.version ?? VERIFIER_VERSION,
      decisionTable: DECISION_TABLE_VERSION,
      rules: RULES_VERSION,
      parser: PARSER_VERSION,
    },
  };
  return { record, decision };
}
