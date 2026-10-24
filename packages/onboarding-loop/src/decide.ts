/**
 * The decision table (design 4.8): four verdicts, evaluated in order, first
 * match wins, each with a reason code. The infra signature table runs
 * first so a Cloudflare, provider or substrate blip is never read as a
 * regression. Versioned: `decisionTable.version` goes on every record and
 * `loop replay` recomputes old runs when it changes.
 */
import { originOf } from "./scriptedUser";
import { allRowsGreen } from "./verify";
import type {
  InfraReasonCode,
  Intervention,
  InterventionReasonCode,
  OnboardingReasonCode,
  RunError,
  ScriptedUserReply,
  VerdictRecord,
  VerifyResult,
} from "./types";

export const DECISION_TABLE_VERSION = 1;

/** The CLI codes and actions that mean the fixture is wrong, not the agent. */
export const FIXTURE_CODES: Record<string, InfraReasonCode> = {
  cloudflare_login: "fixture_cloudflare_login",
  choose_account: "fixture_choose_account",
  upgrade_workers_paid: "fixture_upgrade_workers_paid",
  add_domain: "fixture_add_domain",
  CLOUDFLARE_TOKEN_REJECTED: "fixture_token_rejected",
  DOMAIN_REQUIRED_AFTER_ANSWER: "fixture_add_domain",
};

/** Infra signatures in an error's code or message (design 4.8, first row). */
const INFRA_SIGNATURES: Array<{
  code: InfraReasonCode;
  test: (error: RunError) => boolean;
}> = [
  {
    code: "cf_timeout",
    test: (e) =>
      /CfTimeoutError|timed out after/i.test(`${e.code} ${e.message}`),
  },
  {
    code: "cloudflare_5xx",
    test: (e) =>
      /\b(50[0-9]|52[0-9]|530)\b/.test(e.message) &&
      /cloudflare|api\.cloudflare\.com|cf /i.test(`${e.code} ${e.message}`),
  },
  { code: "cert_pending", test: (e) => e.code === "CERT_PENDING" },
  {
    code: "npm_network",
    test: (e) =>
      /\b(ECONNRESET|ETIMEDOUT|ERR_PNPM_FETCH|503 Service Unavailable)\b/.test(
        e.message,
      ) && /npm|pnpm|registry/i.test(e.message),
  },
  {
    code: "deploy_lease",
    test: (e) => /waiting for the deploy lease/i.test(e.message),
  },
];

export function classifyInfraError(error: RunError): InfraReasonCode | null {
  for (const signature of INFRA_SIGNATURES)
    if (signature.test(error)) return signature.code;
  return null;
}

export interface DecideInput {
  preflight: { ok: boolean; reason: string | null };
  /** action_required actions and error codes seen in the event log or the harness stream. */
  codesSeen: string[];
  preRunPlanTotal: number;
  harnessExit: { code: number | null; signal: string | null };
  /** docker stats peak over the memory limit, 0..1. */
  memoryPeakRatio: number | null;
  /** The harness exited on a provider 401/429/529/overloaded with no later turn. */
  providerErrorAtExit: boolean;
  errors: RunError[];
  /** The 90-minute cap hit while the harness was still making progress (an idle loop is caps_exceeded). */
  timeCapHit: boolean;
  idleLoop: boolean;
  budgetKill: boolean;
  accessTeamTaken: boolean;
  dnsNegativeCache: boolean;
  /** The verifier's own container or `pnpm install` failed. */
  verifierInconclusive: boolean;
  /** The harness got a `CERT_PENDING` past 15 minutes. */
  certPendingPast15m: boolean;
  /** The verifier never reached G1 past its window. */
  gatewayUnreachable: boolean;
  verify: VerifyResult | null;
  /** The CLI exited 1 with a non-infra code. */
  everyappErrorCodes: string[];
  blocked: string | null;
  unknownHandoff: boolean;
  capsExceeded: boolean;
  /** `OWNER_NOT_CLAIMED` was emitted. */
  ownerNotClaimed: boolean;
  printedDone: boolean;
  reportedUrl: string | null;
  gatewayOrigin: string;
  interventions: Intervention[];
  scriptedUserTurns: ScriptedUserReply[];
}

function flags(
  input: DecideInput,
): Pick<VerdictRecord, "falseDone" | "tainted" | "shortcut" | "reportedUrl"> {
  const green = input.verify !== null && allRowsGreen(input.verify);
  return {
    falseDone: input.printedDone && !green,
    tainted: input.verify?.tainted ?? false,
    shortcut: input.verify?.shortcut ?? false,
    reportedUrl: input.reportedUrl,
  };
}

