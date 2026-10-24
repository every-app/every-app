/**
 * The per-run record (design 4.9): `~/.config/everyapp/onboarding-loop/
 * runs/<runId>/` (mode 700) with run.json (schema v1) beside the raw and
 * redacted artifacts. The schema is checked on read and write with zod so
 * `loop replay`, `reparse` and `report` never work from a half-written file.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessName, RunKey, RunRecord } from "./types";

/** Every file a run directory can hold, by role. */
export const RUN_FILES = {
  record: "run.json",
  events: "events.jsonl",
  eventLog: "everyapp-events.ndjson",
  verify: "verify.json",
  inventoryBefore: "inventory-before.json",
  inventoryAfter: "inventory-after.json",
  diff: "diff.txt",
  prompt: "prompt.txt",
  stats: "stats.jsonl",
  rotate: "rotate.json",
  harnessStdout: "harness.stdout.redacted.log",
  harnessStderr: "harness.stderr.redacted.log",
  /** Every harness line with its process index and stream, for `loop reparse`: the transcript. */
  harnessRaw: "harness.raw.redacted.jsonl",
  assembleInput: "assemble-input.json",
  decideInput: "decide-input.json",
  /** Every binary's --version and `ls -la $HOME` inside the container (design 4.3). */
  versions: "versions.txt",
  /** `git status --porcelain` over the taint roots in the harness's checkout (T1). */
  gitStatus: "git-status.txt",
} as const;

export function defaultRunsRoot(): string {
  return join(
    process.env["EVERYAPP_LOOP_HOME"] ??
      join(homedir(), ".config", "everyapp", "onboarding-loop"),
    "runs",
  );
}

export function runDir(root: string, runId: string): string {
  if (!/^[A-Za-z0-9:._-]+$/.test(runId))
    throw new Error(`not a run id: ${runId}`);
  return join(root, runId);
}

export function ensureRunDir(root: string, runId: string): string {
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** `opencode/glm-5.3-flash` → `glm53flash`; `claude-opus-5-5-20261001` → `opus55`. */
export function modelSlug(model: string | null): string {
  if (!model) return "none";
  const last = model.split("/").pop() ?? model;
  const slug = last
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return slug.slice(0, 16) || "model";
}

/** `2026-10-25T14:02-claude-opus55-a1b2c3`: sortable, readable, unique enough for one Mac. */
export function newRunId(
  now: Date,
  harness: HarnessName,
  model: string | null,
  random = randomSuffix(),
): string {
  const stamp = now.toISOString().slice(0, 16);
  return `${stamp}-${harness}-${modelSlug(model)}-${random}`;
}

function randomSuffix(): string {
  return createHash("sha1")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 6);
}

const verifyRowStatus = z.enum(["pass", "fail", "perimeter-only", "skipped"]);
const verifyRowIds = [
  "G1",
  "G2",
  "G3",
  "O1",
  "A1",
  "A2",
  "A3",
  "S1",
  "T1",
  "X1",
] as const;
const rowsSchema = z.object(
  Object.fromEntries(verifyRowIds.map((id) => [id, verifyRowStatus])) as Record<
    (typeof verifyRowIds)[number],
    typeof verifyRowStatus
  >,
);

const harnessName = z.enum([
  "script",
  "claude",
  "codex",
  "opencode",
  "cursor",
  "hermes",
]);
const signalSchema = z.object({
  toolCalls: z.enum(["full", "counts-only", "none"]),
  toolOutput: z.enum(["full", "truncated", "none"]),
  exitCodes: z.boolean(),
  cost: z.enum(["harness", "tokens_x_list", "none"]),
  resume: z.enum(["native", "fresh", "none"]),
});
const tokensSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
});

