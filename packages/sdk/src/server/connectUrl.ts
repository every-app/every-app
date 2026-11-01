/**
 * Where an app sends a person to connect an OAuth provider the Gateway
 * runs the flow for (docs/design/2026-10-oauth-providers.md section 5):
 * `<gateway>/connect/<id>?return=<back here>&account=<user|organization>`.
 * The Gateway checks the session, asks the provider for the union of the
 * sets every active app declares, finishes on its own callback and sends
 * the browser back to `returnTo`, which must be a path on the Gateway or
 * an https URL on one of its app hosts (in local dev also localhost).
 */
import { ConfigurationError } from "../internal/index.js";
import type { ConnectionAccount } from "../internal/index.js";

export interface ConnectUrlOptions {
  /** The Worker env: `GATEWAY_URL`, which every deployed Worker and `everyapp dev` set. */
  env: object;
  /** The OAuth provider's id (`google-workspace`, `github`). */
  provider: string;
  /**
   * Where to send the person afterwards: the app's own URL (absolute) or
   * a path on the Gateway. Absent: Settings → Connected accounts.
   */
  returnTo?: string;
  /** Whose connection to make: the person's (default) or the organization's (owner or admin). */
  account?: ConnectionAccount;
  /** Scope sets to ask for; absent: the union every active app that lists the provider declares. */
  sets?: readonly string[];
}

/** The path of the connect page for `provider` on the Gateway. */
export function connectPath(provider: string): string {
  return `/connect/${encodeURIComponent(provider)}`;
}

/** The absolute URL that starts the Gateway-owned flow for `provider`. */
export function connectUrl({
  env,
  provider,
  returnTo,
  account,
  sets,
}: ConnectUrlOptions): string {
  const values = env as Record<string, unknown>;
  const gateway = values["GATEWAY_URL"];
  if (typeof gateway !== "string" || !gateway.trim()) {
    throw new ConfigurationError(
      "connectUrl() needs GATEWAY_URL in the Worker env: the deploy sets it, and everyapp dev sets it to the local gateway.",
    );
  }
  let base: URL;
  try {
    base = new URL(gateway.trim());
  } catch {
    throw new ConfigurationError(`GATEWAY_URL isn't a URL: ${gateway}`);
  }
  const url = new URL(connectPath(provider), base.origin);
  if (returnTo) url.searchParams.set("return", returnTo);
  if (account) url.searchParams.set("account", account);
  if (sets && sets.length > 0) url.searchParams.set("sets", sets.join(","));
  return url.toString();
}
