import type { AuthConfig } from "./types";
import { env } from "cloudflare:workers";

export function getAuthConfig(): AuthConfig {
  return {
    jwksUrl: `${env.GATEWAY_URL}/api/embedded/jwks`,
    issuer: env.GATEWAY_URL,
    audience: import.meta.env.VITE_APP_ID,
  };
}
