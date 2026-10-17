/**
 * Waiting for new hostnames' certificates. A new Workers Custom Domain gets
 * its own certificate, which usually takes a minute or two and almost
 * always under five; until then HTTPS to it fails. Waiting is only for the
 * person at the other end: the gateway already serves the hostname, and a
 * browser works as soon as the certificate is there.
 *
 * The probes resolve each hostname at its zone's nameservers, which serve
 * a Custom Domain's record as soon as it exists: the first one goes out at
 * once. A hostname this computer still can't resolve once it answers gets
 * a LOCAL_DNS_STALE warning (localDns.ts).
 */
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { probeHttps, type HttpsAnswer, type NoAnswerKind } from "./https";
import { osLocalDns, warnIfLocalDnsStale, type LocalDns } from "./localDns";

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
  /** One HTTPS request to the URL; any answer means it works (tests replace it). */
  probe?: (url: string) => Promise<HttpsAnswer>;
  /**
   * This computer's resolver, asked once a hostname answers. None with a
   * fake probe: the computer knows nothing of a fake network's names.
   */
  localDns?: LocalDns;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface CertificateWaitResult {
  ready: string[];
  pending: string[];
  /** Ready, but this computer's resolver still has no address for them. */
  staleLocally: string[];
}

function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** What the hostnames are waiting for, from each one's last probe. */
function waitingFor(kinds: Map<string, NoAnswerKind>): string {
  const of = (kind: NoAnswerKind) =>
    [...kinds].filter(([, k]) => k === kind).map(([host]) => host);
  const parts: string[] = [];
  const tls = of("tls");
  if (tls.length > 0) {
    parts.push(`Waiting for ${tls.length === 1 ? "a certificate" : "certificates"}: ${tls.join(", ")}`);
  }
  const dns = of("dns");
  if (dns.length > 0) {
    parts.push(
      `Waiting for DNS: ${dns.join(", ")} ${dns.length === 1 ? "has" : "have"} no record at the zone's nameservers yet`,
    );
  }
  const other = of("other");
  if (other.length > 0) {
    parts.push(`Waiting for ${other.map((host) => `https://${host}`).join(", ")} to answer`);
  }
  return parts.join("; ");
}

/**
 * Poll every new hostname until HTTPS to it works, for up to ten minutes,
 * saying what it waits for and how long it has been every 15 seconds.
 * Hostnames still waiting then get a CERT_PENDING warning; nothing fails.
 */
export async function waitForCertificates({
  hosts,
  out,
  step,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  progressEveryMs = DEFAULT_PROGRESS_EVERY_MS,
  probe,
  localDns = probe ? undefined : osLocalDns,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: CertificateWaitOptions): Promise<CertificateWaitResult> {
  const started = now();
  const ready: string[] = [];
  const staleLocally: string[] = [];
  let pending = [...new Set(hosts)];
  let lastProgress: number | null = null;
  const request = probe ?? ((url: string) => probeHttps(url));

  while (pending.length > 0) {
    const answers = await Promise.all(
      pending.map((host) => request(`https://${host}/`)),
    );
    const waiting = new Map<string, NoAnswerKind>();
    for (const [index, host] of pending.entries()) {
      const answer = answers[index]!;
      if (!answer.answered) {
        waiting.set(host, answer.kind);
        continue;
      }
      ready.push(host);
      out.emit({
        type: "progress",
        step,
        message: `https://${host} has its certificate.`,
        data: { host },
      });
      if (
        localDns &&
        (await warnIfLocalDnsStale({
          host,
          lead: `https://${host} has its certificate and the gateway serves it`,
          out,
          step,
          localDns,
        }))
      ) {
        staleLocally.push(host);
      }
    }
    pending = [...waiting.keys()];
    if (pending.length === 0) break;

    const waited = now() - started;
    if (waited >= maxWaitMs) {
      out.emit({
        type: "warning",
        code: "CERT_PENDING",
        step,
        message: `${pending.map((host) => `https://${host}`).join(", ")} ${pending.length === 1 ? "has" : "have"} no certificate after ${elapsed(waited)}. It usually comes within five minutes; the gateway serves ${pending.length === 1 ? "it" : "them"} as soon as it does. If it never comes, check the zone's CAA records allow Cloudflare's certificate authorities. Check later with \`${CLI} status\`.`,
        data: { hosts: pending },
      });
      break;
    }
    if (lastProgress === null || now() - lastProgress >= progressEveryMs) {
      out.emit({
        type: "progress",
        step,
        message: `${waitingFor(waiting)} (${elapsed(waited)} so far; usually under five minutes)...`,
        data: { hosts: pending, waitedMs: waited, waitingFor: Object.fromEntries(waiting) },
      });
      lastProgress = now();
    }
    await sleep(pollMs);
  }
  return { ready, pending, staleLocally };
}
