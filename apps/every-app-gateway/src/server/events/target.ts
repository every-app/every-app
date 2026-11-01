/**
 * Where a webhook subscription may point (docs/design/2026-10-events-out.md,
 * section 4), as one pure rule checked when a subscription is added and
 * again before every attempt, since a setting may have changed in between:
 * `https:` only, a hostname rather than an IP literal, nothing loopback,
 * link-local or internal by name, never the gateway's own host, an app
 * host or a third-party host (the list is server/gateway-hosts.ts), no
 * userinfo, no fragment, at most EVENT_URL_MAX_LENGTH characters. The
 * Gateway setting EVENTS_ALLOW_PRIVATE_TARGETS=true lets `http:` and the
 * private name classes through for an operator wiring an internal n8n
 * (an RFC 1918 or loopback address is not routable from Cloudflare's
 * edge in any case, so the flag buys `http:` and internal names that
 * resolve publicly, nothing more); the gateway's own hosts are refused
 * even then, so a delivery can never loop back in.
 */
import { EVENT_URL_MAX_LENGTH } from "@every-app/sdk/internal";
import { isSameOrSubdomain, normalizeHost } from "@/server/gateway-hosts";

type TargetRefusalReason =
  | "too_long"
  | "not_a_url"
  | "not_https"
  | "scheme"
  | "ip_literal"
  | "private_host"
  | "gateway_host"
  | "userinfo"
  | "fragment";

type TargetCheck =
  | { ok: true }
  | { ok: false; reason: TargetRefusalReason; message: string };

export interface TargetRules {
  /** EVENTS_ALLOW_PRIVATE_TARGETS: `http:` and private names allowed. */
  allowPrivate: boolean;
  /** The gateway's own host classes, normalized (gatewayHosts). */
  gatewayHosts: readonly string[];
}

/** Name suffixes (and exact names) that mean a private or local machine. */
const PRIVATE_NAME_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "onion",
  "localdomain",
  "intranet",
  "lan",
  "corp",
  "private",
];

const MESSAGES: Record<TargetRefusalReason, string> = {
  too_long: `The URL is at most ${EVENT_URL_MAX_LENGTH.toLocaleString("en-US")} characters.`,
  not_a_url: "That isn't a URL. Give the full address, https://… included.",
  not_https:
    "Webhook URLs use https. An operator can allow http targets on a self-hosted gateway with EVENTS_ALLOW_PRIVATE_TARGETS=true.",
  scheme: "Webhook URLs use https.",
  ip_literal:
    "Give the target by hostname, not by IP address. An operator can allow private targets on a self-hosted gateway with EVENTS_ALLOW_PRIVATE_TARGETS=true.",
  private_host:
    "That host is local or private. An operator can allow private targets on a self-hosted gateway with EVENTS_ALLOW_PRIVATE_TARGETS=true.",
  gateway_host:
    "A subscription can't target this gateway or one of its apps: the gateway would be calling itself.",
  userinfo:
    "Leave the credentials out of the URL: the signature authenticates each delivery.",
  fragment: "A webhook URL has no #fragment.",
};

/** `[::1]`, `[fe80::…]`: a bracketed IPv6 literal, as URL.hostname keeps it. */
function isIpv6Literal(host: string): boolean {
  return host.startsWith("[") && host.endsWith("]");
}

/** `127.0.0.1`, `0x7f.1`, `2130706433`: anything all-numeric the URL parser took as IPv4. */
function isIpv4Literal(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function isPrivateName(host: string): boolean {
  return PRIVATE_NAME_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

function refuse(reason: TargetRefusalReason): TargetCheck {
  return { ok: false, reason, message: MESSAGES[reason] };
}

/** Whether `url` may be a subscription's target under these rules. */
export function checkTarget(url: string, rules: TargetRules): TargetCheck {
  if (url.length > EVENT_URL_MAX_LENGTH) return refuse("too_long");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse("not_a_url");
  }
  if (parsed.protocol === "http:") {
    if (!rules.allowPrivate) return refuse("not_https");
  } else if (parsed.protocol !== "https:") {
    return refuse("scheme");
  }
  if (parsed.username || parsed.password) return refuse("userinfo");
  if (parsed.hash || url.includes("#")) return refuse("fragment");
  const host = normalizeHost(parsed.hostname);
  if (!host) return refuse("not_a_url");
  // The gateway's own hosts first: refused whatever the setting says.
  if (rules.gatewayHosts.some((own) => isSameOrSubdomain(host, own))) {
    return refuse("gateway_host");
  }
  if (isIpv6Literal(host) || isIpv4Literal(host)) {
    return rules.allowPrivate ? { ok: true } : refuse("ip_literal");
  }
  if (isPrivateName(host)) {
    return rules.allowPrivate ? { ok: true } : refuse("private_host");
  }
  // A bare label (`intranet-box`) resolves only on a private network.
  if (!host.includes(".") && !rules.allowPrivate) {
    return refuse("private_host");
  }
  return { ok: true };
}

/** The rules as this gateway's env sets them. */
export function targetRulesFromEnv(
  env: { EVENTS_ALLOW_PRIVATE_TARGETS?: string },
  hosts: readonly string[],
): TargetRules {
  return {
    allowPrivate: env.EVENTS_ALLOW_PRIVATE_TARGETS?.trim() === "true",
    gatewayHosts: hosts,
  };
}
