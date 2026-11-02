/**
 * `verifyWebhook()`: check an inbound provider webhook on a route the
 * manifest declares `public`, the way the provider signs it.
 *
 * The Gateway forwards a public route's body and headers untouched and
 * verifies nothing (landing-page/content/agent/manifest.md, "Why a route is
 * public"): the app checks the provider's signature itself, with the signing
 * secret it declares in `secrets`. Every app that takes a webhook would
 * otherwise write this HMAC code again, and the easy mistakes (a `===`
 * compare, no timestamp window, verifying a re-serialized body, reading an
 * unbounded body first) are the ones that matter. Proposed in
 * docs/design/2026-11-birds-forcing-function.md (limitation 6).
 *
 * Supported signing schemes:
 *  - `slack`: `X-Slack-Signature: v0=<hex>` over `v0:<timestamp>:<body>`,
 *    with `X-Slack-Request-Timestamp` inside the tolerance;
 *  - `github`: `X-Hub-Signature-256: sha256=<hex>` over the body. GitHub
 *    signs no timestamp, so a replay is the receiver's to drop: dedupe on
 *    `deliveryId` (`X-GitHub-Delivery`);
 *  - `everyapp`: a Gateway's own event delivery, `X-EveryApp-Signature:
 *    t=<seconds>,v1=<hex>` over `<t>.<body>` (the same check as the
 *    Gateway's `verifyEventSignature`), deduped on `X-EveryApp-Event-Id`.
 *
 * WebCrypto only. The compare is `crypto.subtle.verify`, constant time.
 * Several secrets may be given, so a secret rotates without a gap.
 */
import {
  EVENT_HEADERS,
  EVENT_SIGNATURE_TOLERANCE_SECONDS,
  eventSigningInput,
  parseEventSignature,
} from "../internal/events.js";

export type WebhookProvider = "slack" | "github" | "everyapp";

export interface VerifyWebhookOptions {
  provider: WebhookProvider;
  /** The signing secret, or several while one rotates. Empty ones are ignored. */
  secret: string | readonly string[];
  /** How far a signed timestamp may be from now (Slack, EveryApp). Default 300 s. */
  toleranceSeconds?: number;
  /** The largest body read before giving up. Default 5 MiB. */
  maxBytes?: number;
  /** The clock, for tests. */
  now?: Date;
}

export type WebhookRefusalReason =
  /** No usable secret was passed: a configuration fault, never the sender's. */
  | "no_secret"
  /** The provider's signature header is absent. */
  | "missing_signature"
  /** A signature or timestamp header that isn't the provider's shape. */
  | "malformed"
  /** The signed timestamp is outside the tolerance. */
  | "expired"
  /** The body is larger than `maxBytes`. */
  | "too_large"
  /** The body was already read, or its stream failed mid-read. */
  | "unreadable"
  /** No secret verifies the signature. */
  | "mismatch";

export type WebhookVerification =
  | {
      ok: true;
      /** The body exactly as signed. The request's own body is consumed: parse this. */
      body: string;
      /** The provider's id for this delivery, for deduplication; null when it sends none. */
      deliveryId: string | null;
      /** The signed timestamp in seconds; null for GitHub, which signs none. */
      timestamp: number | null;
    }
  | { ok: false; reason: WebhookRefusalReason };

/** The default body limit: well above Slack's payloads and most of GitHub's (whose cap is 25 MB). */
export const WEBHOOK_MAX_BYTES_DEFAULT = 5 * 1024 * 1024;

const HEX_SHA256 = /^[0-9a-f]{64}$/i;
const MAX_EVENT_SIGNATURES = 4;
const encoder = new TextEncoder();

/**
 * Verify `request` as a `provider` webhook signed with `secret`. Reads the
 * body (at most `maxBytes`) and returns it on success; never throws for a
 * bad delivery, so a handler answers `401` on `{ ok: false }`. Throws a
 * `TypeError` only for a programming error: an unknown `provider`, or a
 * `toleranceSeconds` or `maxBytes` that is negative, NaN or infinite.
 *
 * ```ts
 * const check = await verifyWebhook(request, { provider: "slack", secret: env.SLACK_SIGNING_SECRET });
 * if (!check.ok) return new Response(null, { status: 401 });
 * const params = new URLSearchParams(check.body);
 * ```
 */
