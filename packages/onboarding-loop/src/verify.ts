/**
 * The outside-in verifier (design 4.7): HTTP probes with `redirect:
 * "manual"` through a fetch pinned to authoritative DNS, and `everyapp
 * status --json` from a sibling container, never the harness's tree or
 * words. Rows G1..X1 in order; every probe's raw evidence goes to
 * verify.json so `loop replay` can recompute after a rule change.
 *
 * The fetch, the status runner, the clock and the sleep are arguments, so
 * the tests drive the whole table against fakes.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CliEvent,
  DiffEntry,
  FetchLike,
  NormalizedEvent,
  OwnerCredentials,
  PhaseReached,
  StatusRunner,
  VerifyResult,
  VerifyRow,
  VerifyRowId,
  VerifyRowStatus,
} from "./types";

export const VERIFIER_VERSION = 1;

/** Statuses that mean "still coming" at the edge: retried within the window. */
const EDGE_RETRY = new Set([502, 503, 520, 521, 522, 523, 524, 525, 526, 530]);
/** A fix code that depends on the verifier's own checkout, not the install. */
const IGNORED_FIXES = new Set(["CHECKOUT_BEHIND"]);
/** Fixes that settle by themselves: re-poll S1 while only these remain. */
const SETTLING_FIXES = new Set([
  "CERT_PENDING",
  "APP_BINDING",
  "DEPLOY_RUNNING",
]);
/** Paths under which a change is tampering (T1); noise removed first. */
const TAINT_ROOTS = [
  "/work/every-app/apps/every-app-gateway",
  "/work/every-app/packages",
  "/work/every-app/templates",
  "/work/every-app/starter",
];
/** Build output and caches under the roots: `pnpm install`, the release build (.cloudflare/output, .output, .tanstack, .nitro) and tsc leave these. */
const TAINT_NOISE =
  /\/(node_modules|dist|\.cache|\.turbo|\.wrangler|\.cloudflare|\.output|\.tanstack|\.nitro|release-package)(\/|$)|\.(log|tar\.gz|tsbuildinfo)$/;
/** The same roots as `git status` prints them, relative to the checkout. */
const TAINT_ROOTS_RELATIVE = TAINT_ROOTS.map((root) =>
  root.replace("/work/every-app/", ""),
);
/** Windows after G1 proved the gateway reachable: G2 and G3 need no 15 minutes of their own. */
const AFTER_G1_WINDOW_MS = 3 * 60_000;
/** Tool calls that go around the CLI (T1 shortcut). */
const SHORTCUT_PATTERN =
  /\bcf\s+d1\s+(query|execute)\b|\bwrangler\b|api\.cloudflare\.com/;

export interface VerifyContext {
  zone: string;
  /** https://apps.<zone> */
  gatewayOrigin: string;
  /** The app host the harness reported, or the one `create hello` implies; null when none. */
  appHost: string | null;
  owner: OwnerCredentials;
  /** From the claimer: how the owner was created. */
  claimHow: "event-log" | "d1" | "none";
  diff: DiffEntry[];
  /** The harness's normalized events (T1 shortcut detection). */
  events: NormalizedEvent[];
  /** The harness ran create + deploy itself (from the event log, or its tool calls when there is no event log). */
  harnessDeployedApp: boolean;
  withAccess: boolean;
  team: string | null;
  /** A string the template's signed-in page contains (A3). */
  templateMarker: string;
  /** A `*.apps.<zone>` DNS record exists, so an unknown app host reaches the gateway (G3's second probe); false or absent: that probe is skipped. */
  wildcardAppsRecord?: boolean;
  /** `git status --porcelain --untracked-files=all -- <roots>` in the harness's checkout, when it could be run: the precise taint source (T1). */
  gitStatus?: string[] | null;
  /**
   * The event log showed a Gateway upload (`setup.gateway` ok or skip, or a
   * `gateway.deploy` step). False: nothing can answer at the origin, so G1
   * probes once instead of waiting its window, and a run whose `setup` died
   * in the build ends in a minute, not sixteen; should G1 pass anyway (the
   * log was wrong about it), the rows after it keep their windows. Absent
   * (no event log to read, or no `setup` in it): the full windows.
   */
  gatewayUploaded?: boolean;
}

