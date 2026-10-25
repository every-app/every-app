/**
 * Typed errors for `cf` child processes.
 *
 * cf reports failures on stderr as a box and exits 1:
 *
 *   ┌ Error
 *   │ Expected a D1 database ID, but received <database>="DB". Database names and
 *   │ binding names are not accepted.
 *   └
 *
 * Cloudflare API failures come in an `APIError` box that starts with the
 * code, `[10200] workflows.api.error.workflow.not_found`, or end in
 * `[code: N]`. The kinds below are what callers branch on; the matching
 * strings come from cf's own output and source, and the plan and subdomain
 * ones are unverified until a live account run.
 */
import { outputTail } from "@/lib/output/text";
type CfErrorKind =
  | "auth"
  | "not_found"
  | "already_exists"
  | "aborted"
  | "strict_conflict"
  | "subdomain_missing"
  | "free_plan"
  | "email_unverified"
  | "r2_not_enabled"
  | "access_not_enabled"
  | "d1_id_rejected"
  | "unknown";

interface ParsedCfError {
  message: string;
  apiCodes: number[];
  kind: CfErrorKind;
}

export class CfError extends Error {
  readonly kind: CfErrorKind;
  readonly apiCodes: number[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    parsed: ParsedCfError,
    details: { exitCode: number | null; stderr: string; stdout?: string },
  ) {
    super(parsed.message);
    this.name = "CfError";
    this.kind = parsed.kind;
    this.apiCodes = parsed.apiCodes;
    this.exitCode = details.exitCode;
    this.stderr = details.stderr;
    this.stdout = details.stdout ?? "";
  }
}

/** `error` is cf's, of `kind` (`not_found`, `already_exists`…). */
export function isCfError(error: unknown, kind: CfErrorKind): error is CfError {
  return error instanceof CfError && error.kind === kind;
}

/**
 * Cloudflare refused because the account hasn't enabled the service at all
 * (R2 through the dashboard, Zero Trust through its onboarding): there is
 * nothing of that service's in the account, which isn't a failed read.
 */
export function isServiceNotEnabled(error: unknown): error is CfError {
  return isCfError(error, "r2_not_enabled") || isCfError(error, "access_not_enabled");
}

/** A cf call that ran past its time limit; its process group was killed. */
export class CfTimeoutError extends Error {
  constructor(command: string, timeoutMs: number, lastStderrLine?: string) {
    super(
      `\`${command}\` did not finish within ${Math.round(timeoutMs / 1000)}s` +
        (lastStderrLine ? ` (last output: ${lastStderrLine})` : ""),
    );
    this.name = "CfTimeoutError";
  }
}

/** A cf call that succeeded but printed something other than the expected JSON. */
export class CfOutputError extends Error {
  constructor(command: string, problem: string) {
    super(`Unexpected output from \`${command}\`: ${problem}`);
    this.name = "CfOutputError";
  }
}

/**
 * cf's strict-mode abort at the upload (a Worker changed in the dashboard or
 * through the API, run without a terminal). cf 1.0.0-beta.14 prints it on
 * stdout with no box on stderr and exits 1, so it is looked for in both.
 */
const STRICT_CONFLICT = /Aborting the upload operation because of conflicts/;

const KIND_RULES: Array<
  [CfErrorKind, (text: string, codes: number[]) => boolean]
