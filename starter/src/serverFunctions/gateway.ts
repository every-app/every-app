import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { ConfigurationError, gatewayUrl } from "@every-app/sdk/server";
import { ensureUserMiddleware } from "@every-app/sdk/tanstack-start";

/**
 * The Gateway's origin (in `everyapp dev`, the local launcher's): the way
 * back to the other apps, and the host the light/dark cookie is set on so
 * the launcher and every app share the pick. Null when the Worker has no
 * GATEWAY_URL; the pick then stays in this app's localStorage.
 */
export const getGatewayUrl = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(() => {
    try {
      return { gatewayUrl: new URL(gatewayUrl(env)).origin };
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      return { gatewayUrl: null };
    }
  });
