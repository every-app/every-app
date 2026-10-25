/**
 * The hosts this gateway answers on, as a list to refuse: its own host
 * (GATEWAY_URL), the domain its apps live one label below (APP_BASE_DOMAIN)
 * and the third-party domain, with the helpers that compare a hostname to
 * them. The outbound Worker reads it so a dispatched app never calls the
 * gateway from outside the perimeter (server/outbound.ts), and the event
 * bus reads it so a webhook subscription never targets the gateway or an
 * app (server/events/target.ts): one list, so a new host class is refused
 * in both places at once.
 */
import { appBaseDomain } from "@/server/app-hosts";

interface GatewayHostsEnv {
  GATEWAY_URL?: string;
  APP_BASE_DOMAIN?: string;
  THIRD_PARTY_DOMAIN?: string;
}

/** A hostname as compared: trimmed, lowercased, without a trailing dot. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function isSameOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The gateway's own host classes, normalized; unset ones left out. */
export function gatewayHosts(env: GatewayHostsEnv): string[] {
  const hosts: string[] = [];
  const base = appBaseDomain(env);
  if (base) hosts.push(base);
  // As set, unvalidated: whatever it names is denied.
  if (env.THIRD_PARTY_DOMAIN?.trim()) hosts.push(env.THIRD_PARTY_DOMAIN);
  try {
    if (env.GATEWAY_URL) hosts.push(new URL(env.GATEWAY_URL).hostname);
  } catch {
    // An unparsable GATEWAY_URL names no host to protect.
  }
  return hosts.map(normalizeHost);
}
