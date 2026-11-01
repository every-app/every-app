/**
 * Whether this computer can resolve a hostname the probes reached through
 * its zone's nameservers. When it can't, a resolver on the way (the
 * computer's, or the network's) still remembers the name as missing from
 * before it existed: the hostname works, but not yet for this computer's
 * browser or curl. That clears by itself once the remembered answer
 * expires; this only says so, rather than leaving a person to guess.
 */
import dns from "node:dns";
import type { EventSink } from "@/lib/output/events";
import { negativeCacheTtlSeconds } from "./authoritativeDns";

/** This computer's resolver, and how long a remembered "missing" lasts. */
export interface LocalDns {
  lookup: (hostname: string) => Promise<unknown>;
  negativeCacheTtlSeconds: (hostname: string) => Promise<number | null>;
}

export const osLocalDns: LocalDns = {
  lookup: (hostname) => dns.promises.lookup(hostname, { all: true }),
  negativeCacheTtlSeconds,
};

/** The OS resolver's answers that mean "no such name" (EAI_*: getaddrinfo's). */
function remembersMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? "";
  return code === "ENOTFOUND" || code === "ENODATA" || code.startsWith("EAI_");
}

function clearsWithin(ttlSeconds: number | null): string {
  if (ttlSeconds === null) return "half an hour";
  const minutes = Math.max(1, Math.ceil(ttlSeconds / 60));
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

/**
 * A LOCAL_DNS_STALE warning when this computer can't resolve `host`, which
 * answered the probe. `lead` says what works: "https://x has its
 * certificate and the gateway serves it". True when it warned.
 */
export async function warnIfLocalDnsStale({
  host,
  lead,
  out,
  step,
  localDns,
}: {
  host: string;
  lead: string;
  out: EventSink;
  step: string;
  localDns: LocalDns;
}): Promise<boolean> {
  try {
    await localDns.lookup(host);
    return false;
  } catch (error) {
    if (!remembersMissing(error)) return false;
  }
  const ttlSeconds = await localDns.negativeCacheTtlSeconds(host).catch(() => null);
  out.emit({
    type: "warning",
    code: "LOCAL_DNS_STALE",
    step,
    message: `${lead}, but this computer's DNS resolver, or this network's, still remembers ${host} as missing from before it existed. That clears by itself within ${clearsWithin(ttlSeconds)}; a browser with its own DNS, such as Chrome, works now. On macOS, \`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder\` clears this computer's own cache, but not the network's.`,
    data: { host, negativeCacheTtlSeconds: ttlSeconds },
  });
  return true;
}
