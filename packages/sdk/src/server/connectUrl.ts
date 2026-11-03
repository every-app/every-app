/**
 * Where an app sends a person to connect an OAuth provider the Gateway
 * runs the flow for (docs/design/2026-11-oauth-simplify.md):
 * `<gateway>/connect/<id>?app=<this app>&return=<back here>`. A
 * connection belongs to one person and one app: the Gateway checks the
 * session and that the person may open the app, asks the provider for
 * exactly the scopes the app's `everyapp.config.ts` lists (plus the ones
 * that name the account), finishes on its own callback and sends the
 * browser back to `returnTo`, which must be a path on the Gateway or an
 * https URL on one of its app hosts (in local dev also localhost).
 */
import { APP_ID_ENV, ConfigurationError } from "../internal/index.js";

export interface ConnectUrlOptions {
  /** The Worker env: `GATEWAY_URL` and the app's id, which every deployed Worker and `everyapp dev` set. */
  env: object;
  /** The OAuth provider's id (`google-workspace`, `github`). */
  provider: string;
  /**
   * Where to send the person afterwards: the app's own URL (absolute) or
   * a path on the Gateway. Absent: Settings → Connected accounts.
   */
  returnTo?: string;
}

/** The path of the connect page for `provider` on the Gateway, without the app. */
export function connectPath(provider: string): string {
  return `/connect/${encodeURIComponent(provider)}`;
}

/** The absolute URL that connects the person to `provider` in this app. */
export function connectUrl({
  env,
  provider,
  returnTo,
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
  const app = values[APP_ID_ENV];
  if (typeof app !== "string" || !app.trim()) {
    throw new ConfigurationError(
      `connectUrl() needs ${APP_ID_ENV} in the Worker env: a connection belongs to one app, and the deploy and everyapp dev set it.`,
    );
  }
  const url = new URL(connectPath(provider), base.origin);
  url.searchParams.set("app", app.trim());
  if (returnTo) url.searchParams.set("return", returnTo);
  return url.toString();
}
