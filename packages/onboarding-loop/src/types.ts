/**
 * Every type two lanes of the loop share, in one file so the lanes do not
 * collide. Each type names the section of
 * docs/design/2026-10-onboarding-loop.md it comes from. Runtime code lives
 * elsewhere; this file is types and string unions only.
 */

// ---------------------------------------------------------------------------
// Accounts and providers (4.14, 6)
// ---------------------------------------------------------------------------

/** One row of ~/.config/everyapp/onboarding-loop/accounts.json: a separate Cloudflare user's test account, never Ben's. */
export interface Account {
  /** The name a run is asked for: `--account loop-1`. */
  name: string;
  /** The 32-hex Cloudflare account id; refused when it is the forbidden id. */
  accountId: string;
  /** The active zone the Gateway installs under: apps.<zone>. */
  zone: string;
  /** The owner email the scripted user claims with (owner@<zone>). */
  email: string;
  /** The account- and zone-restricted API token; memory only, never printed. */
  token: string;
}

/** The whole accounts.json file. */
export interface AccountsFile {
  accounts: Account[];
}

/** The one environment variable each harness reads its provider key from (4.4). */
export type ProviderVar =
  | "ANTHROPIC_API_KEY"
  | "CODEX_API_KEY"
  | "OPENCODE_API_KEY"
  | "CURSOR_API_KEY";

/** providers.env parsed: at most one value per variable, each a secret. */
export type Providers = Partial<Record<ProviderVar, string>>;

// ---------------------------------------------------------------------------
// Harnesses (4.4)
// ---------------------------------------------------------------------------

/** The harnesses the matrix knows, plus `script`, the bash control that follows the prompt literally. */
export type HarnessName =
  | "script"
  | "claude"
  | "codex"
  | "opencode"
  | "cursor"
  | "hermes";

/** Claude Code's two labelled modes; `null` for a harness with one. */
export type HarnessMode = "defaults" | "raised";

/** How far an adapter is trusted: a fixture-backed row, one written from docs only, or the control. */
export type HarnessStatus = "measured" | "provisional" | "control" | "parked";

/** What an adapter can and cannot see in its stream, recorded on every run so rows are never compared blind. */
export interface Signal {
  toolCalls: "full" | "counts-only" | "none";
  toolOutput: "full" | "truncated" | "none";
  exitCodes: boolean;
  cost: "harness" | "tokens_x_list" | "none";
  resume: "native" | "fresh" | "none";
}

/** The kinds every harness stream is normalized to. */
export type NormalizedEventKind =
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "turn_end"
  | "result";

/** Token counts as a harness reports them; any field a stream lacks is absent. */
export interface TokenCounts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** One line of events.jsonl: a harness stream line in the one shape detectors and costs are defined on. */
export interface NormalizedEvent {
  /** When the driver read the line (ISO); the only timestamp every harness has. */
  receivedAt: string;
  /** The harness's own timestamp, when its stream carries one. */
  ts?: string;
  /** The harness session to resume with. */
  sessionId?: string;
  kind: NormalizedEventKind;
  /** Tool name for tool_call and tool_result (Bash, Read, shell, …). */
  tool?: string;
  /** The command a shell tool ran, split. */
  argv?: string[];
  /** The working directory of a shell tool call, when known. */
  cwd?: string;
  /** Length of a tool result as the harness delivered it. */
  outputChars?: number;
  /** The harness cut the tool output (Hermes 5000 chars, Claude 2 KB previews, …). */
  truncated?: boolean;
  /** A tool result the harness flagged as an error. */
  isError?: boolean;
  /** Assistant text, or the tool output when present. */
  text?: string;
  /** Tokens on a result or turn_end event. */
  tokens?: TokenCounts;
  /** Cumulative USD as the harness reports it (Claude's total_cost_usd); never summed across resumes. */
  costUsd?: number;
  /** The model the harness says it is running, when the line names one (init events, assistant messages). */
  model?: string;
  /** The harness's own reason a turn or process ended (end_turn, api_error, max_turns, …), on result events. */
  stopReason?: string;
  /** The parsed stream line, redacted. */
  raw: unknown;
}

