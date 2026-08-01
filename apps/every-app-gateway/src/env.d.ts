// Custom environment variable type definitions
// These extend the auto-generated Env interface from worker-configuration.d.ts

// Build stamp injected by vite `define` (see vite.config.ts); rendered as the
// bottom-right version badge in __root.tsx.
declare const __GATEWAY_BUILD__: string;

declare namespace Cloudflare {
  interface Env {
    OAUTH_KV: KVNamespace;
    OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;

    // Gateway URL
    GATEWAY_URL: string;

    // Static assets (run_worker_first is on; the entry serves these itself)
    ASSETS?: { fetch(request: Request): Promise<Response> };

    // Cloudflare account that owns this gateway deployment
    CLOUDFLARE_ACCOUNT_ID?: string;

    // Deployment mode used to gate internal operator APIs
    GATEWAY_DEPLOYMENT_MODE?: "self_hosted" | "hosted";

    // Better Auth configuration
    // Also used as HMAC key material for app token hashing (with domain separation)
    BETTER_AUTH_SECRET: string;

    // RS256 keypair for the identity JWTs the perimeter mints per proxied
    // request (kid "everyapp-identity"; the SDK verifies against the public
    // key, which `everyapp deploy` injects into app workers).
    JWT_PRIVATE_KEY: string;
    JWT_PUBLIC_KEY: string;

    // Provider credentials used by gateway proxy routes
    OPENAI_API_KEY?: string;

    // Optional REST transport for email delivery outside deployed Workers.
    EMAIL_REST_API_TOKEN?: string;

    // Sender identity for Better Auth invitation and password-reset flows.
    // EMAIL_FROM may also use the legacy display format "Name <email>".
    EMAIL_FROM?: string;
    EMAIL_FROM_NAME?: string;

    // DEV ONLY (`everyapp dev --mode mirror`): parent domain to scope the
    // session cookie to, so it rides from the gateway base host to sub-app
    // subdomains (e.g. "everyapp.localhost"). Ignored in production builds.
    EVERYAPP_DEV_COOKIE_DOMAIN?: string;
  }
}
