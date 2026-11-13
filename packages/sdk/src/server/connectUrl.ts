/**
 * Where an app sends a person to connect an OAuth provider the Gateway
 * runs the flow for, or to allow this app to use the connection they
 * already have (docs/design/2026-11-oauth-one-connection.md):
 * `<gateway>/connect/<id>?app=<this app>&return=<back here>`. A
 * connection belongs to one person, and each app they allow uses it. The
 * Gateway checks the session and that the person may open the app. With
 * no connection, or one made before the app's `everyapp.config.ts`
 * listed a scope, it asks the provider for every scope the
 * organization's apps list (plus the ones that name the account),
 * finishes on its own callback and allows this app. With a connection
 * that was asked for what the app lists, it shows its own Allow page and asks no
 * provider. Either way it sends the browser back to `returnTo`, which
 * must be a path on the Gateway or an https URL on one of its app hosts
 * (in local dev also localhost).
 */
import { APP_ID_ENV, ConfigurationError } from "../internal/index.js";

export interface ConnectUrlOptions {
  /** The Worker env: `GATEWAY_URL` and the app's id, which every deployed Worker and `everyapp dev` set. */
  env: object;
  /** The OAuth provider's id (`google-workspace`, `github`). */
  provider: string;
  /**
   * Where to send the person afterwards: the app's own URL (absolute) or
   * a path on the Gateway. Absent: Your connections → Accounts.
   */
  returnTo?: string;
}

/** The path of the connect page for `provider` on the Gateway, without the app. */
export function connectPath(provider: string): string {
  return `/connect/${encodeURIComponent(provider)}`;
}

/** The absolute URL where the person connects `provider`, or allows this app to use their connection to it. */
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
      `connectUrl() needs ${APP_ID_ENV} in the Worker env: the link names the app that asks, and the deploy and everyapp dev set it.`,
    );
  }
  const url = new URL(connectPath(provider), base.origin);
  url.searchParams.set("app", app.trim());
  if (returnTo) url.searchParams.set("return", returnTo);
  return url.toString();
}