/** What an adapter needs to write the first command line. */
export interface HarnessLaunch {
  /** The prompt file inside the container (/loop/prompt.txt). */
  promptPath: string;
  /** The dated model id to request; the adapter's default when absent. */
  model?: string;
  mode?: HarnessMode;
  /** The account's zone; only the control script needs it (it runs `setup --domain apps.<zone>` itself). */
  zone?: string;
  /** Where the script control tees the CLI's output and writes its markers (/loop). */
  loopDir?: string;
}

/** A command the sandbox runs: argv, extra environment and the user it runs as. */
export interface HarnessCommand {
  argv: string[];
  /** Variables beyond the sandbox's own (DISABLE_AUTOUPDATER=1, HERMES_YOLO_MODE=1, …); never a secret. */
  env?: Record<string, string>;
}

/** One harness: command lines, stream normalizer, resume, what to collect, and what its stream can show (4.4). */
export interface HarnessAdapter {
  name: HarnessName;
  /** The pin the image installs (2.1.309, 0.163.0, …) or "installer" when it is recorded at launch. */
  version: string;
  status: HarnessStatus;
  /** Which provider variable the container gets; `null` for the control, which only needs the Cloudflare token. */
  providerVar: ProviderVar | null;
  /** The default dated model id, or `null` for the control. */
  defaultModel: string | null;
  signal: Signal;
  /** Always true today: every harness runs with its permission prompts bypassed. */
  permissionBypass: true;
  /** The turn-1 command line, validated against `--help` inside the image by `loop doctor`. */
  command(launch: HarnessLaunch): HarnessCommand;
  /** The native resume for turn 2+, or `null` when the harness has none. */
  resume(
    sessionId: string | null,
    replyPath: string,
    launch: HarnessLaunch,
  ): HarnessCommand | null;
  /** One stream line (stdout or stderr) to zero or more normalized events. */
  normalize(
    line: string,
    stream: "stdout" | "stderr",
    receivedAt: string,
  ): NormalizedEvent[];
  /**
   * Events to append when the process exits, for a harness whose stream has
   * no final event (OpenCode ends on a `text` line; the control script on
   * a non-zero exit): a synthesized `result`, or nothing.
   */
  onExit?(exitCode: number | null, receivedAt: string): NormalizedEvent[];
  /** Paths inside the container copied out after the run (session stores), relative to $HOME. */
  collectPaths: string[];
  /** fixtures/<harness>/sample.jsonl, when captured. */
  fixture: string | null;
}

// ---------------------------------------------------------------------------
// Sandbox (3, 4.2, 4.3)
// ---------------------------------------------------------------------------

/** One line of a running command's output, as it arrives. */
export interface ExecLine {
  stream: "stdout" | "stderr";
  line: string;
  receivedAt: string;
}

/** What a finished exec leaves behind. */
export interface ExecResult {
  exitCode: number | null;
  /** The signal that ended it, when one did. */
  signal: string | null;
  durationMs: number;
  /** The process was killed by the driver (cap, budget, kill on hesitation). */
  killed: boolean;
}

/** Options for one exec inside the sandbox. */
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Kill after this many milliseconds. */
  timeoutMs?: number;
  /** Each line as it arrives, already redacted. */
  onLine?: (line: ExecLine) => void;
  /** Resolves to stop the exec early (the scripted user's kill). */
  signal?: AbortSignal;
}

/** How a sandbox is made: the image, limits and the environment file that holds the secrets for seconds. */
export interface SandboxSpec {
  name: string;
  image: string;
  platform: "linux/arm64" | "linux/amd64";
  cpus: number;
  memory: string;
  /** The variables the container gets: exactly the token, the account id, one provider key and EVERYAPP_EVENT_LOG. */
  env: Record<string, string>;
  user: string;
  workdir: string;
}