/** run.json, schema v1. Kept in step with RunRecord in types.ts; the type assertion below fails to compile when they drift. */
const runRecordSchema = z.object({
  v: z.literal(1),
  runId: z.string().min(1),
  retryOf: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationS: z.number(),
  terminal_reason: z.enum([
    "completed",
    "time_cap",
    "budget",
    "caps_exceeded",
    "blocked",
    "harness_exit",
    "fixture_error",
    "preflight_failed",
    "driver_error",
    "killed",
  ]),
  substrate: z.object({
    kind: z.enum(["docker", "modal"]),
    engine: z.string(),
    image: z.object({
      tag: z.string(),
      platform: z.enum(["linux/arm64", "linux/amd64"]),
    }),
    vmMemoryGiB: z.number().nullable(),
    statsPeakMiB: z.number().nullable(),
  }),
  account: z.object({ name: z.string() }),
  checkout: z.object({
    commit: z.string(),
    ref: z.string(),
    how: z.enum(["bundle", "clone"]),
  }),
  cli: z.object({ commit: z.string(), version: z.string() }),
  agentDocs: z.object({ present: z.boolean(), commit: z.string().nullable() }),
  prompt: z.object({
    variant: z.enum(["checkout-present", "public"]),
    sha256: z.string(),
  }),
  deviations: z.array(
    z.enum([
      "checkout_preplaced",
      "api_token_auth",
      "event_log",
      "claude_consent_seeded",
      "local_docs",
      "claim_immediate",
      "d1_claim",
    ]),
  ),
  fixtures: z.object({
    workers_subdomain: z.enum(["first-run", "preexisting", "unknown"]),
    zone: z.literal("preexisting"),
    auth: z.literal("api_token"),
    team: z.string(),
    cert_packs: z.enum(["kept", "deleted"]),
    docs_url: z.object({
      status: z.number().nullable(),
      final_url: z.string().nullable(),
    }),
    preRunPlanTotal: z.number(),
  }),
  harness: z.object({
    name: harnessName,
    version: z.string(),
    model: z.object({
      requested: z.string().nullable(),
      resolved: z.string().nullable(),
    }),
    mode: z.enum(["defaults", "raised"]).nullable(),
    commandLine: z.string(),
    permissionBypass: z.literal(true),
  }),
  signal: signalSchema,
  toolEnv: z.object({
    CI: z.string().nullable(),
    TERM: z.string().nullable(),
    SHELL: z.string().nullable(),
  }),
  phases: z.array(
    z.object({
      name: z.string(),
      startedAt: z.string(),
      durationS: z.number(),
    }),
  ),
  everyappCommands: z.array(
    z.object({
      argv: z.array(z.string()),
      cwd: z.string(),
      json: z.boolean(),
      ci: z.boolean(),
      exit: z.number().nullable(),
      ms: z.number().nullable(),
      events: z.object({
        warnings: z.array(z.string()),
        actions: z.array(z.string()),
        errors: z.array(z.string()),
      }),
      endedBy: z.enum(["exit", "killed", "unknown"]),
    }),
  ),
  steps: z.object({
    setup: z.object({
      status: z.enum(["done", "error", "action_required", "never_ran"]),
      reruns: z.number(),
    }),
    claim: z.object({
      how: z.enum(["event-log", "d1", "none"]),
      linkEmittedAt: z.string().nullable(),
      claimedAt: z.string().nullable(),
      latencyS: z.number().nullable(),
      linkSurfacedToPerson: z.boolean(),
    }),
    app: z.object({
      by: z.enum(["harness", "verifier", "none"]),
      id: z.string().nullable(),
      url: z.string().nullable(),
    }),
    access: z.object({
      tried: z.boolean(),
      team: z.string().optional(),
      result: z.enum(["pass", "fail", "skipped"]).optional(),
    }),
  }),
  handoffs: z.object({
    expected: z.array(
      z.enum([
        "domain_question",
        "claim_owner",
        "register_workers_subdomain",
        "create_app",
        "ACCESS_TEAM_REQUIRED",
      ]),
    ),
    exercised: z.array(
      z.enum([
        "domain_question",
        "claim_owner",
        "register_workers_subdomain",
        "create_app",
        "ACCESS_TEAM_REQUIRED",
      ]),
    ),
    skippedBecause: z.record(z.string(), z.string()),
  }),
  scriptedUserTurns: z.array(
    z.object({
      at: z.string(),
      trigger: z.enum([
        "domain_question",
        "claim_owner",
        "register_workers_subdomain",
        "create_app",
        "ACCESS_TEAM_REQUIRED",
        "turn_end_without_done",
        "harness_exit",
        "person",
      ]),
      reply: z.string(),
      expected: z.boolean(),
    }),
  ),
  interventions: z.array(
    z.object({
      at: z.string(),
      source: z.enum(["loop", "person"]),
      kind: z.enum([
        "nudge",
        "repeated_answer",
        "resume_after_exit",
        "person_answer",
        "no_done",
        "harness_self_claimed",
      ]),
      text: z.string().optional(),
    }),
  ),
  interventionNeeded: z.boolean(),
  hesitations: z.array(
    z.object({
      kind: z.enum([
        "asked_user",
        "ended_turn_without_done",
        "repeated_command",
        "dropped_json_flag",
        "moved_to_background",
        "background_killed",
        "docs_reread",
        "source_read",
        "tool_output_truncated",
      ]),
      at: z.string(),
      excerpt: z.string().max(200),
      precededBy: z
        .object({ argv: z.array(z.string()), exit: z.number().nullable() })
        .nullable(),
      triage: z.enum(["harness", "cli", "prompt", "docs", "unknown"]),
    }),
  ),
  harnessTimeouts: z.array(
    z.object({
      at: z.string(),
      what: z.string(),
      limitS: z.number(),
      action: z.enum(["backgrounded", "killed", "yielded"]),
    }),
  ),
  errors: z.array(
    z.object({
      code: z.string(),
      step: z.string().nullable(),
      source: z.enum(["infra", "cli", "harness", "loop"]),
      message: z.string(),
    }),
  ),
  resumes: z.array(
    z.object({
      at: z.string(),
      reason: z.enum([
        "turn_end_without_done",
        "harness_exit",
        "hesitation_kill",
        "person",
      ]),
      how: z.enum(["native", "fresh"]),
      sessionId: z.string().nullable(),
    }),
  ),
  verify: z.object({
    phaseReached: z.enum([
      "none",
      "toolchain",
      "auth",
      "gateway-db",
      "gateway-uploaded",
      "owner",
      "app-created",
      "app-deployed",
      "app-live",
      "access",
    ]),
    rows: rowsSchema,
    evidence: z.string(),
  }),
  verdict: z.object({
    value: z.enum([
      "fail-infra",
      "fail-onboarding",
      "pass-with-intervention",
      "pass",
    ]),
    reasonCode: z.string().nullable(),
    falseDone: z.boolean(),
    tainted: z.boolean(),
    shortcut: z.boolean(),
    reportedUrl: z.string().nullable(),
  }),
  cost: z.object({
    usd: z.number().nullable(),
    source: z.enum(["harness", "tokens_x_list", "none"]),
    tokens: tokensSchema,
    model: z.string().nullable(),
  }),
  secret_exposure: z.object({
    cf_token: z.number(),
    provider_key: z.number(),
    est_link: z.number(),
    owner_password: z.number(),
    bearer: z.number(),
  }),
  versions: z.object({
    verifier: z.number(),
    decisionTable: z.number(),
    rules: z.number(),
    parser: z.number(),
  }),
  artifacts: z.object({
    transcript: z.string(),
    eventLog: z.string(),
    verify: z.string(),
    diff: z.string(),
  }),
});