export async function verifyWebhook(
  request: Request,
  options: VerifyWebhookOptions,
): Promise<WebhookVerification> {
  const secrets = (
    typeof options.secret === "string" ? [options.secret] : options.secret
  ).filter((secret) => typeof secret === "string" && secret.length > 0);
  if (secrets.length === 0) return refused("no_secret");

  // A NaN or infinite tolerance or limit would quietly turn the window or the
  // read bound off (every comparison with NaN is false): refuse the call.
  const tolerance = checkedOption(
    "toleranceSeconds",
    options.toleranceSeconds,
    EVENT_SIGNATURE_TOLERANCE_SECONDS,
  );
  const maxBytes = checkedOption(
    "maxBytes",
    options.maxBytes,
    WEBHOOK_MAX_BYTES_DEFAULT,
  );

  const signed = readSignature(request.headers, options.provider);
  if (!signed.ok) return signed;

  if (signed.timestamp !== null) {
    const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - signed.timestamp) > tolerance) {
      return refused("expired");
    }
  }

  const bytes = await readBody(request, maxBytes);
  if (bytes === "unreadable") return refused("unreadable");
  if (bytes === null) return refused("too_large");

  // The HMAC runs over the bytes received, never a decoded and re-encoded copy.
  const prefix = encoder.encode(signed.prefix);
  const data = new Uint8Array(
    new ArrayBuffer(prefix.byteLength + bytes.byteLength),
  );
  data.set(prefix, 0);
  data.set(bytes, prefix.byteLength);
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    for (const candidate of signed.digests) {
      if (await crypto.subtle.verify("HMAC", key, fromHex(candidate), data)) {
        return {
          ok: true,
          body: new TextDecoder().decode(bytes),
          deliveryId: signed.deliveryId,
          timestamp: signed.timestamp,
        };
      }
    }
  }
  return refused("mismatch");
}

interface SignatureParts {
  ok: true;
  /** Lowercase hex HMAC-SHA256 digests, any of which may match. */
  digests: string[];
  timestamp: number | null;
  deliveryId: string | null;
  /** What the provider signs before the body's bytes. */
  prefix: string;
}

function readSignature(
  headers: Headers,
  provider: WebhookProvider,
): SignatureParts | { ok: false; reason: WebhookRefusalReason } {
  switch (provider) {
    case "slack": {
      const header = headers.get("x-slack-signature");
      if (!header) return refused("missing_signature");
      const rawTimestamp = headers.get("x-slack-request-timestamp");
      const digest = header.startsWith("v0=") ? header.slice(3) : "";
      if (
        !HEX_SHA256.test(digest) ||
        !rawTimestamp ||
        !/^\d{1,12}$/.test(rawTimestamp)
      ) {
        return refused("malformed");
      }
      return {
        ok: true,
        digests: [digest.toLowerCase()],
        timestamp: Number(rawTimestamp),
        deliveryId: null,
        prefix: `v0:${rawTimestamp}:`,
      };
    }
    case "github": {
      const header = headers.get("x-hub-signature-256");
      if (!header) return refused("missing_signature");
      const digest = header.startsWith("sha256=") ? header.slice(7) : "";
      if (!HEX_SHA256.test(digest)) return refused("malformed");
      return {
        ok: true,
        digests: [digest.toLowerCase()],
        timestamp: null,
        deliveryId: headers.get("x-github-delivery"),
        prefix: "",
      };
    }
    case "everyapp": {
      const header = headers.get(EVENT_HEADERS.signature);
      if (!header) return refused("missing_signature");
      const parsed = parseEventSignature(header);
      // The Gateway sends one v1 (two while a secret rotates): a header with
      // many isn't one it sent, and each would cost an HMAC per secret.
      if (!parsed || parsed.v1.length > MAX_EVENT_SIGNATURES) {
        return refused("malformed");
      }
      return {
        ok: true,
        digests: parsed.v1,
        timestamp: parsed.timestamp,
        deliveryId: headers.get(EVENT_HEADERS.eventId),
        prefix: eventSigningInput(parsed.timestamp, ""),
      };
    }
    default: {
      const unknown: never = provider;
      throw new TypeError(
        `verifyWebhook: unknown provider "${String(unknown)}"`,
      );
    }
  }
}

/** A finite, non-negative option, or its default when not given. */
function checkedOption(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `verifyWebhook: ${name} must be a finite number of at least 0`,
    );
  }
  return value;
}

/**
 * The body's bytes; null once it passes `maxBytes` (read no further);
 * "unreadable" when it was already consumed or its stream fails.
 */
async function readBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null | "unreadable"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (request.bodyUsed) return "unreadable";
  if (!request.body) return new Uint8Array(new ArrayBuffer(0));
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return "unreadable";
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function refused(reason: WebhookRefusalReason): {
  ok: false;
  reason: WebhookRefusalReason;
} {
  return { ok: false, reason };
}
