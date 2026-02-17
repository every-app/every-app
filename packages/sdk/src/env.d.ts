// Type definitions for environment variables expected by the SDK
// Apps using this SDK should have these defined in their wrangler configuration

declare namespace Cloudflare {
  interface Env {
    GATEWAY_URL: string;
    EVERY_APP_GATEWAY?: Fetcher;
    GATEWAY_APP_API_TOKEN?: string;
    APP_TOKEN?: string;
  }
}

interface Env extends Cloudflare.Env {}
