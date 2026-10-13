/**
 * Waiting for new hostnames' certificates. A new Workers Custom Domain gets
 * its own certificate, which usually takes a minute or two and almost
 * always under five; until then HTTPS to it fails. Waiting is only for the
 * person at the other end: the gateway already serves the hostname, and a
 * browser works as soon as the certificate is there.
 */
import { checkSslReady, GatewayUnreachableError } from "@/lib/gateway";
import type { EventSink } from "@/lib/output/events";

const DEFAULT_MAX_WAIT_MS = 600_000;
const DEFAULT_POLL_MS = 3_000;
const DEFAULT_PROGRESS_EVERY_MS = 15_000;

interface CertificateWaitOptions {
  hosts: readonly string[];
  out: EventSink;
  step: string;
  maxWaitMs?: number;
  pollMs?: number;
  progressEveryMs?: number;
  /** True once HTTPS to the URL works at all (tests replace it). */
  isReady?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface CertificateWaitResult {
  ready: string[];
  pending: string[];
}

/** HTTPS answers (any status): the certificate is there. */
async function httpsAnswers(url: string): Promise<boolean> {
  try {
    return await checkSslReady(url);
  } catch (error) {
    // Not resolving yet, or refused: not ready either.
    if (error instanceof GatewayUnreachableError) return false;
    throw error;
  }
}

function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Poll every new hostname until HTTPS to it works, for up to ten minutes,
 * saying how long it has been every 15 seconds. Hostnames still waiting
 * then get a CERT_PENDING warning; nothing fails.
 */
export async function waitForCertificates({
  hosts,
  out,
  step,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  progressEveryMs = DEFAULT_PROGRESS_EVERY_MS,
  isReady = httpsAnswers,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: CertificateWaitOptions): Promise<CertificateWaitResult> {
  const started = now();
  const ready: string[] = [];
  let pending = [...new Set(hosts)];
  let lastProgress: number | null = null;

  if (pending.length === 0) return { ready, pending };
  // A moment for Cloudflare's DNS to serve the new record before the first
  // lookup, which a resolver could otherwise remember as "no such name".
  await sleep(pollMs);
  while (pending.length > 0) {
    const answered = await Promise.all(
      pending.map((host) => isReady(`https://${host}/`)),
    );
    for (const [index, host] of pending.entries()) {
      if (!answered[index]) continue;
      ready.push(host);
      out.emit({
        type: "progress",
        step,
        message: `https://${host} has its certificate.`,
        data: { host },
      });
    }
    pending = pending.filter((_host, index) => !answered[index]);
    if (pending.length === 0) break;

    const waited = now() - started;
    if (waited >= maxWaitMs) {
      out.emit({
        type: "warning",
        code: "CERT_PENDING",
        step,
        message: `${pending.map((host) => `https://${host}`).join(", ")} ${pending.length === 1 ? "has" : "have"} no certificate after ${elapsed(waited)}. It usually comes within five minutes; the gateway serves ${pending.length === 1 ? "it" : "them"} as soon as it does. If it never comes, check the zone's CAA records allow Cloudflare's certificate authorities. Check later with \`everyapp gateway status\`.`,
        data: { hosts: pending },
      });
      break;
    }
    if (lastProgress === null || now() - lastProgress >= progressEveryMs) {
      out.emit({
        type: "progress",
        step,
        message: `Waiting for ${pending.length === 1 ? "a certificate" : "certificates"}: ${pending.join(", ")} (${elapsed(waited)} so far; usually under five minutes)...`,
        data: { hosts: pending, waitedMs: waited },
      });
      lastProgress = now();
    }
    await sleep(pollMs);
  }
  return { ready, pending };
}
