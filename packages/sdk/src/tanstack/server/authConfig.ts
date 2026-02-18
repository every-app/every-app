import type { AuthConfig } from "./types.js";
import { env } from "cloudflare:workers";
import { isBypassGatewayLocalOnlyServer } from "../../shared/bypassGatewayLocalOnly.js";

export function getAuthConfig(): AuthConfig {
  const bypassGatewayLocalOnlyEnv = (
    env as { BYPASS_GATEWAY_LOCAL_ONLY?: string }
  ).BYPASS_GATEWAY_LOCAL_ONLY;
  const isBypassGatewayLocalOnly =
    import.meta.env.PROD !== true &&
    (bypassGatewayLocalOnlyEnv === "true" ||
      isBypassGatewayLocalOnlyServer() === true);
  const issuer = env.GATEWAY_URL || (isBypassGatewayLocalOnly ? "local" : "");

  return {
    issuer,
    audience: import.meta.env.VITE_APP_ID,
  };
}