/** A handle on one running sandbox. */
export interface SandboxHandle {
  id: string;
  name: string;
}

/** A running tail of a file inside the sandbox; close it to stop. */
export interface TailHandle {
  close(): Promise<void>;
}

/** One entry of a filesystem diff against the image. */
export interface DiffEntry {
  kind: "added" | "changed" | "deleted";
  path: string;
}

/** The seven operations the loop needs from a substrate; docker.ts implements it today, a Modal shim could tomorrow. */
export interface Sandbox {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** A host file or directory into the sandbox. */
  copyIn(
    handle: SandboxHandle,
    hostPath: string,
    sandboxPath: string,
  ): Promise<void>;
  /** Run a command, streaming each stdout and stderr line to `onLine`. */
  exec(
    handle: SandboxHandle,
    argv: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
  /** Follow a file inside the sandbox from its first line (`tail -n +1 -F`). */
  tailFile(
    handle: SandboxHandle,
    sandboxPath: string,
    onLine: (line: string) => void,
  ): Promise<TailHandle>;
  /** A sandbox file or directory out to the host. */
  copyOut(
    handle: SandboxHandle,
    sandboxPath: string,
    hostPath: string,
  ): Promise<void>;
  /** What changed against the image (tamper detection, T1). */
  diff(handle: SandboxHandle): Promise<DiffEntry[]>;
  destroy(handle: SandboxHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// The CLI's events and the event log (4.5, FACTS)
// ---------------------------------------------------------------------------

/** The step statuses the CLI emits. */
export type CliStepStatus = "start" | "ok" | "skip" | "fail";

/** One `--json` event of the everyapp CLI, as the sinks print it and the event log tees it. */
export type CliEvent = { v: 1; ts: string } & (
  | {
      type: "step";
      step: string;
      status: CliStepStatus;
      message?: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "progress";
      step: string;
      message: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "warning";
      code: string;
      message: string;
      step?: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "action_required";
      action: string;
      message: string;
      step?: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      step?: string;
      data?: Record<string, unknown>;
    }
  | { type: "done"; message?: string; data?: Record<string, unknown> }
);

/** The first line the event log writes per everyapp process. */
export interface EventLogInvocation {
  type: "invocation";
  pid: number;
  argv: string[];
  cwd: string;
  /** `--json` was passed. */
  json: boolean;
  isatty: { stdin: boolean; stdout: boolean; stderr: boolean };
  /** `CI` was set in the process's environment (then the owner link is hidden). */
  ci: boolean;
  ts: string;
}

/** The last line the event log writes per everyapp process. */
export interface EventLogExit {
  type: "exit";
  pid: number;
  code: number;
  ms: number;
  ts: string;
}

/** One line of /loop/everyapp-events.ndjson. */
export type EventLogLine =
  | EventLogInvocation
  | EventLogExit
  | (CliEvent & { pid?: number });

// ---------------------------------------------------------------------------
// The scripted user (4.5)
// ---------------------------------------------------------------------------

/** The hand-offs the prompt itself creates; answering one is expected, not an intervention. */
export type ExpectedHandoff =
  | "domain_question"
  | "claim_owner"
  | "register_workers_subdomain"
  | "create_app"
  | "ACCESS_TEAM_REQUIRED";

/** What made the scripted user speak. */
export type ScriptedUserTrigger =
  | ExpectedHandoff
  /** A turn ended without DONE, BLOCKED or an expected hand-off: the universal reply. */
  | "turn_end_without_done"
  /** The harness exited without a result event and was resumed. */
  | "harness_exit"
  /** `pnpm loop answer <runId> "<text>"` by a person watching. */
  | "person";

/** One entry of scriptedUserTurns[]: every reply the loop gave the harness, expected or not. */
export interface ScriptedUserReply {
  at: string;
  trigger: ScriptedUserTrigger;
  /** The text sent to the harness, or a short description of the REST call made instead. */
  reply: string;
  /** True for an expected hand-off; false means the reply counts as an intervention. */
  expected: boolean;
}

/** An action a person would have had to take: a nudge, a repeated answer, a resume, a person's text. */
export interface Intervention {
  at: string;
  source: "loop" | "person";
  kind:
    | "nudge"
    | "repeated_answer"
    | "resume_after_exit"
    | "person_answer"
    | "no_done"
    | "harness_self_claimed";
  text?: string;
}

/** A harness process restarted with its native resume. */
export interface Resume {
  at: string;
  reason:
    | "turn_end_without_done"
    | "harness_exit"
    | "hesitation_kill"
    | "person";
  how: "native" | "fresh";
  sessionId: string | null;
}

/** A hesitation kind the detectors name (4.9). */
export type HesitationKind =
  | "asked_user"
  | "ended_turn_without_done"
  | "repeated_command"
  | "dropped_json_flag"
  | "moved_to_background"
  | "background_killed"
  | "docs_reread"
  | "source_read"
  | "tool_output_truncated";

/** One hesitation: where the agent stalled, asked or went around the docs. */
export interface Hesitation {
  kind: HesitationKind;
  at: string;
  /** At most 200 characters, redacted. */
  excerpt: string;
  /** The everyapp command just before it, when there was one. */
  precededBy: { argv: string[]; exit: number | null } | null;
  /** Whose problem it looks like. */
  triage: "harness" | "cli" | "prompt" | "docs" | "unknown";
}

/** A harness-side timeout acting on a long command (Claude's 2-minute background, Codex's 5-minute kill). */
export interface HarnessTimeout {
  at: string;
  what: string;
  limitS: number;
  action: "backgrounded" | "killed" | "yielded";
}

// ---------------------------------------------------------------------------
// The verifier (4.7)
// ---------------------------------------------------------------------------

/** The probes in order: gateway, owner, app, status, tamper, Access. */
export type VerifyRowId =
  | "G1"
  | "G2"
  | "G3"
  | "O1"
  | "A1"
  | "A2"
  | "A3"
  | "S1"
  | "T1"
  | "X1";

/** A row's outcome; `perimeter-only` is A3 until the cookie domain is confirmed, `skipped` is X1 without --with-access. */
export type VerifyRowStatus = "pass" | "fail" | "perimeter-only" | "skipped";

/** One probe's result with its raw evidence, so `loop replay` can recompute after a rule change. */
export interface VerifyRow {
  id: VerifyRowId;
  status: VerifyRowStatus;
  /** How many attempts within the retry window. */
  attempts: number;
  startedAt: string;
  finishedAt: string;
  /** Status codes, headers, parsed bodies: whatever the row looked at, redacted. */
  evidence: unknown;
  /** Why it failed or was capped, in a sentence. */
  note?: string;
}

/** How far the run got, comparable across harnesses and weeks. */
export type PhaseReached =
  | "none"
  | "toolchain"
  | "auth"
  | "gateway-db"
  | "gateway-uploaded"
  | "owner"
  | "app-created"
  | "app-deployed"
  | "app-live"
  | "access";

/** The verifier's output, verify.json: every row, the ladder, and the tamper flags the decision table reads. */
export interface VerifyResult {
  version: number;
  phaseReached: PhaseReached;
  rows: Record<VerifyRowId, VerifyRow>;
  /** docker diff under the gateway, packages or templates was not empty. */
  tainted: boolean;
  /** The harness ran `cf d1 query|execute`, `wrangler` or hit api.cloudflare.com itself. */
  shortcut: boolean;
  /** Owner claimed but `claim.how` is none. */
  ownerNotCreatedByLoop: boolean;
  /** O1's email differs from the loop's, or the loop's claim answered ALREADY_CLAIMED. */
  harnessSelfClaimed: boolean;
  /** X1's sub-verdict, never folded into the main one. */
  access: "pass" | "fail" | "skipped";
  /** The verifier's own create + deploy, run only when the harness deployed no app. */
  appDeploy: {
    by: "harness" | "verifier" | "none";
    id: string | null;
    url: string | null;
  };
}

// ---------------------------------------------------------------------------
// The decision table (4.8)
// ---------------------------------------------------------------------------

/** The four verdicts, evaluated in this order, first match wins. */
export type Verdict =
  | "fail-infra"
  | "fail-onboarding"
  | "pass-with-intervention"
  | "pass";

/** Why a run is fail-infra: the fixture, the substrate, a provider or Cloudflare, never the agent. */
export type InfraReasonCode =
  | "preflight_failed"
  | "whoami_gate_failed"
  | "fixture_cloudflare_login"
  | "fixture_choose_account"
  | "fixture_upgrade_workers_paid"
  | "fixture_add_domain"
  | "fixture_token_rejected"
  | "fixture_pre_run_plan_nonempty"
  | "memory_limit"
  | "provider_error"
  | "cloudflare_5xx"
  | "cf_timeout"
  | "cert_pending"
  | "gateway_unreachable"
  | "dns_negative_cache"
  | "npm_network"
  | "time_cap"
  | "access_team_taken"
  | "deploy_lease"
  | "inconclusive"
  | "budget";

/** Why a run is fail-onboarding: the agent, the CLI, the prompt or the docs did not get there. */
export type OnboardingReasonCode =
  | "everyapp_error"
  | "blocked"
  | "unknown_handoff"
  | "caps_exceeded"
  | "owner_link_not_shown"
  | "app_not_deployed_by_harness"
  | "owner_not_created_by_loop"
  | "tainted"
  | "shortcut"
  | "verifier_red"
  | "false_done";

/** Why a green run is only pass-with-intervention. */
export type InterventionReasonCode =
  | "nudge"
  | "repeated_answer"
  | "resume_after_exit"
  | "person_answer"
  | "no_done"
  | "harness_self_claimed";

/** Every reason code the decision table can attach to a verdict. */
export type ReasonCode =
  | InfraReasonCode
  | OnboardingReasonCode
  | InterventionReasonCode;

/** The decision with its flags, as recorded in run.json. */
export interface VerdictRecord {
  value: Verdict;
  /** `null` only for a clean pass. */
  reasonCode: ReasonCode | null;
  /** The harness printed DONE while a check was red. */
  falseDone: boolean;
  tainted: boolean;
  shortcut: boolean;
  /** The Gateway URL the harness printed with DONE, when it did. */
  reportedUrl: string | null;
}

// ---------------------------------------------------------------------------
// Teardown plan (5)
// ---------------------------------------------------------------------------

/** The resource kinds `everyapp teardown` lists, in its deletion order. */
export type PlanKind =
  | "access"
  | "email"
  | "workflows"
  | "workers"
  | "certificates"
  | "d1"
  | "kv"
  | "r2"
  | "hyperdrive"
  | "dns";

/** One thing the teardown found and would delete. */
export interface PlanItem {
  kind: PlanKind;
  /** The Cloudflare id when the kind has one. */
  id: string | null;
  /** The name a person recognises (Worker name, database name, hostname, record name). */
  name: string;
}

/** The teardown's `--dry-run` answer, flattened: what is in the account now; `total` must be 0 before a run. */
export interface Plan {
  accountId: string;
  items: PlanItem[];
  total: number;
  /** What the teardown never touches, as it said. */
  kept: string[];
  /** When the inventory was taken. */
  at: string;
}

// ---------------------------------------------------------------------------
// The per-run record (4.9)
// ---------------------------------------------------------------------------

/** Why the run ended. */
export type TerminalReason =
  | "completed"
  | "time_cap"
  | "budget"
  | "caps_exceeded"
  | "blocked"
  | "harness_exit"
  | "fixture_error"
  | "preflight_failed"
  | "driver_error"
  | "killed";

/** A departure from what a visitor would experience, named on every record. */
export type Deviation =
  | "checkout_preplaced"
  | "api_token_auth"
  | "event_log"
  | "claude_consent_seeded"
  | "local_docs"
  | "claim_immediate"
  | "d1_claim";

/** One everyapp invocation, from the event log: argv, flags, exit and the events it emitted. */
export interface EveryappCommand {
  argv: string[];
  cwd: string;
  json: boolean;
  ci: boolean;
  exit: number | null;
  ms: number | null;
  events: { warnings: string[]; actions: string[]; errors: string[] };
  endedBy: "exit" | "killed" | "unknown";
}

/** A timed phase of the run, for the wall / install / setup / cert / deploy columns. */
export interface Phase {
  name: string;
  startedAt: string;
  durationS: number;
}

/** An error seen in the run with who it belongs to. */
export interface RunError {
  code: string;
  step: string | null;
  source: "infra" | "cli" | "harness" | "loop";
  message: string;
}

/** How the owner was claimed and how fast. */
export interface ClaimStep {
  how: "event-log" | "d1" | "none";
  linkEmittedAt: string | null;
  claimedAt: string | null;
  latencyS: number | null;
  /** The est_ URL or an "open this link" sentence appeared in assistant text. */
  linkSurfacedToPerson: boolean;
}

/** Cost as the harness or a dated price table says it; Cursor is null with source none. */
export interface RunCost {
  usd: number | null;
  source: Signal["cost"];
  tokens: TokenCounts;
  model: string | null;
}

/** Redactor hit counts per secret; any non-zero prints ROTATE: and refuses the account or provider. */
export interface SecretExposure {
  cf_token: number;
  provider_key: number;
  est_link: number;
  owner_password: number;
  bearer: number;
}

/** The fields that make runs comparable: same key, same thing measured. */
export interface RunKey {
  harness: HarnessName;
  model: string | null;
  promptSha256: string;
  checkoutCommit: string;
  imageTag: string;
}

/** run.json, schema v1: everything the report, the ledger and `loop replay` read. */
export interface RunRecord {
  v: 1;
  runId: string;
  /** The fail-infra run this one repeats, with --repeat-on-infra. */
  retryOf: string | null;
  startedAt: string;
  finishedAt: string;
  durationS: number;
  terminal_reason: TerminalReason;
  substrate: {
    kind: "docker" | "modal";
    engine: string;
    image: { tag: string; platform: SandboxSpec["platform"] };
    vmMemoryGiB: number | null;
    statsPeakMiB: number | null;
  };
  /** Only the name: never the account id, zone or email. */
  account: { name: string };
  checkout: { commit: string; ref: string; how: "bundle" | "clone" };
  cli: { commit: string; version: string };
  agentDocs: { present: boolean; commit: string | null };
  prompt: { variant: "checkout-present" | "public"; sha256: string };
  deviations: Deviation[];
  fixtures: {
    workers_subdomain: "first-run" | "preexisting" | "unknown";
    zone: "preexisting";
    auth: "api_token";
    team: string | "n/a";
    cert_packs: "kept" | "deleted";
    docs_url: { status: number | null; final_url: string | null };
    preRunPlanTotal: number;
  };
  harness: {
    name: HarnessName;
    version: string;
    model: { requested: string | null; resolved: string | null };
    mode: HarnessMode | null;
    commandLine: string;
    permissionBypass: true;
  };
  signal: Signal;
  /** CI, TERM and SHELL as the running everyapp saw them. */
  toolEnv: { CI: string | null; TERM: string | null; SHELL: string | null };
  phases: Phase[];
  everyappCommands: EveryappCommand[];
  steps: {
    setup: {
      status: "done" | "error" | "action_required" | "never_ran";
      reruns: number;
    };
    claim: ClaimStep;
    app: {
      by: "harness" | "verifier" | "none";
      id: string | null;
      url: string | null;
    };
    access: { tried: boolean; team?: string; result?: VerifyResult["access"] };
  };
  handoffs: {
    expected: ExpectedHandoff[];
    exercised: ExpectedHandoff[];
    skippedBecause: Record<string, string>;
  };
  scriptedUserTurns: ScriptedUserReply[];
  interventions: Intervention[];
  interventionNeeded: boolean;
  hesitations: Hesitation[];
  harnessTimeouts: HarnessTimeout[];
  errors: RunError[];
  resumes: Resume[];
  verify: {
    phaseReached: PhaseReached;
    rows: Record<VerifyRowId, VerifyRowStatus>;
    /** The file in the run directory with the raw evidence. */
    evidence: string;
  };
  verdict: VerdictRecord;
  cost: RunCost;
  secret_exposure: SecretExposure;
  versions: {
    verifier: number;
    decisionTable: number;
    rules: number;
    parser: number;
  };
  artifacts: {
    transcript: string;
    eventLog: string;
    verify: string;
    diff: string;
  };
}

// ---------------------------------------------------------------------------
// Findings (4.11)
// ---------------------------------------------------------------------------

/** Who owns a finding. */
export type FindingRoute =
  | "cli"
  | "prompt"
  | "docs"
  | "skill"
  | "template"
  | "gateway"
  | "fixture"
  | "infra"
  | "loop";

/** A finding's status, computed from newer runs at newer commits. */
export type FindingStatus = "open" | "fixed" | "regressed" | "flaky";

/** One run that hit a finding. */
export interface FindingOccurrence {
  runId: string;
  harness: HarnessName;
  model: string | null;
  cliCommit: string;
  promptSha: string;
}

/** One ledger entry: id = sha1(area + ":" + key); key is code|step, an action, kind|argv|exit, or a regex id. */
export interface Finding {
  id: string;
  area: FindingRoute;
  key: string;
  status: FindingStatus;
  firstSeen: { runId: string; cliCommit: string; at: string };
  lastSeen: { runId: string; cliCommit: string; at: string };
  occurrences: FindingOccurrence[];
  /** At most 200 characters, redacted; agent output, untrusted. */
  excerpt: string;
  proposedFix: string | null;
  /** A TODO.md anchor or PR link once routed. */
  link: string | null;
}

// ---------------------------------------------------------------------------
// Lane C additions: the run logic's seams (harnesses, scripted user, claim,
// verifier, decision, findings). Additive; nothing above changed.
// ---------------------------------------------------------------------------

/** `fetch` as the claim and the verifier call it; the driver hands in one pinned to authoritative DNS (dns.ts). */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** A D1 query against the gateway database, through the account token (cf.ts owns the REST call). */
export interface D1Client {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/** Runs `everyapp status --json` in the sibling container and hands back the done event's data (null when it never came). */
export type StatusRunner = () => Promise<{
  exitCode: number | null;
  data: Record<string, unknown> | null;
  events: CliEvent[];
}>;

/** The scripted user's one secret, made per run and kept in memory. */
export interface OwnerCredentials {
  name: string;
  email: string;
  password: string;
}

/** What one POST /api/setup/claim ended as. */
export type ClaimOutcome =
  | { status: "claimed"; organizationId: string | null; at: string }
  /** The link was expired or consumed: setup reran, wait for the newest link. */
  | { status: "link_gone"; code: string; at: string }
  /** The owner already exists: the harness claimed it itself. */
  | { status: "already_claimed"; code: string; at: string }
  /** Transport or 5xx: retried with backoff. */
  | { status: "retryable"; reason: string; at: string }
  /** A 4xx the loop cannot fix. */
  | { status: "failed"; code: string; httpStatus: number; at: string };

/** Every reply or call the scripted user can decide on; the driver executes them. */
export type ScriptedUserAction =
  | {
      type: "reply";
      trigger: ScriptedUserTrigger;
      text: string;
      expected: boolean;
    }
  | {
      type: "register_workers_subdomain";
      subdomain: string;
      /** The reply to send once the PUT is done and 10 s have passed. */
      thenReply: string;
    }
  /** Something only the runbook fixes: the run is fail-infra, never answered. */
  | { type: "fixture_error"; code: string }
  /** A `setup` is still running inside the harness: wait, do not reply. */
  | { type: "wait"; reason: string; untilMs: number }
  | { type: "stop"; reason: "caps_exceeded" | "blocked" | "done" };

/** What the driver tells the scripted user; each maps to at most one action. */
export type ScriptedUserInput =
  | { kind: "assistant_text"; text: string }
  | {
      kind: "action_required";
      action: string;
      data: Record<string, unknown> | undefined;
    }
  | { kind: "cli_error"; code: string }
  | { kind: "setup_started" }
  | {
      kind: "setup_ended";
      /** `killed`: the process vanished with no exit line (the harness killed its background task). */
      status: "done" | "error" | "action_required" | "killed";
    }
  | { kind: "app_deployed" }
  | {
      kind: "turn_end";
      text: string;
      hadResultEvent: boolean;
    }
  | { kind: "person"; text: string };

/** The findings ledger file, docs/onboarding-loop/findings.json. */
export interface FindingsLedger {
  v: 1;
  findings: Finding[];
}

/** The whitelisted shape of a committed per-run file (4.10): never the zone, account id, host, email, session ids or raw text. */
export interface PublicRunRecord {
  v: 1;
  runId: string;
  retryOf: string | null;
  startedAt: string;
  durationS: number;
  terminal_reason: TerminalReason;
  harness: {
    name: HarnessName;
    version: string;
    model: { requested: string | null; resolved: string | null };
    mode: HarnessMode | null;
    permissionBypass: true;
  };
  signal: Signal;
  cliCommit: string;
  checkoutCommit: string;
  promptVariant: RunRecord["prompt"]["variant"];
  /** The first 12 characters of the prompt's sha256. */
  promptSha: string;
  imageTag: string;
  deviations: Deviation[];
  fixtures: {
    workers_subdomain: RunRecord["fixtures"]["workers_subdomain"];
    cert_packs: RunRecord["fixtures"]["cert_packs"];
    preRunPlanTotal: number;
  };
  phases: Phase[];
  everyappCommands: Array<{
    argv: string[];
    json: boolean;
    ci: boolean;
    exit: number | null;
    ms: number | null;
    warnings: string[];
    actions: string[];
    errors: string[];
  }>;
  steps: {
    setup: RunRecord["steps"]["setup"];
    claim: {
      how: ClaimStep["how"];
      latencyS: number | null;
      linkSurfacedToPerson: boolean;
    };
    app: { by: RunRecord["steps"]["app"]["by"]; id: string | null };
    access: { tried: boolean; result?: VerifyResult["access"] };
  };
  handoffs: RunRecord["handoffs"];
  scriptedUserTurns: Array<{
    trigger: ScriptedUserTrigger;
    expected: boolean;
  }>;
  interventions: Array<{
    source: Intervention["source"];
    kind: Intervention["kind"];
  }>;
  interventionNeeded: boolean;
  hesitations: Array<{
    kind: HesitationKind;
    excerpt: string;
    triage: Hesitation["triage"];
  }>;
  harnessTimeouts: HarnessTimeout[];
  errors: Array<{
    code: string;
    step: string | null;
    source: RunError["source"];
  }>;
  resumes: Array<{ reason: Resume["reason"]; how: Resume["how"] }>;
  verify: {
    phaseReached: PhaseReached;
    rows: Record<VerifyRowId, VerifyRowStatus>;
  };
  verdict: Omit<VerdictRecord, "reportedUrl"> & {
    reportedUrlMatched: boolean | null;
  };
  cost: RunCost;
  /** The record's counters with `est_link` renamed `setup_link`: a committed file never contains the string `est_`. */
  secret_exposure: Omit<SecretExposure, "est_link"> & { setup_link: number };
  versions: RunRecord["versions"];
}