function infra(input: DecideInput): InfraReasonCode | null {
  if (!input.preflight.ok)
    return input.preflight.reason === "whoami"
      ? "whoami_gate_failed"
      : "preflight_failed";
  for (const code of input.codesSeen) {
    const fixture = FIXTURE_CODES[code];
    if (fixture) return fixture;
  }
  if (input.preRunPlanTotal > 0) return "fixture_pre_run_plan_nonempty";
  if (
    input.harnessExit.code === 137 ||
    (input.memoryPeakRatio !== null && input.memoryPeakRatio >= 0.95)
  )
    return "memory_limit";
  if (input.providerErrorAtExit) return "provider_error";
  for (const error of input.errors) {
    const code = classifyInfraError(error);
    if (code) return code;
  }
  if (input.certPendingPast15m) return "cert_pending";
  if (input.gatewayUnreachable) return "gateway_unreachable";
  if (input.dnsNegativeCache) return "dns_negative_cache";
  if (input.timeCapHit && !input.idleLoop) return "time_cap";
  if (input.accessTeamTaken) return "access_team_taken";
  if (input.verifierInconclusive) return "inconclusive";
  if (input.budgetKill) return "budget";
  return null;
}

function onboarding(input: DecideInput): OnboardingReasonCode | null {
  if (input.everyappErrorCodes.length > 0) return "everyapp_error";
  if (input.blocked !== null) return "blocked";
  if (input.unknownHandoff) return "unknown_handoff";
  if (input.capsExceeded || (input.timeCapHit && input.idleLoop))
    return "caps_exceeded";
  if (input.ownerNotClaimed) return "owner_link_not_shown";
  const verify = input.verify;
  if (!verify) return "verifier_red";
  if (verify.appDeploy.by === "verifier") return "app_not_deployed_by_harness";
  if (verify.ownerNotCreatedByLoop) return "owner_not_created_by_loop";
  if (verify.tainted) return "tainted";
  if (verify.shortcut) return "shortcut";
  if (!allRowsGreen(verify))
    return input.printedDone ? "false_done" : "verifier_red";
  return null;
}

function intervention(input: DecideInput): InterventionReasonCode | null {
  if (input.verify?.harnessSelfClaimed) return "harness_self_claimed";
  const first = input.interventions[0];
  if (first) {
    const map: Record<Intervention["kind"], InterventionReasonCode> = {
      nudge: "nudge",
      repeated_answer: "repeated_answer",
      resume_after_exit: "resume_after_exit",
      person_answer: "person_answer",
      no_done: "no_done",
      harness_self_claimed: "harness_self_claimed",
    };
    return map[first.kind];
  }
  if (!input.printedDone) return "no_done";
  if (input.scriptedUserTurns.some((turn) => !turn.expected)) return "nudge";
  return null;
}

export function decide(input: DecideInput): VerdictRecord {
  const base = flags(input);
  const infraCode = infra(input);
  if (infraCode) return { value: "fail-infra", reasonCode: infraCode, ...base };
  const onboardingCode = onboarding(input);
  if (onboardingCode)
    return { value: "fail-onboarding", reasonCode: onboardingCode, ...base };
  const interventionCode = intervention(input);
  if (interventionCode)
    return {
      value: "pass-with-intervention",
      reasonCode: interventionCode,
      ...base,
    };
  // Origins, so `https://apps.<zone>/` and `/sign-in` suffixes count as the Gateway URL.
  const urlMatches =
    input.reportedUrl !== null &&
    originOf(input.reportedUrl) !== null &&
    originOf(input.reportedUrl) === originOf(input.gatewayOrigin);
  if (!urlMatches)
    return { value: "pass-with-intervention", reasonCode: "no_done", ...base };
  return { value: "pass", reasonCode: null, ...base };
}

/** Everything the decision needs defaults to "nothing happened", so a caller fills in only what it knows. */
export function decideInput(
  partial: Partial<DecideInput> & Pick<DecideInput, "gatewayOrigin">,
): DecideInput {
  return {
    preflight: { ok: true, reason: null },
    codesSeen: [],
    preRunPlanTotal: 0,
    harnessExit: { code: 0, signal: null },
    memoryPeakRatio: null,
    providerErrorAtExit: false,
    errors: [],
    timeCapHit: false,
    idleLoop: false,
    budgetKill: false,
    accessTeamTaken: false,
    dnsNegativeCache: false,
    verifierInconclusive: false,
    certPendingPast15m: false,
    gatewayUnreachable: false,
    verify: null,
    everyappErrorCodes: [],
    blocked: null,
    unknownHandoff: false,
    capsExceeded: false,
    ownerNotClaimed: false,
    printedDone: false,
    reportedUrl: null,
    interventions: [],
    scriptedUserTurns: [],
    ...partial,
  };
}