/** Compile-time check that the schema and the type agree on every key. */
type SchemaRecord = z.infer<typeof runRecordSchema>;
const _check: (r: RunRecord) => SchemaRecord = (r) =>
  r as unknown as SchemaRecord;
void _check;

/** The record validated; throws with the first problem named when it is not v1. */
export function validateRunRecord(value: unknown): RunRecord {
  const parsed = runRecordSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `run.json is not schema v1: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown issue"}`,
    );
  }
  return parsed.data as unknown as RunRecord;
}

/** Written atomically (tmp + rename), mode 600, inside a 700 directory. */
export function writeRunRecord(root: string, record: RunRecord): string {
  const validated = validateRunRecord(record);
  const dir = ensureRunDir(root, validated.runId);
  const path = join(dir, RUN_FILES.record);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
  return path;
}

export function readRunRecord(root: string, runId: string): RunRecord {
  const path = join(runDir(root, runId), RUN_FILES.record);
  return validateRunRecord(JSON.parse(readFileSync(path, "utf8")));
}

/** Every run under the root that has a readable run.json, oldest first. */
export function listRunRecords(root: string): RunRecord[] {
  if (!existsSync(root)) return [];
  const records: RunRecord[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name, RUN_FILES.record);
    if (!existsSync(path)) continue;
    try {
      records.push(validateRunRecord(JSON.parse(readFileSync(path, "utf8"))));
    } catch {
      // A half-written or older record: skipped, never guessed at.
    }
  }
  return records;
}

