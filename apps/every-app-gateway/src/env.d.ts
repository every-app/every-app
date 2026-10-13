// Env types beyond the bindings cloudflare.config.ts declares (cf generates
// those into .cloudflare/types/index.d.ts).

// Build stamp injected by vite `define` (see vite.config.ts); rendered as the
// bottom-right version badge in __root.tsx.
declare const __GATEWAY_BUILD__: string;

declare namespace Cloudflare {
  interface Env {
    OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;

    // The optional settings below are plain secrets on deployed gateways
    // (`everyapp gateway secret set`); in dev cloudflare.config.ts declares
    // the ones that are set locally.

    // Cloudflare account that owns this gateway deployment
    CLOUDFLARE_ACCOUNT_ID?: string;

    // Deployment mode used to gate internal operator APIs
    GATEWAY_DEPLOYMENT_MODE?: "self_hosted" | "hosted";

    // "true" turns on the OAuth authorization server for MCP clients (set as
    // a secret so deploys keep it). Off when unset: see server/oauth-flag.ts.
    MCP_OAUTH_ENABLED?: string;

    // Provider credentials used by gateway proxy routes
    OPENAI_API_KEY?: string;

    // OpenAI paths beyond inference that apps may opt into with their
    // manifest's `ai.routes` (comma or space separated, e.g. "/v1/files").
    // Unset: inference only. Set as a secret so deploys keep it.
    AI_PROXY_EXTRA_ROUTES?: string;

    // Optional REST transport for email delivery outside deployed Workers.
    EMAIL_REST_API_TOKEN?: string;

    // Sender identity for Better Auth invitation and password-reset flows.
    // EMAIL_FROM may also use the legacy display format "Name <email>".
    EMAIL_FROM?: string;
    EMAIL_FROM_NAME?: string;

    // The domain apps live one label below (src/server/app-hosts.ts). The
    // deploy sets it on installs with per-app Custom Domains; unset on
    // gateways still served through a wildcard route.
    APP_BASE_DOMAIN?: string;

    // DEV ONLY (`everyapp dev --mode mirror`): parent domain to scope the
    // session cookie to, so it rides from the gateway base host to sub-app
    // subdomains (e.g. "everyapp.localhost"). Ignored in production builds.
    EVERYAPP_DEV_COOKIE_DOMAIN?: string;
  }
}
