/**
 * The owner claim (design 4.5), never from the harness stream.
 *
 * Primary: tail the CLI's event log; within seconds of
 * `action_required claim_owner` POST /api/setup/claim with the token from
 * data.url, `Origin` set to the gateway origin, through a fetch pinned to
 * the zone's authoritative nameservers. Retry with backoff up to 10 minutes
 * on dns, tls, 5xx and ECONNRESET; never on 4xx, except an expired or
 * consumed link, which means setup reran: wait for the newest link.
 *
 * Fallback and control mode (--no-event-log): poll the gateway D1 for a
 * fresh unconsumed claim row, replace its hash with one the loop knows, and
 * POST the same claim. `setup`'s own 5-second poll then finishes the step.
 *
 * Both paths take their fetch, D1 client, tail and clock as arguments so
 * the tests run them against fakes.
 */
import { createHash, randomBytes } from "node:crypto";
import type {
  ClaimOutcome,
  CliEvent,
  D1Client,
  EventLogLine,
  FetchLike,
  OwnerCredentials,
} from "./types";

export const CLAIM_RETRY_WINDOW_MS = 10 * 60_000;
export const CLAIM_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
export const D1_POLL_MS = 5_000;
const OWNER_NAME = "Loop Owner";

/** Codes the gateway answers when the link is gone (setup reran or the link aged out). */
const LINK_GONE = /EXPIRED|CONSUMED|INVALID_OR_EXPIRED|SETUP_LINK/i;
const ALREADY_CLAIMED = /ALREADY_CLAIMED|USER_ALREADY_EXISTS|OWNER_EXISTS/i;

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** A fresh token in the CLI's own format, for the D1-side claim. */
export const mintToken = () => `est_${randomBytes(32).toString("base64url")}`;

/** The per-run owner credentials: the password lives in memory only. The gateway lowercases the email, so the loop does too. */
export function ownerCredentials(email: string): OwnerCredentials {
  return {
    name: OWNER_NAME,
    email: email.trim().toLowerCase(),
    password: randomBytes(18).toString("base64url"),
  };
}

/** One line of the event log parsed, or null for a blank or broken line. */
export function parseEventLogLine(line: string): EventLogLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record["type"] !== "string") return null;
    return record as unknown as EventLogLine;
  } catch {
    return null;
  }
}

