import { describe, expect, it } from "vitest";
import {
  classifyInfraError,
  decide,
  decideInput,
  DECISION_TABLE_VERSION,
  FIXTURE_CODES,
} from "./decide";
import type {
  VerifyResult,
  VerifyRow,
  VerifyRowId,
  VerifyRowStatus,
} from "./types";

const origin = "https://apps.everyapp-loop1.com";

function verifyResult(
  statuses: Partial<Record<VerifyRowId, VerifyRowStatus>> = {},
  more: Partial<VerifyResult> = {},
): VerifyResult {
  const all: Record<VerifyRowId, VerifyRowStatus> = {
    G1: "pass",
    G2: "pass",
    G3: "pass",
    O1: "pass",
    A1: "pass",
    A2: "pass",
    A3: "perimeter-only",
    S1: "pass",
    T1: "pass",
    X1: "skipped",
    ...statuses,
  };
  const rows = Object.fromEntries(
    (Object.keys(all) as VerifyRowId[]).map((id) => [
      id,
      {
        id,
        status: all[id],
        attempts: 1,
        startedAt: "t",
        finishedAt: "t",
        evidence: null,
      } satisfies VerifyRow,
    ]),
  ) as Record<VerifyRowId, VerifyRow>;
  return {
    version: 1,
    phaseReached: "app-live",
    rows,
    tainted: false,
    shortcut: false,
    ownerNotCreatedByLoop: false,
    harnessSelfClaimed: false,
    access: "skipped",
    appDeploy: {
      by: "harness",
      id: "hello",
      url: "https://hello.apps.everyapp-loop1.com",
    },
    ...more,
  };
}

const clean = () =>
  decideInput({
    gatewayOrigin: origin,
    verify: verifyResult(),
    printedDone: true,
    reportedUrl: origin,
  });

