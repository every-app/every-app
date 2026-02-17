// Custom environment variable type definitions
// These extend the auto-generated Env interface from worker-configuration.d.ts

declare namespace Cloudflare {
  interface Env {
    // Gateway URL
    GATEWAY_URL: string;

    // Cloudflare account that owns this gateway deployment
    CLOUDFLARE_ACCOUNT_ID?: string;

    // Better Auth configuration
    // Also used as HMAC key material for app token hashing (with domain separation)
    BETTER_AUTH_SECRET: string;

    // JWT keys for embedded app tokens
    JWT_PRIVATE_KEY: string;
    JWT_PUBLIC_KEY: string;

    // Provider credentials used by gateway proxy routes
    OPENAI_API_KEY?: string;
  }
}