> = [
  ["d1_id_rejected", (text) => /Expected a D1 database ID/.test(text)],
  [
    "subdomain_missing",
    (text) => /workers\.dev subdomain|\/workers\/onboarding/.test(text),
  ],
  ["email_unverified", (_text, codes) => codes.includes(10034)],
  ["r2_not_enabled", (_text, codes) => codes.includes(10042)],
  // An account that never opened Zero Trust: `[9999] access.api.error.not_enabled`,
  // 403, on every Access endpoint (seen live on a fresh account, 2026-10-24).
  ["access_not_enabled", (text) => /access\.api\.error\.not_enabled/.test(text)],
  ["free_plan", (text) => /Workers Paid|paid plan/i.test(text)],
  [
    "auth",
    // 10000: authentication error (also a token without the permission);
    // 9109: not allowed to access the resource.
    (text, codes) =>
      codes.includes(10000) ||
      codes.includes(9109) ||
      /No authentication token found|Not logged in|cf auth login/.test(text),
  ],
  [
    "already_exists",
    // D1 (7502) and KV (10014) refuse a second resource with the same name;
    // Vectorize says `[3002] vectorize.index.duplicate_name` (409), matched
    // by its slug: its codes are small numbers another API could reuse.
    (text, codes) =>
      codes.includes(7502) ||
      codes.includes(10014) ||
      /\bvectorize\.index\.duplicate_name\b/.test(text) ||
      /\balready exists\b/i.test(text),
  ],
  [
    "not_found",
    // 10007: Worker, 10009: KV key, 7404: D1 database, 10200: Workflow.
    // Vectorize: `[3000] vectorize.index.not_found` (404), and for a while
    // after a delete `[3005] vectorize.index.deleted` (410), which is gone
    // all the same: a create of the name succeeds at once (seen live
    // 2026-10-24).
    (text, codes) =>
      codes.includes(10007) ||
      codes.includes(10009) ||
      codes.includes(7404) ||
      codes.includes(10200) ||
      /\bvectorize\.index\.(not_found|deleted)\b/.test(text) ||
      /\bnot found\b|does not exist/i.test(text),
  ],
];

/**
 * cf asks before anything destructive (`d1 delete`, `kv namespaces delete`,
 * `workers delete`, `d1 time-travel restore`) unless it gets `--force`.
 * Without a terminal it answers no for us, prints `Aborted.` and exits 0,
 * as if it had done the thing; that is a failure.
 */
export function abortedCfError(command: string, stderr: string): CfError | null {
  if (!/^Aborted\.$/m.test(stderr)) return null;
  return new CfError(
    {
      message: `\`${command}\` asked for a confirmation no one could give, and did nothing (it printed "Aborted.").`,
      apiCodes: [],
      kind: "aborted",
    },
    { exitCode: 0, stderr },
  );
}

/**
 * Pull the message, API codes and kind out of what cf printed: the error
 * box on stderr, or else the last lines of its output.
 */
export function parseCfOutput(stderr: string, stdout = ""): ParsedCfError {
  const message = boxedMessage(stderr) ?? lastLines(stdout, stderr);
  const apiCodes = [...message.matchAll(/\[(?:code: )?(\d{4,})\]/g)].map(
    (match) => Number(match[1]),
  );
  const kind = STRICT_CONFLICT.test(`${stdout}\n${stderr}`)
    ? "strict_conflict"
    : (KIND_RULES.find(([, matches]) => matches(message, apiCodes))?.[0] ??
      "unknown");
  return { message, apiCodes, kind };
}

function boxedMessage(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/);
  const start = lines.findIndex((line) => /^┌\s*(API)?Error/.test(line.trim()));
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("└")) break;
    body.push(trimmed.replace(/^│ ?/, ""));
  }
  const message = joinWrapped(body);
  return message.length > 0 ? message : undefined;
}

/**
 * cf wraps the box text at the terminal width. Rejoin wrapped lines into
 * paragraphs, keeping blank lines and indented list items as breaks.
 */
function joinWrapped(lines: string[]): string {
  const paragraphs: string[] = [];
  let current = "";
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current) paragraphs.push(current);
      paragraphs.push("");
      current = "";
    } else if (/^\s/.test(line) || /^\d+\./.test(line.trim())) {
      if (current) paragraphs.push(current);
      current = line.trimEnd();
    } else {
      current = current ? `${current} ${line.trim()}` : line.trim();
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Without a box, what cf printed last: a build's error, say. */
function lastLines(...outputs: string[]): string {
  return outputTail(...outputs).join("\n") || "cf failed without an error message";
}
