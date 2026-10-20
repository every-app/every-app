/**
 * Hostnames the gateway is published under: its own host (`--domain`, any
 * name whose zone is in the Cloudflare account) and its apps' hosts, each
 * exactly one label below the install's app base domain.
 */
import { EveryAppError } from "@/lib/errors";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_PATTERN = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+${LABEL}$`);

function isValidHostname(host: string): boolean {
  return HOSTNAME_PATTERN.test(host);
}

/**
 * `https://Apps.Example.com/` → `apps.example.com`; undefined stays
 * undefined. Throws for anything that isn't a hostname with a dot in it.
 */
export function normalizeHostname(input: string): string;
export function normalizeHostname(input: string | undefined): string | undefined;
export function normalizeHostname(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  if (!isValidHostname(host)) {
    throw new EveryAppError(
      "INVALID_DOMAIN",
      `"${input}" isn't a hostname like apps.example.com`,
    );
  }
  return host;
}

/** Whether `host` is one label below `parent` (`todo.apps.example.com` under `apps.example.com`). */
export function isOneLabelBelow(host: string, parent: string): boolean {
  if (!host.endsWith(`.${parent}`)) return false;
  const label = host.slice(0, -(parent.length + 1));
  return label.length > 0 && !label.includes(".") && isValidHostname(host);
}

/** The app hosts the gateway publishes: those one label below its app base domain. */
export function publishedAppHosts(hosts: readonly string[], base: string): string[] {
  return hosts.filter((host) => isOneLabelBelow(host, base));
}

/**
 * The names a zone holding `host` could have, longest first, down to two
 * labels: `todo.apps.example.com`, `apps.example.com`, `example.com`.
 */
export function zoneCandidates(host: string): string[] {
  const labels = host.split(".");
  const candidates: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1) {
    candidates.push(labels.slice(i).join("."));
  }
  return candidates;
}
