/**
 * `gatewayUrl()`: the one rule for a link from an app back to its Gateway
 * ("‹ Every App", "Invite people", "Sign out").
 */
import { ConfigurationError } from "../internal/index.js";

/** Where the Gateway is: the deploy sets it, and so does `everyapp dev`. */
const GATEWAY_URL_ENV = "GATEWAY_URL";

/**
 * The Gateway's URL, with `path` on it: `gatewayUrl(env)` for the launcher,
 * `gatewayUrl(env, "/admin/users")` for the page where owners and admins
 * invite people.
 *
 * Read from `env.GATEWAY_URL`, which the deploy sets on every Worker of the
 * app and `everyapp dev` sets to its local launcher, so the same link works
 * in both. `env` is the Worker's env (any object; only `GATEWAY_URL` is
 * read). Throws {@link ConfigurationError} when it is unset or not an http(s)
 * URL: a Worker no deploy or `everyapp dev` built.
 */
export function gatewayUrl(env: object, path = "/"): string {
  const value = (env as Record<string, unknown>)[GATEWAY_URL_ENV];
  let base: URL | undefined;
  if (typeof value === "string" && value) {
    try {
      base = new URL(value);
    } catch {
      base = undefined;
    }
  }
  if (!base || (base.protocol !== "https:" && base.protocol !== "http:")) {
    throw new ConfigurationError(
      `${GATEWAY_URL_ENV} is ${value ? "not an http(s) URL" : "unset"}: everyapp deploy and everyapp dev set it on the app's Worker.`,
    );
  }
  return new URL(path, base.origin).toString();
}
