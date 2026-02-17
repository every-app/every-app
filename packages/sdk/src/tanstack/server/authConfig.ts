import type { AuthConfig } from "./types.js";
import { env } from "cloudflare:workers";

export function getAuthConfig(): AuthConfig {
  return {
    issuer: env.GATEWAY_URL,
    audience: import.meta.env.VITE_APP_ID,
  };
}
