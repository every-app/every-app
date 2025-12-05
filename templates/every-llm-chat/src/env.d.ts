// Custom environment variable type definitions
// These extend the auto-generated Env interface from worker-configuration.d.ts

declare namespace Cloudflare {
  interface Env {
    OPENAI_API_KEY: string;
    GATEWAY_URL: string;
  }
}
