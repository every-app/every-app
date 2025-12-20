// Type definitions for environment variables expected by the SDK
// Apps using this SDK should have these defined in their wrangler configuration

declare namespace Cloudflare {
  interface Env {
    GATEWAY_URL: string;
    EVERY_APP_GATEWAY?: Fetcher;
  }
}

interface Env extends Cloudflare.Env {}