export interface VerifyDeps {
  fetchImpl: FetchLike;
  runStatus: StatusRunner;
  /** The verifier's own create + deploy, run only when the harness deployed no app; returns the app host or null. */
  deployProbe?: () => Promise<{ id: string; host: string } | null>;
  /** `access off --yes` after X1. */
  accessOff?: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Retry window per row; 15 minutes in production, milliseconds in tests. */
  windowMs?: number;
  pollMs?: number;
  /** Replaces the random label in G3. */
  randomLabel?: () => string;
}

interface ProbeEvidence {
  url: string;
  status: number | null;
  location: string | null;
  contentType: string | null;
  setCookie: boolean;
  body: string;
  error: string | null;
}

const BODY_LIMIT = 500;

/** A body excerpt for verify.json: est_ links, cookies and any `token` field cut out. */
function excerpt(text: string): string {
  return text
    .replace(/est_[A-Za-z0-9_-]{20,}/g, "<setup-link>")
    .replace(/(set-cookie|cookie)=[^;\s]+/gi, "$1=[redacted]")
    .replace(/"token"\s*:\s*"[^"]*"/g, '"token":"[redacted]"')
    .slice(0, BODY_LIMIT);
}

const sameEmail = (a: string | null, b: string): boolean =>
  a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

async function probe(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<ProbeEvidence> {
  try {
    const response = await fetchImpl(url, { redirect: "manual", ...init });
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    return {
      url,
      status: response.status,
      location: response.headers.get("location"),
      contentType: response.headers.get("content-type"),
      setCookie: response.headers.has("set-cookie"),
      body: excerpt(body),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? ` (${error.cause.message})`
        : "";
    return {
      url,
      status: null,
      location: null,
      contentType: null,
      setCookie: false,
      body: "",
      error: `${message}${cause}`.slice(0, 200),
    };
  }
}

/** A transport failure or an edge status that the window retries. */
function retryable(evidence: ProbeEvidence, more: number[] = []): boolean {
  if (evidence.status === null) return true;
  return EDGE_RETRY.has(evidence.status) || more.includes(evidence.status);
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function detectShortcut(events: NormalizedEvent[]): boolean {
  return events.some(
    (event) =>
      event.kind === "tool_call" &&
      SHORTCUT_PATTERN.test(
        [event.text ?? "", ...(event.argv ?? [])].join(" "),
      ),
  );
}

/**
 * Tampering from `docker diff`: files under the roots, minus build noise.
 * `docker diff` prints a `C` line for every ancestor directory of a changed
 * file (`C /work/every-app/packages` after `pnpm install`), so an entry
 * that another entry extends is a directory, not a change.
 */
export function detectTaint(diff: DiffEntry[]): DiffEntry[] {
  const paths = new Set(diff.map((entry) => entry.path));
  const isDirectory = (entry: DiffEntry): boolean => {
    const prefix = `${entry.path}/`;
    for (const other of paths) if (other.startsWith(prefix)) return true;
    return false;
  };
  return diff.filter(
    (entry) =>
      TAINT_ROOTS.some(
        (root) => entry.path === root || entry.path.startsWith(`${root}/`),
      ) &&
      !TAINT_NOISE.test(entry.path) &&
      !isDirectory(entry),
  );
}

/**
 * Tampering from `git status --porcelain --untracked-files=all` over the
 * roots in the harness's checkout: a tracked file modified or deleted, or an
 * untracked file git does not ignore (build output is gitignored and never
 * shows). Exactly what tampering means; preferred over the diff when the
 * container could still run git.
 */
export function taintFromGitStatus(lines: string[]): DiffEntry[] {
  return lines.flatMap((line) => {
    const match = /^(..) (?:.* -> )?(.+)$/.exec(line);
    if (!match) return [];
    const [, status, rawPath] = match;
    const path = rawPath!.replace(/^"|"$/g, "");
    if (
      !TAINT_ROOTS_RELATIVE.some(
        (root) => path === root || path.startsWith(`${root}/`),
      ) ||
      TAINT_NOISE.test(`/${path}`)
    )
      return [];
    const kind =
      status === "??" ? "added" : status!.includes("D") ? "deleted" : "changed";
    return [{ kind, path: `/work/every-app/${path}` }];
  });
}

interface StatusView {
  claimed: boolean;
  ownerEmail: string | null;
  upToDate: boolean | null;
  apps: Array<{
    id: string;
    status: string;
    bound: boolean;
    hostname: string | null;
  }>;
  fixes: Array<{ code: string; severity: string }>;
  blocking: string[];
  settling: string[];
}

/** The parts of `status --json`'s done.data that S1 reads. */
export function statusView(
  data: Record<string, unknown> | null,
): StatusView | null {
  if (!data) return null;
  const owner =
    typeof data["owner"] === "object" && data["owner"] !== null
      ? (data["owner"] as Record<string, unknown>)
      : null;
  const apps = Array.isArray(data["apps"])
    ? data["apps"].flatMap((app) => {
        if (typeof app !== "object" || app === null) return [];
        const record = app as Record<string, unknown>;
        return [
          {
            id: String(record["id"] ?? ""),
            status: String(record["status"] ?? ""),
            bound: record["bound"] === true,
            hostname:
              typeof record["hostname"] === "string"
                ? record["hostname"]
                : null,
          },
        ];
      })
    : [];
  const fixes = Array.isArray(data["fixes"])
    ? data["fixes"].flatMap((fix) => {
        if (typeof fix !== "object" || fix === null) return [];
        const record = fix as Record<string, unknown>;
        return [
          {
            code: String(record["code"] ?? ""),
            severity: String(record["severity"] ?? ""),
          },
        ];
      })
    : [];
  const blocking = fixes
    .filter(
      (fix) =>
        (fix.severity === "error" || fix.severity === "warning") &&
        !IGNORED_FIXES.has(fix.code),
    )
    .map((fix) => fix.code);
  const settling = fixes
    .filter(
      (fix) => SETTLING_FIXES.has(fix.code) || fix.severity === "settling",
    )
    .map((fix) => fix.code);
  return {
    claimed: data["claimed"] === true,
    ownerEmail:
      owner && typeof owner["email"] === "string" ? owner["email"] : null,
    upToDate: typeof data["upToDate"] === "boolean" ? data["upToDate"] : null,
    apps,
    fixes,
    blocking,
    settling,
  };
}

/** The ladder, from status codes and the probes (design 4.7). */
export function phaseReachedFrom(
  rows: Record<VerifyRowId, VerifyRowStatus>,
  status: StatusView | null,
  access: VerifyResult["access"],
): PhaseReached {
  if (access === "pass") return "access";
  if (rows.A1 === "pass" && rows.A2 === "pass") return "app-live";
  const live =
    status?.apps.some((app) => app.status === "active" && app.bound) ?? false;
  if (live || rows.A1 === "pass") return "app-deployed";
  if ((status?.apps.length ?? 0) > 0) return "app-created";
  if (status?.claimed || rows.O1 === "pass") return "owner";
  if (rows.G1 === "pass" || rows.G2 === "pass") return "gateway-uploaded";
  if (status) return "gateway-db";
  return "none";
}

export async function verify(
  ctx: VerifyContext,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const now = deps.now ?? (() => new Date());
  const windowMs = deps.windowMs ?? 15 * 60_000;
  const pollMs = deps.pollMs ?? 10_000;
  const rows = {} as Record<VerifyRowId, VerifyRow>;

  /** Run a probe until it passes or the window closes on a retryable answer. */
  const row = async (
    id: VerifyRowId,
    attempt: () => Promise<{
      pass: boolean;
      retry: boolean;
      evidence: unknown;
      note?: string;
      status?: VerifyRowStatus;
    }>,
    windowForRow = windowMs,
  ): Promise<VerifyRow> => {
    const startedAt = now().toISOString();
    const deadline = now().getTime() + windowForRow;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const result = await attempt();
      const expired = now().getTime() >= deadline;
      if (result.pass || !result.retry || expired) {
        const finished: VerifyRow = {
          id,
          status: result.status ?? (result.pass ? "pass" : "fail"),
          attempts,
          startedAt,
          finishedAt: now().toISOString(),
          evidence: result.evidence,
          ...(result.note ? { note: result.note } : {}),
        };
        rows[id] = finished;
        return finished;
      }
      await deps.sleep(pollMs);
    }
  };

  const origin = ctx.gatewayOrigin;
  // The event log says nothing was uploaded: G1 is evidence of that, not a wait for it. Only G1:
  // a G1 that passes refutes the log, and then a fresh app's 503 app_deploying is waited out as ever.
  const noUpload = ctx.gatewayUploaded === false;

  // G1: the sign-in page answers with valid TLS.
  const g1 = await row(
    "G1",
    async () => {
      const e = await probe(deps.fetchImpl, `${origin}/sign-in`);
      const pass = e.status === 200;
      return {
        pass,
        retry: !pass && retryable(e),
        evidence: e,
        note: pass ? undefined : `expected 200, got ${e.status ?? e.error}`,
      };
    },
    noUpload ? 0 : windowMs,
  );
  // Past G1's window with no gateway, the rest is evidence, not a wait: one attempt each.
  const gatewayDown = g1.status !== "pass";
  const laterWindow = gatewayDown ? 0 : Math.min(windowMs, AFTER_G1_WINDOW_MS);

  // G2: the claim endpoint's fingerprint: 403 ORIGIN_NOT_ALLOWED without an Origin.
  await row(
    "G2",
    async () => {
      const e = await probe(deps.fetchImpl, `${origin}/api/setup/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const pass = e.status === 403 && /ORIGIN_NOT_ALLOWED/.test(e.body);
      return {
        pass,
        retry: !pass && retryable(e),
        evidence: e,
        note: pass
          ? undefined
          : `expected 403 ORIGIN_NOT_ALLOWED, got ${e.status ?? e.error}`,
      };
    },
    laterWindow,
  );

  // G3: /api/me/apps is 401. An unknown app host is 404 unknown_app_host only when a `*.apps.<zone>`
  // record exists; setup creates none (app hosts are per-app Custom Domains), so without one the
  // host is NXDOMAIN and the probe is skipped, not failed.
  await row(
    "G3",
    async () => {
      const me = await probe(deps.fetchImpl, `${origin}/api/me/apps`);
      const meOk = me.status === 401;
      if (!ctx.wildcardAppsRecord) {
        return {
          pass: meOk,
          retry: !meOk && retryable(me),
          evidence: {
            me,
            nope: {
              skipped: "no *.apps.<zone> record: the host would be NXDOMAIN",
            },
          },
          note: meOk ? undefined : `me=${me.status ?? me.error}`,
        };
      }
      const label = (
        deps.randomLabel ?? (() => randomBytes(4).toString("hex"))
      )();
      const nope = await probe(
        deps.fetchImpl,
        `https://nope-${label}.apps.${ctx.zone}/`,
      );
      const pass =
        meOk && nope.status === 404 && /unknown_app_host/.test(nope.body);
      return {
        pass,
        retry: !pass && (retryable(me) || retryable(nope)),
        evidence: { me, nope },
        note: pass
          ? undefined
          : `me=${me.status ?? me.error} nope=${nope.status ?? nope.error}`,
      };
    },
    laterWindow,
  );

  // O1: sign in as the owner the loop created; the session's email is the loop's. Better Auth answers
  // the sign-in with `{ redirect, token, user }`: the token is a bearer for the owner, so the body
  // is never kept; only its error code is, when there is one.
  let cookie: string | null = null;
  let harnessSelfClaimed = false;
  await row(
    "O1",
    async () => {
      let signIn: ProbeEvidence;
      let setCookie: string | null = null;
      let code: string | null = null;
      try {
        const response = await deps.fetchImpl(
          `${origin}/api/auth/sign-in/email`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              origin,
              accept: "application/json",
            },
            body: JSON.stringify({
              email: ctx.owner.email,
              password: ctx.owner.password,
            }),
          },
        );
        setCookie = response.headers.get("set-cookie");
        const body = await response.text().catch(() => "");
        const parsed = parseJson(body);
        code =
          parsed && typeof parsed["code"] === "string"
            ? parsed["code"]
            : parsed && typeof parsed["message"] === "string"
              ? parsed["message"].slice(0, 80)
              : null;
        signIn = {
          url: `${origin}/api/auth/sign-in/email`,
          status: response.status,
          location: response.headers.get("location"),
          contentType: response.headers.get("content-type"),
          setCookie: setCookie !== null,
          body: "[sign-in body not kept]",
          error: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        signIn = {
          url: `${origin}/api/auth/sign-in/email`,
          status: null,
          location: null,
          contentType: null,
          setCookie: false,
          body: "",
          error: message,
        };
      }
      if (signIn.status !== 200 || !setCookie) {
        // A 401 here says the loop's password does not open the owner row: whose it is, S1's
        // owner.email and the claimer's ALREADY_CLAIMED decide; the code goes in the note.
        return {
          pass: false,
          retry: retryable(signIn),
          evidence: { signIn, code, session: null },
          note: `sign-in ${signIn.status ?? signIn.error}${code ? ` ${code}` : ""}`,
        };
      }
      cookie = setCookie
        .split(/,(?=[^;]+?=)/)
        .map((part) => part.split(";")[0]!.trim())
        .join("; ");
      const session = await probe(
        deps.fetchImpl,
        `${origin}/api/auth/get-session`,
        { headers: { cookie, accept: "application/json" } },
      );
      const parsed = parseJson(session.body);
      const user =
        parsed && typeof parsed["user"] === "object" && parsed["user"] !== null
          ? (parsed["user"] as Record<string, unknown>)
          : null;
      const email =
        user && typeof user["email"] === "string" ? user["email"] : null;
      const matched = sameEmail(email, ctx.owner.email);
      const pass = session.status === 200 && matched;
      if (session.status === 200 && email && !matched)
        harnessSelfClaimed = true;
      return {
        pass,
        retry: !pass && retryable(session),
        evidence: {
          signIn,
          session: { ...session, body: "[session body not kept]" },
          emailMatched: matched,
        },
        note: pass
          ? undefined
          : email
            ? "session email is not the loop's owner"
            : `get-session ${session.status ?? session.error}`,
      };
    },
    gatewayDown ? 0 : windowMs,
  );

  // The app: by the harness, or the verifier's own probe when the harness deployed none.
  let appDeploy: VerifyResult["appDeploy"] = {
    by: "none",
    id: null,
    url: null,
  };
  let appHost = ctx.appHost;
  if (ctx.harnessDeployedApp && appHost) {
    appDeploy = {
      by: "harness",
      id: appHost.split(".")[0] ?? null,
      url: `https://${appHost}`,
    };
  } else if (!gatewayDown) {
    // The event log said nothing (no seam in the commit under test, or a killed CLI): the registry
    // knows. The account was wiped before the run and the verifier has deployed nothing yet, so any
    // app `status` lists is the harness's.
    const peek = statusView((await deps.runStatus()).data);
    const registered = peek?.apps.find((app) => app.id) ?? null;
    if (registered) {
      appHost = registered.hostname ?? `${registered.id}.apps.${ctx.zone}`;
      appDeploy = {
        by: "harness",
        id: registered.id,
        url: `https://${appHost}`,
      };
    } else if (deps.deployProbe) {
      const deployed = await deps.deployProbe();
      if (deployed) {
        appHost = deployed.host;
        appDeploy = {
          by: "verifier",
          id: deployed.id,
          url: `https://${deployed.host}`,
        };
      }
    }
  }

  if (appHost) {
    const appUrl = `https://${appHost}/`;
    const appWindow = gatewayDown ? 0 : windowMs;
    // A1: the first visit activates a binding app; 302 to the gateway sign-in with return_to.
    await row(
      "A1",
      async () => {
        const e = await probe(deps.fetchImpl, appUrl, {
          headers: { accept: "text/html" },
        });
        const pass =
          e.status === 302 &&
          (e.location ?? "").startsWith(`${origin}/sign-in?return_to=`);
        const note = pass
          ? undefined
          : e.status === 200
            ? "200 on the app host: the template has no public routes (finding)"
            : e.status === 404
              ? "404: not deployed"
              : `expected 302 to sign-in, got ${e.status ?? e.error}`;
        return {
          pass,
          retry: !pass && retryable(e, [503]),
          evidence: e,
          note,
        };
      },
      appWindow,
    );
    // A2: without Accept, 401 unauthenticated.
    await row(
      "A2",
      async () => {
        const e = await probe(deps.fetchImpl, appUrl);
        const pass = e.status === 401 && /unauthenticated/.test(e.body);
        return {
          pass,
          retry: !pass && retryable(e, [503]),
          evidence: e,
          note: pass
            ? undefined
            : `expected 401 unauthenticated, got ${e.status ?? e.error}`,
        };
      },
      appWindow,
    );
    // A3: with the owner cookie, the template page; perimeter-only until the cookie domain covers *.apps.<zone>.
    await row(
      "A3",
      async () => {
        if (!cookie)
          return {
            pass: false,
            retry: false,
            evidence: null,
            status: "perimeter-only",
            note: "no owner cookie (O1 failed)",
          };
        const e = await probe(deps.fetchImpl, appUrl, {
          headers: { accept: "text/html", cookie },
        });
        const pass = e.status === 200 && e.body.includes(ctx.templateMarker);
        return {
          pass,
          retry: !pass && retryable(e, [503]),
          evidence: e,
          status: pass ? "pass" : "perimeter-only",
          note: pass
            ? undefined
            : `expected 200 with "${ctx.templateMarker}", got ${e.status ?? e.error}`,
        };
      },
      appWindow,
    );
  } else {
    for (const id of ["A1", "A2", "A3"] as const) {
      const at = now().toISOString();
      rows[id] = {
        id,
        status: "fail",
        attempts: 0,
        startedAt: at,
        finishedAt: at,
        evidence: null,
        note: "no app deployed",
      };
    }
  }

  // S1: status --json from the sibling container; re-poll while only settling items remain.
  let status: StatusView | null = null;
  await row(
    "S1",
    async () => {
      const run = await deps.runStatus();
      status = statusView(run.data);
      if (!status) {
        // No done event: `GATEWAY_NOT_FOUND` (nothing installed) and any other error code are
        // final; only a status that died with no error at all (a timeout) is asked again.
        const errors = errorsOf(run.events);
        return {
          pass: false,
          retry: !gatewayDown && errors.every((e) => e.type !== "error"),
          evidence: { exitCode: run.exitCode, events: errors },
          note: `status printed no done event${errors.length ? ` (${errors.map((e) => e.code).join(", ")})` : ""}`,
        };
      }
      const live = status.apps.filter(
        (app) => app.status === "active" && app.bound,
      );
      const ownerMatched = sameEmail(status.ownerEmail, ctx.owner.email);
      const ownerOk = status.claimed && ownerMatched;
      const problems: string[] = [];
      if (!status.claimed) problems.push("claimed=false");
      else if (!ownerMatched) {
        problems.push("owner is not the loop's");
        // An owner row with another email: someone else claimed the link.
        if (status.ownerEmail) harnessSelfClaimed = true;
      }
      if (status.blocking.length > 0) problems.push(...status.blocking);
      if (live.length === 0) problems.push("no app active && bound");
      if (status.upToDate !== true)
        problems.push(`upToDate=${status.upToDate}`);
      const nonHello = live
        .filter((app) => app.id !== "hello")
        .map((app) => app.id);
      const pass = problems.length === 0 && ownerOk;
      const onlySettling =
        status.blocking.every((code) => SETTLING_FIXES.has(code)) &&
        (status.settling.length > 0 || live.length === 0);
      const evidence = {
        exitCode: run.exitCode,
        claimed: status.claimed,
        ownerMatched,
        upToDate: status.upToDate,
        apps: status.apps.map((app) => ({
          id: app.id,
          status: app.status,
          bound: app.bound,
        })),
        fixes: status.fixes,
        problems,
      };
      return {
        pass,
        retry:
          !pass &&
          onlySettling &&
          problems.every(
            (p) => SETTLING_FIXES.has(p) || p === "no app active && bound",
          ),
        evidence,
        note: pass
          ? nonHello.length
            ? `app named ${nonHello.join(", ")}, not hello (finding)`
            : undefined
          : problems.join("; "),
      };
    },
    gatewayDown ? 0 : windowMs,
  );

  // T1: tamper and shortcut. `git status` from the harness's checkout when it could be run, else the diff.
  const taint = ctx.gitStatus
    ? taintFromGitStatus(ctx.gitStatus)
    : detectTaint(ctx.diff);
  const shortcut = detectShortcut(ctx.events);
  const ownerNotCreatedByLoop =
    (status as StatusView | null)?.claimed === true && ctx.claimHow === "none";
  {
    const at = now().toISOString();
    const notes = [
      taint.length
        ? `tainted: ${taint.length} change(s) under the gateway, packages or templates`
        : null,
      shortcut
        ? "shortcut: a tool call used cf d1 query|execute, wrangler or api.cloudflare.com"
        : null,
      ownerNotCreatedByLoop ? "owner_not_created_by_loop" : null,
    ].filter((n): n is string => n !== null);
    rows.T1 = {
      id: "T1",
      status: notes.length === 0 ? "pass" : "fail",
      attempts: 1,
      startedAt: at,
      finishedAt: at,
      evidence: {
        taint: taint.map((e) => `${e.kind} ${e.path}`),
        taintSource: ctx.gitStatus ? "git-status" : "docker-diff",
        shortcut,
        ownerNotCreatedByLoop,
      },
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  }

  // X1: Access, only with --with-access and after O1.
  let access: VerifyResult["access"] = "skipped";
  if (ctx.withAccess && ctx.team) {
    const team = ctx.team;
    const result = await row(
      "X1",
      async () => {
        const e = await probe(deps.fetchImpl, `${origin}/`, {
          headers: { accept: "text/html" },
        });
        const pass =
          e.status === 302 &&
          (e.location ?? "").startsWith(
            `https://${team}.cloudflareaccess.com/cdn-cgi/access/login/`,
          );
        return {
          pass,
          retry: !pass && e.status !== 302,
          evidence: e,
          note: pass
            ? undefined
            : `expected 302 to ${team}.cloudflareaccess.com, got ${e.status ?? e.error}`,
        };
      },
      Math.min(windowMs, 2 * 60_000),
    );
    access = result.status === "pass" ? "pass" : "fail";
    if (deps.accessOff) {
      await deps.accessOff();
      await row("G1", async () => {
        const e = await probe(deps.fetchImpl, `${origin}/sign-in`);
        const pass = e.status === 200;
        return {
          pass,
          retry: !pass && retryable(e),
          evidence: { afterAccessOff: true, ...e },
        };
      });
    }
  } else {
    const at = now().toISOString();
    rows.X1 = {
      id: "X1",
      status: "skipped",
      attempts: 0,
      startedAt: at,
      finishedAt: at,
      evidence: null,
      note: ctx.withAccess ? "no team" : "no --with-access",
    };
  }

  const statuses = Object.fromEntries(
    (Object.keys(rows) as VerifyRowId[]).map((id) => [id, rows[id].status]),
  ) as Record<VerifyRowId, VerifyRowStatus>;

  return {
    version: VERIFIER_VERSION,
    phaseReached: phaseReachedFrom(statuses, status, access),
    rows,
    tainted: taint.length > 0,
    shortcut,
    ownerNotCreatedByLoop,
    harnessSelfClaimed,
    access,
    appDeploy,
  };
}

function errorsOf(events: CliEvent[]): Array<{ type: string; code: string }> {
  return events.flatMap((event) =>
    event.type === "error" || event.type === "warning"
      ? [{ type: event.type, code: event.code }]
      : [],
  );
}

/** The rows as run.json carries them (statuses only; the evidence stays in verify.json). */
export function rowStatuses(
  result: VerifyResult,
): Record<VerifyRowId, VerifyRowStatus> {
  return Object.fromEntries(
    (Object.keys(result.rows) as VerifyRowId[]).map((id) => [
      id,
      result.rows[id].status,
    ]),
  ) as Record<VerifyRowId, VerifyRowStatus>;
}

/** A row is green when it passed or was legitimately skipped; perimeter-only counts as green for A3 (design 4.7). */
export function allRowsGreen(result: VerifyResult): boolean {
  return (Object.keys(result.rows) as VerifyRowId[]).every((id) => {
    const status = result.rows[id].status;
    if (status === "pass") return true;
    if (id === "X1" && status === "skipped") return true;
    if (id === "A3" && status === "perimeter-only") return true;
    return false;
  });
}

/** verify.json in the run directory, through the run's redactor when given one (the owner password is in it). */
export function writeVerifyEvidence(
  runDir: string,
  result: VerifyResult,
  redact: (text: string) => string = (text) => text,
): string {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, "verify.json");
  writeFileSync(path, redact(`${JSON.stringify(result, null, 2)}\n`), {
    mode: 0o600,
  });
  return path;
}
