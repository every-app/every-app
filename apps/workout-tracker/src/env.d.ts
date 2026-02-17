// Custom environment variable type definitions
// These extend the auto-generated Env interface from worker-configuration.d.ts

declare namespace Cloudflare {
  interface Env {
    // Gateway URL
    GATEWAY_URL: string;

    // Optional machine token used for app-to-gateway requests
    GATEWAY_APP_API_TOKEN?: string;

    // Legacy alias retained for backwards compatibility
    APP_TOKEN?: string;
  }
}
