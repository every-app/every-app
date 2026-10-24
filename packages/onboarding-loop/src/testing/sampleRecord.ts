/**
 * A complete, valid RunRecord for tests: a clean pass on Claude Code, with
 * deliberately sensitive values (a zone, an email, a 32-hex id, an est_
 * link) in the fields the whitelist must drop, so report.test.ts proves
 * they never reach a committed file.
 */
import type { RunRecord } from "../types";

export const SAMPLE_ZONE = "everyapp-loop1.com";
export const SAMPLE_EMAIL = `owner@${SAMPLE_ZONE}`;
export const SAMPLE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

export function sampleRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const record: RunRecord = {
    v: 1,
    runId: "2026-10-25T14:02-claude-opus55-a1b2c3",
    retryOf: null,
    startedAt: "2026-10-25T14:02:00.000Z",
    finishedAt: "2026-10-25T14:50:30.000Z",
    durationS: 2910,
    terminal_reason: "completed",
    substrate: {
      kind: "docker",
      engine: "29.8.2",
      image: { tag: "sha-0f3a9c1d", platform: "linux/arm64" },
      vmMemoryGiB: 16,
      statsPeakMiB: 3120,
    },
    account: { name: "loop-1" },
    checkout: {
      commit: "9821d457",
      ref: "t3/launch-onboarding-loop",
      how: "bundle",
    },
    cli: { commit: "9821d457", version: "0.3.0" },
    agentDocs: { present: true, commit: "9821d457" },
    prompt: {
      variant: "checkout-present",
      sha256:
        "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
    },
    deviations: [
      "checkout_preplaced",
      "api_token_auth",
      "event_log",
      "claude_consent_seeded",
    ],
    fixtures: {
      workers_subdomain: "first-run",
      zone: "preexisting",
      auth: "api_token",
      team: "n/a",
      cert_packs: "kept",
      docs_url: { status: 302, final_url: "https://everyapp.com/" },
      preRunPlanTotal: 0,
    },
    harness: {
      name: "claude",
      version: "2.1.309",
      model: { requested: "claude-opus-5-5", resolved: "claude-opus-5-5" },
      mode: "defaults",
      commandLine:
        "claude -p --output-format stream-json --verbose --dangerously-skip-permissions --allow-dangerously-skip-permissions --max-budget-usd 15 --model claude-opus-5-5 < /loop/prompt.txt",
      permissionBypass: true,
    },
    signal: {
      toolCalls: "full",
      toolOutput: "truncated",
      exitCodes: true,
      cost: "harness",
      resume: "native",
    },
    toolEnv: { CI: null, TERM: "dumb", SHELL: "/bin/bash" },
    phases: [
      {
        name: "install",
        startedAt: "2026-10-25T14:03:00.000Z",
        durationS: 184,
      },
      { name: "setup", startedAt: "2026-10-25T14:06:10.000Z", durationS: 540 },
      {
        name: "setup.gateway",
        startedAt: "2026-10-25T14:07:00.000Z",
        durationS: 412,
      },
      {
        name: "setup.owner",
        startedAt: "2026-10-25T14:14:00.000Z",
        durationS: 9,
      },
      { name: "create", startedAt: "2026-10-25T14:16:00.000Z", durationS: 95 },
      { name: "deploy", startedAt: "2026-10-25T14:18:00.000Z", durationS: 140 },
    ],
    everyappCommands: [
      {
        argv: ["setup", "--domain", `apps.${SAMPLE_ZONE}`, "--json"],
        cwd: "/work/every-app",
        json: true,
        ci: false,
        exit: 0,
        ms: 540000,
        events: { warnings: [], actions: ["claim_owner"], errors: [] },
        endedBy: "exit",
      },
      {
        argv: ["create", "hello", "--json"],
        cwd: "/work/every-app",
        json: true,
        ci: false,
        exit: 0,
        ms: 95000,
        events: { warnings: [], actions: [], errors: [] },
        endedBy: "exit",
      },
      {
        argv: ["deploy", "--json"],
        cwd: "/work/every-app/apps/hello",
        json: true,
        ci: false,
        exit: 0,
        ms: 140000,
        events: { warnings: [], actions: [], errors: [] },
        endedBy: "exit",
      },
    ],
    steps: {
      setup: { status: "done", reruns: 0 },
      claim: {
        how: "event-log",
        linkEmittedAt: "2026-10-25T14:14:00.000Z",
        claimedAt: "2026-10-25T14:14:03.000Z",
        latencyS: 3,
        linkSurfacedToPerson: false,
      },
      app: {
        by: "harness",
        id: "hello",
        url: `https://hello.apps.${SAMPLE_ZONE}`,
      },
      access: { tried: false },
    },
    handoffs: {
      expected: ["domain_question", "claim_owner", "create_app"],
      exercised: ["domain_question", "claim_owner"],
      skippedBecause: {
        cloudflare_login: "api_token",
        upgrade_workers_paid: "runbook",
        add_domain: "runbook",
        ACCESS_TEAM_REQUIRED: "no --with-access",
      },
    },
    scriptedUserTurns: [
      {
        at: "2026-10-25T14:05:00.000Z",
        trigger: "domain_question",
        reply: `My domain is ${SAMPLE_ZONE}`,
        expected: true,
      },
    ],
    interventions: [],
    interventionNeeded: false,
    hesitations: [
      {
        kind: "moved_to_background",
        at: "2026-10-25T14:08:10.000Z",
        excerpt: `Command did not complete within its 120s timeout and was moved to the background (owner ${SAMPLE_EMAIL}, link est_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg)`,
        precededBy: {
          argv: ["setup", "--domain", `apps.${SAMPLE_ZONE}`, "--json"],
          exit: null,
        },
        triage: "harness",
      },
    ],
    harnessTimeouts: [
      {
        at: "2026-10-25T14:08:10.000Z",
        what: "setup",
        limitS: 120,
        action: "backgrounded",
      },
    ],
    errors: [],
    resumes: [],
    verify: {
      phaseReached: "app-live",
      gatewayUpToDate: true,
      rows: {
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
      },
      evidence: "verify.json",
    },
    verdict: {
      value: "pass",
      reasonCode: null,
      falseDone: false,
      tainted: false,
      shortcut: false,
      reportedUrl: `https://apps.${SAMPLE_ZONE}`,
    },
    cost: {
      usd: 7.84,
      source: "harness",
      tokens: { input: 265000, output: 198000, cacheRead: 9800000 },
      model: "claude-opus-5-5",
    },
    secret_exposure: {
      cf_token: 0,
      provider_key: 0,
      est_link: 1,
      owner_password: 0,
      bearer: 0,
    },
    versions: { verifier: 1, decisionTable: 1, rules: 1, parser: 1 },
    artifacts: {
      transcript: "harness.raw.redacted.jsonl",
      eventLog: "everyapp-events.ndjson",
      verify: "verify.json",
      diff: "diff.txt",
    },
  };
  return { ...record, ...overrides };
}