/** The est_ token in a setup link, wherever it is: `#token=est_…` or a bare token. */
export function tokenFromUrl(url: string): string | null {
  const match = /(?:[#?&]token=)?(est_[A-Za-z0-9_-]{20,})/.exec(url);
  return match ? match[1]! : null;
}

/** The claim link in a CLI event, when the event is `action_required claim_owner` with a URL. */
export function claimLinkOf(
  event: EventLogLine | CliEvent,
): { url: string; token: string; expiresAt: string | null } | null {
  if (event.type !== "action_required" || event.action !== "claim_owner")
    return null;
  const url =
    typeof event.data?.["url"] === "string" ? event.data["url"] : null;
  if (!url) return null;
  const token = tokenFromUrl(url);
  if (!token) return null;
  const expiresAt =
    typeof event.data?.["expiresAt"] === "string"
      ? event.data["expiresAt"]
      : null;
  return { url, token, expiresAt };
}

interface ClaimRequest {
  fetchImpl: FetchLike;
  gatewayOrigin: string;
  token: string;
  owner: OwnerCredentials;
  now?: () => Date;
}

/** One POST of the claim; the outcome says whether to retry, wait for a newer link, or stop. */
export async function postClaim(request: ClaimRequest): Promise<ClaimOutcome> {
  const at = (request.now ?? (() => new Date()))().toISOString();
  let response: Response;
  try {
    response = await request.fetchImpl(
      `${request.gatewayOrigin}/api/setup/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: request.gatewayOrigin,
          accept: "application/json",
        },
        body: JSON.stringify({
          token: request.token,
          name: request.owner.name,
          email: request.owner.email,
          password: request.owner.password,
        }),
        redirect: "manual",
      },
    );
  } catch (error) {
    return { status: "retryable", reason: transportReason(error), at };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null)
      body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: a 52x page or an empty body; the status says enough.
  }
  const code =
    typeof body["error"] === "string"
      ? body["error"]
      : `HTTP_${response.status}`;
  if (response.ok && body["ok"] === true) {
    const organizationId =
      typeof body["organizationId"] === "string"
        ? body["organizationId"]
        : null;
    return { status: "claimed", organizationId, at };
  }
  if (response.status >= 500) return { status: "retryable", reason: code, at };
  if (ALREADY_CLAIMED.test(code))
    return { status: "already_claimed", code, at };
  if (LINK_GONE.test(code)) return { status: "link_gone", code, at };
  return { status: "failed", code, httpStatus: response.status, at };
}

function transportReason(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? ` (${error.cause.message})`
      : "";
  return `${message}${cause}`.slice(0, 200);
}

interface ClaimerOptions {
  fetchImpl: FetchLike;
  gatewayOrigin: string;
  owner: OwnerCredentials;
  /** Resolves after `ms`; tests pass one that advances a fake clock. */
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Telemetry for the record. */
  onEvent?: (event: ClaimEvent) => void;
}

type ClaimEvent =
  | {
      type: "link";
      how: "event-log" | "d1";
      at: string;
      expiresAt: string | null;
    }
  | { type: "attempt"; how: "event-log" | "d1"; outcome: ClaimOutcome }
  | { type: "claimed"; how: "event-log" | "d1"; at: string; latencyS: number }
  | { type: "gave_up"; how: "event-log" | "d1"; reason: string };

export interface ClaimerResult {
  how: "event-log" | "d1" | "none";
  linkEmittedAt: string | null;
  claimedAt: string | null;
  latencyS: number | null;
  harnessSelfClaimed: boolean;
}

/** POST with backoff for up to the window; returns the final outcome. */
export async function claimWithRetry(
  token: string,
  options: ClaimerOptions,
  how: "event-log" | "d1",
): Promise<ClaimOutcome> {
  const now = options.now ?? (() => new Date());
  const started = now().getTime();
  let attempt = 0;
  for (;;) {
    const outcome = await postClaim({
      fetchImpl: options.fetchImpl,
      gatewayOrigin: options.gatewayOrigin,
      token,
      owner: options.owner,
      now,
    });
    options.onEvent?.({ type: "attempt", how, outcome });
    if (outcome.status !== "retryable") return outcome;
    const waitMs =
      CLAIM_BACKOFF_MS[Math.min(attempt, CLAIM_BACKOFF_MS.length - 1)]!;
    attempt += 1;
    if (now().getTime() + waitMs - started > CLAIM_RETRY_WINDOW_MS)
      return outcome;
    await options.sleep(waitMs);
  }
}

/**
 * The event-log claimer: feed it every line of /loop/everyapp-events.ndjson
 * as the tail delivers it; it claims the newest link and reports once.
 * Lines after a successful claim are ignored; a new link after a
 * `link_gone` answer is claimed in turn.
 */
export function createEventLogClaimer(options: ClaimerOptions) {
  const now = options.now ?? (() => new Date());
  const result: ClaimerResult = {
    how: "none",
    linkEmittedAt: null,
    claimedAt: null,
    latencyS: null,
    harnessSelfClaimed: false,
  };
  let claiming: Promise<void> | null = null;
  let newest: { token: string; emittedAt: string } | null = null;
  let settled = false;

  const claimNewest = async (): Promise<void> => {
    while (newest && !settled) {
      const link = newest;
      newest = null;
      const outcome = await claimWithRetry(link.token, options, "event-log");
      if (outcome.status === "claimed") {
        settled = true;
        result.how = "event-log";
        result.linkEmittedAt = link.emittedAt;
        result.claimedAt = outcome.at;
        result.latencyS = Math.max(
          0,
          Math.round(
            (Date.parse(outcome.at) - Date.parse(link.emittedAt)) / 1000,
          ),
        );
        options.onEvent?.({
          type: "claimed",
          how: "event-log",
          at: outcome.at,
          latencyS: result.latencyS,
        });
      } else if (outcome.status === "already_claimed") {
        settled = true;
        result.harnessSelfClaimed = true;
        options.onEvent?.({
          type: "gave_up",
          how: "event-log",
          reason: outcome.code,
        });
      } else if (outcome.status === "link_gone") {
        // setup reran: the next action_required carries the link that works.
        result.linkEmittedAt ??= link.emittedAt;
      } else {
        options.onEvent?.({
          type: "gave_up",
          how: "event-log",
          reason: outcome.status === "failed" ? outcome.code : outcome.reason,
        });
        return;
      }
    }
  };

  return {
    result,
    onLine(line: string): void {
      if (settled) return;
      const event = parseEventLogLine(line);
      if (!event) return;
      const link = claimLinkOf(event);
      if (!link) return;
      const emittedAt =
        typeof (event as { ts?: unknown }).ts === "string"
          ? (event as { ts: string }).ts
          : now().toISOString();
      options.onEvent?.({
        type: "link",
        how: "event-log",
        at: emittedAt,
        expiresAt: link.expiresAt,
      });
      newest = { token: link.token, emittedAt };
      if (!claiming) {
        claiming = claimNewest().finally(() => {
          claiming = null;
        });
      }
    },
    /** Resolves when no claim is in flight. */
    async settle(): Promise<ClaimerResult> {
      while (claiming) await claiming;
      return result;
    },
  };
}

interface D1ClaimerOptions extends ClaimerOptions {
  d1: D1Client;
  /** How many polls before giving up (the driver passes the run's cap). */
  maxPolls?: number;
}

/**
 * The D1-side claimer: a poll finds the first active claim row the loop has
 * not seen, writes the hash of a token it knows into exactly that row, and
 * claims. `setup` is polling the same row, so it prints "Owner account
 * created" as if a person had clicked. Returns after one claim, a
 * self-claim, or maxPolls.
 */
export async function runD1Claimer(
  options: D1ClaimerOptions,
): Promise<ClaimerResult> {
  const now = options.now ?? (() => new Date());
  const result: ClaimerResult = {
    how: "none",
    linkEmittedAt: null,
    claimedAt: null,
    latencyS: null,
    harnessSelfClaimed: false,
  };
  const seen = new Set<string>();
  const maxPolls = options.maxPolls ?? Math.ceil((90 * 60_000) / D1_POLL_MS);
  for (let poll = 0; poll < maxPolls; poll++) {
    const nowMs = now().getTime();
    const rows = await options.d1.query(
      "SELECT id, expires_at FROM owner_setup_tokens WHERE kind = 'claim' AND consumed_at IS NULL AND expires_at > ?1 ORDER BY expires_at DESC",
      [nowMs],
    );
    const fresh = rows.find(
      (row) => typeof row["id"] === "string" && !seen.has(row["id"]),
    );
    if (fresh) {
      const id = fresh["id"] as string;
      seen.add(id);
      const token = mintToken();
      await options.d1.query(
        "UPDATE owner_setup_tokens SET token_hash = ?1 WHERE id = ?2 AND consumed_at IS NULL",
        [sha256Hex(token), id],
      );
      const emittedAt = now().toISOString();
      options.onEvent?.({
        type: "link",
        how: "d1",
        at: emittedAt,
        expiresAt: null,
      });
      const outcome = await claimWithRetry(token, options, "d1");
      if (outcome.status === "claimed") {
        result.how = "d1";
        result.linkEmittedAt = emittedAt;
        result.claimedAt = outcome.at;
        result.latencyS = Math.max(
          0,
          Math.round((Date.parse(outcome.at) - Date.parse(emittedAt)) / 1000),
        );
        options.onEvent?.({
          type: "claimed",
          how: "d1",
          at: outcome.at,
          latencyS: result.latencyS,
        });
        return result;
      }
      if (outcome.status === "already_claimed") {
        result.harnessSelfClaimed = true;
        options.onEvent?.({ type: "gave_up", how: "d1", reason: outcome.code });
        return result;
      }
      // link_gone: setup reran and minted a new row; the next poll finds it.
    }
    await options.sleep(D1_POLL_MS);
  }
  options.onEvent?.({
    type: "gave_up",
    how: "d1",
    reason: "no claim row appeared",
  });
  return result;
}

/** On every exit path: no unconsumed link outlives the run (design 4.2 step 9). */
export async function expireUnconsumedLinks(d1: D1Client): Promise<void> {
  await d1.query(
    "UPDATE owner_setup_tokens SET expires_at = 0 WHERE consumed_at IS NULL",
  );
}
