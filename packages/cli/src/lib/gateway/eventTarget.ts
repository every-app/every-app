/**
 * Where a webhook subscription may deliver (docs/design/2026-10-events-out.md,
 * section 4, "Targets"): the Gateway's rules (server/events/target.ts)
 * reimplemented for `everyapp events add`, which writes the subscription
 * straight into the Gateway's D1 and can't import the Gateway. The Gateway
 * checks the stored URL again before every attempt, so this is the early,
 * explained refusal, not the only one.
 *
 * A target is an `https:` URL on a hostname (not an IP literal), with no
 * user name, password or fragment, at most 2,048 characters, that isn't a
 * loopback, local or private name and isn't the Gateway's own host or an
 * app's (anything under the apps' base domain), so a delivery can never
 * loop back into the Gateway. With the Gateway setting
 * EVENTS_ALLOW_PRIVATE_TARGETS, `http:`, IP literals and the private names
 * are let through for an operator wiring an internal receiver; the
 * Gateway's own hosts never are. The private-name list is the Gateway's
 * own, from @every-app/sdk/internal (`isPrivateEventTargetName`); the
 * order of the checks is the Gateway's, kept in step by hand. Pure: the
 * caller says which hosts are the Gateway's and whether the setting is
 * there.
 *
 * One gap: the Gateway also refuses its third-party domain
 * (THIRD_PARTY_DOMAIN, hosted Gateways only), a Worker secret whose value
 * the CLI can't read back, so a URL under it passes here and is refused at
 * the first attempt.
 */
import { EVENT_URL_MAX_LENGTH, isPrivateEventTargetName } from "@every-app/sdk/internal";

export interface EventTargetRules {
  /** The Gateway's host, from the install row. */
  gatewayHost: string;
  /** APP_BASE_DOMAIN, from the install row: every app's host is under it. */
  appBaseDomain: string;
  /**
   * EVENTS_ALLOW_PRIVATE_TARGETS is set on the Gateway. Only its name can be
   * read back, not its value; the Gateway honours it only when it is "true".
   */
  allowPrivate: boolean;
}

type EventTargetCheck =
  | { ok: true; url: string }
  /** `reason` is one sentence a person can act on; it never repeats the URL. */
  | { ok: false; reason: string; private: boolean };

const DOTTED_QUAD = /^\d{1,3}(\.\d{1,3}){3}$/;

const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

const isSameOrSubdomain = (host: string, domain: string) =>
  domain !== "" && (host === domain || host.endsWith(`.${domain}`));

const refused = (reason: string, isPrivate = false): EventTargetCheck => ({
  ok: false,
  reason,
  private: isPrivate,
});

/** Whether `raw` may be a webhook target, and the URL as stored when it may. */
export function checkEventTarget(raw: string, rules: EventTargetRules): EventTargetCheck {
  const input = raw.trim();
  if (input.length > EVENT_URL_MAX_LENGTH) {
    return refused(`A webhook URL is at most ${EVENT_URL_MAX_LENGTH.toLocaleString("en-US")} characters.`);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return refused("It isn't a URL: give the whole address, like https://hooks.example.com/everyapp.");
  }
  if (url.protocol === "http:") {
    if (!rules.allowPrivate) {
      return refused("A webhook URL starts with https://: the event and its signature would cross the internet in the clear.", true);
    }
  } else if (url.protocol !== "https:") {
    return refused(`A webhook URL starts with https://, not ${url.protocol}//.`);
  }
  if (url.username || url.password) {
    return refused("A webhook URL carries no user name or password: the subscription's secret signs each delivery instead.");
  }
  if (url.hash || input.includes("#")) {
    return refused("A webhook URL has no fragment (#…): it is never sent to the receiver.");
  }
  const host = normalizeHost(url.hostname);
  // The Gateway's own hosts first: refused whatever the setting says.
  const gatewayHost = normalizeHost(rules.gatewayHost);
  const base = normalizeHost(rules.appBaseDomain);
  if (isSameOrSubdomain(host, gatewayHost) || isSameOrSubdomain(host, base)) {
    return refused(
      `${host} is the Gateway's own host, or under its apps' domain ${base}: a delivery there would loop back into the Gateway.`,
    );
  }
  // The URL parser writes every IPv4 spelling (0x7f.1, 2130706433) as a dotted quad.
  if (host.startsWith("[") || DOTTED_QUAD.test(host)) {
    if (rules.allowPrivate) return { ok: true, url: url.toString() };
    return refused("A webhook URL names its host, not an IP address.", true);
  }
  if (isPrivateEventTargetName(host) && !rules.allowPrivate) {
    return refused(`${host} is a local or internal name, which the Gateway's Worker can't reach.`, true);
  }
  return { ok: true, url: url.toString() };
}

/**
 * A stored target as a person reads it: its host (with a port that isn't
 * the default) and path, never a user name, password or query (a query
 * often carries a receiver's token).
 */
export function shownTarget(stored: string): string {
  try {
    const url = new URL(stored);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.protocol === "http:" ? "http://" : ""}${url.host}${path}`;
  } catch {
    return "(unreadable URL)";
  }
}

/** The name a webhook subscription gets when none is given: its URL's host. */
export function defaultTargetName(stored: string): string {
  try {
    return new URL(stored).hostname;
  } catch {
    return "Webhook";
  }
}