describe("the decision table, in order", () => {
  it("is versioned", () => {
    expect(DECISION_TABLE_VERSION).toBe(1);
  });
  it("passes a clean run", () => {
    expect(decide(clean())).toEqual({
      value: "pass",
      reasonCode: null,
      falseDone: false,
      tainted: false,
      shortcut: false,
      reportedUrl: origin,
    });
  });
  it("puts infra first, even when the verifier is red and DONE was printed", () => {
    const input = {
      ...clean(),
      verify: verifyResult({ A1: "fail" }),
      errors: [
        {
          code: "CERT_PENDING",
          step: "setup.gateway",
          source: "infra" as const,
          message: "certificate still pending",
        },
      ],
    };
    expect(decide(input)).toMatchObject({
      value: "fail-infra",
      reasonCode: "cert_pending",
      falseDone: true,
    });
  });
  it("names every fixture code", () => {
    for (const [code, reason] of Object.entries(FIXTURE_CODES)) {
      expect(decide({ ...clean(), codesSeen: [code] })).toMatchObject({
        value: "fail-infra",
        reasonCode: reason,
      });
    }
    expect(decide({ ...clean(), preRunPlanTotal: 3 })).toMatchObject({
      value: "fail-infra",
      reasonCode: "fixture_pre_run_plan_nonempty",
    });
    expect(
      decide({ ...clean(), preflight: { ok: false, reason: "whoami" } }),
    ).toMatchObject({ reasonCode: "whoami_gate_failed" });
    expect(
      decide({ ...clean(), preflight: { ok: false, reason: "docker" } }),
    ).toMatchObject({ reasonCode: "preflight_failed" });
  });
  it("reads the substrate, provider and network signatures", () => {
    expect(
      decide({ ...clean(), harnessExit: { code: 137, signal: "SIGKILL" } }),
    ).toMatchObject({ reasonCode: "memory_limit" });
    expect(decide({ ...clean(), memoryPeakRatio: 0.97 })).toMatchObject({
      reasonCode: "memory_limit",
    });
    expect(decide({ ...clean(), providerErrorAtExit: true })).toMatchObject({
      reasonCode: "provider_error",
    });
    expect(
      decide({
        ...clean(),
        errors: [
          {
            code: "CF_ERROR",
            step: null,
            source: "cli",
            message: "api.cloudflare.com answered 503",
          },
        ],
      }),
    ).toMatchObject({ reasonCode: "cloudflare_5xx" });
    expect(
      decide({
        ...clean(),
        errors: [
          {
            code: "CfTimeoutError",
            step: null,
            source: "cli",
            message: "cf workers deploy timed out after 120s",
          },
        ],
      }),
    ).toMatchObject({ reasonCode: "cf_timeout" });
    expect(
      decide({
        ...clean(),
        errors: [
          {
            code: "INSTALL_FAILED",
            step: null,
            source: "harness",
            message: "pnpm install: ECONNRESET from registry.npmjs.org",
          },
        ],
      }),
    ).toMatchObject({ reasonCode: "npm_network" });
    expect(decide({ ...clean(), dnsNegativeCache: true })).toMatchObject({
      reasonCode: "dns_negative_cache",
    });
    expect(decide({ ...clean(), timeCapHit: true })).toMatchObject({
      reasonCode: "time_cap",
    });
    expect(decide({ ...clean(), accessTeamTaken: true })).toMatchObject({
      reasonCode: "access_team_taken",
    });
    expect(decide({ ...clean(), verifierInconclusive: true })).toMatchObject({
      reasonCode: "inconclusive",
    });
    expect(decide({ ...clean(), budgetKill: true })).toMatchObject({
      reasonCode: "budget",
    });
    expect(decide({ ...clean(), gatewayUnreachable: true })).toMatchObject({
      reasonCode: "gateway_unreachable",
    });
    expect(
      classifyInfraError({
        code: "X",
        step: null,
        source: "cli",
        message: "waiting for the deploy lease",
      }),
    ).toBe("deploy_lease");
    expect(
      classifyInfraError({
        code: "DOMAIN_REQUIRED",
        step: null,
        source: "cli",
        message: "pick a domain",
      }),
    ).toBeNull();
  });
  it("then onboarding failures, each with its code", () => {
    expect(
      decide({ ...clean(), everyappErrorCodes: ["DOMAIN_REQUIRED"] }),
    ).toMatchObject({ value: "fail-onboarding", reasonCode: "everyapp_error" });
    expect(decide({ ...clean(), blocked: "no token" })).toMatchObject({
      value: "fail-onboarding",
      reasonCode: "blocked",
    });
    expect(decide({ ...clean(), unknownHandoff: true })).toMatchObject({
      reasonCode: "unknown_handoff",
    });
    expect(decide({ ...clean(), capsExceeded: true })).toMatchObject({
      reasonCode: "caps_exceeded",
    });
    expect(
      decide({ ...clean(), timeCapHit: true, idleLoop: true }),
    ).toMatchObject({ value: "fail-onboarding", reasonCode: "caps_exceeded" });
    expect(decide({ ...clean(), ownerNotClaimed: true })).toMatchObject({
      reasonCode: "owner_link_not_shown",
    });
    expect(
      decide({
        ...clean(),
        verify: verifyResult(
          {},
          { appDeploy: { by: "verifier", id: "hello", url: null } },
        ),
      }),
    ).toMatchObject({ reasonCode: "app_not_deployed_by_harness" });
    expect(
      decide({
        ...clean(),
        verify: verifyResult({}, { ownerNotCreatedByLoop: true }),
      }),
    ).toMatchObject({ reasonCode: "owner_not_created_by_loop" });
    expect(
      decide({
        ...clean(),
        verify: verifyResult({ T1: "fail" }, { tainted: true }),
      }),
    ).toMatchObject({ reasonCode: "tainted", tainted: true });
    expect(
      decide({
        ...clean(),
        verify: verifyResult({ T1: "fail" }, { shortcut: true }),
      }),
    ).toMatchObject({ reasonCode: "shortcut", shortcut: true });
    expect(decide({ ...clean(), verify: null })).toMatchObject({
      reasonCode: "verifier_red",
    });
  });
  it("calls DONE over a red check false_done, a first-class finding, never partial", () => {
    expect(
      decide({ ...clean(), verify: verifyResult({ S1: "fail" }) }),
    ).toMatchObject({
      value: "fail-onboarding",
      reasonCode: "false_done",
      falseDone: true,
    });
    expect(
      decide({
        ...clean(),
        verify: verifyResult({ S1: "fail" }),
        printedDone: false,
      }),
    ).toMatchObject({
      value: "fail-onboarding",
      reasonCode: "verifier_red",
      falseDone: false,
    });
  });
  it("then pass-with-intervention for a green run that needed a person", () => {
    const at = "t";
    expect(
      decide({
        ...clean(),
        interventions: [{ at, source: "loop", kind: "nudge" }],
      }),
    ).toMatchObject({ value: "pass-with-intervention", reasonCode: "nudge" });
    expect(
      decide({
        ...clean(),
        interventions: [{ at, source: "loop", kind: "resume_after_exit" }],
      }),
    ).toMatchObject({ reasonCode: "resume_after_exit" });
    expect(
      decide({
        ...clean(),
        interventions: [{ at, source: "person", kind: "person_answer" }],
      }),
    ).toMatchObject({ reasonCode: "person_answer" });
    expect(
      decide({ ...clean(), printedDone: false, reportedUrl: null }),
    ).toMatchObject({ value: "pass-with-intervention", reasonCode: "no_done" });
    expect(
      decide({
        ...clean(),
        verify: verifyResult({}, { harnessSelfClaimed: true }),
      }),
    ).toMatchObject({
      value: "pass-with-intervention",
      reasonCode: "harness_self_claimed",
    });
    expect(
      decide({
        ...clean(),
        reportedUrl: "https://hello.apps.everyapp-loop1.com",
      }),
    ).toMatchObject({ value: "pass-with-intervention", reasonCode: "no_done" });
  });
  it("compares the reported URL by origin: a trailing slash or /sign-in is still the Gateway URL", () => {
    for (const url of [`${origin}/`, `${origin}/sign-in`, origin])
      expect(decide({ ...clean(), reportedUrl: url }), url).toMatchObject({
        value: "pass",
        reasonCode: null,
      });
    expect(decide({ ...clean(), reportedUrl: "not a url" })).toMatchObject({
      value: "pass-with-intervention",
      reasonCode: "no_done",
    });
  });
  it("counts an unexpected scripted turn as an intervention even when the list is empty", () => {
    expect(
      decide({
        ...clean(),
        scriptedUserTurns: [
          {
            at: "t",
            trigger: "turn_end_without_done",
            reply: "x",
            expected: false,
          },
        ],
      }),
    ).toMatchObject({ value: "pass-with-intervention", reasonCode: "nudge" });
  });
});