/** What makes two runs comparable (design 3, grafted from (b)). */
export function runKeyOf(record: RunRecord): RunKey {
  return {
    harness: record.harness.name,
    model: record.harness.model.resolved ?? record.harness.model.requested,
    promptSha256: record.prompt.sha256,
    checkoutCommit: record.checkout.commit,
    imageTag: record.substrate.image.tag,
  };
}

export function runKeyString(key: RunKey): string {
  return [
    key.harness,
    key.model ?? "none",
    key.promptSha256.slice(0, 12),
    key.checkoutCommit,
    key.imageTag,
  ].join("|");
}

/** A whole record with every list empty and every unknown null, for the driver to fill as the run goes. */
export function emptyRunRecord(seed: {
  runId: string;
  startedAt: string;
  accountName: string;
  harness: RunRecord["harness"];
  signal: RunRecord["signal"];
  checkout: RunRecord["checkout"];
  cli: RunRecord["cli"];
  prompt: RunRecord["prompt"];
  substrate: RunRecord["substrate"];
}): RunRecord {
  const rows = Object.fromEntries(
    verifyRowIds.map((id) => [id, "skipped"]),
  ) as RunRecord["verify"]["rows"];
  return {
    v: 1,
    runId: seed.runId,
    retryOf: null,
    startedAt: seed.startedAt,
    finishedAt: seed.startedAt,
    durationS: 0,
    terminal_reason: "driver_error",
    substrate: seed.substrate,
    account: { name: seed.accountName },
    checkout: seed.checkout,
    cli: seed.cli,
    agentDocs: { present: false, commit: null },
    prompt: seed.prompt,
    deviations: [],
    fixtures: {
      workers_subdomain: "unknown",
      zone: "preexisting",
      auth: "api_token",
      team: "n/a",
      cert_packs: "kept",
      docs_url: { status: null, final_url: null },
      preRunPlanTotal: 0,
    },
    harness: seed.harness,
    signal: seed.signal,
    toolEnv: { CI: null, TERM: null, SHELL: null },
    phases: [],
    everyappCommands: [],
    steps: {
      setup: { status: "never_ran", reruns: 0 },
      claim: {
        how: "none",
        linkEmittedAt: null,
        claimedAt: null,
        latencyS: null,
        linkSurfacedToPerson: false,
      },
      app: { by: "none", id: null, url: null },
      access: { tried: false },
    },
    handoffs: {
      expected: ["domain_question", "claim_owner", "create_app"],
      exercised: [],
      skippedBecause: {},
    },
    scriptedUserTurns: [],
    interventions: [],
    interventionNeeded: false,
    hesitations: [],
    harnessTimeouts: [],
    errors: [],
    resumes: [],
    verify: { phaseReached: "none", rows, evidence: RUN_FILES.verify },
    verdict: {
      value: "fail-infra",
      reasonCode: "inconclusive",
      falseDone: false,
      tainted: false,
      shortcut: false,
      reportedUrl: null,
    },
    cost: {
      usd: null,
      source: seed.signal.cost,
      tokens: {},
      model: seed.harness.model.requested,
    },
    secret_exposure: {
      cf_token: 0,
      provider_key: 0,
      est_link: 0,
      owner_password: 0,
      bearer: 0,
    },
    versions: { verifier: 0, decisionTable: 0, rules: 0, parser: 0 },
    artifacts: {
      transcript: RUN_FILES.harnessRaw,
      eventLog: RUN_FILES.eventLog,
      verify: RUN_FILES.verify,
      diff: RUN_FILES.diff,
    },
  };
}
