// Env types beyond the bindings cloudflare.config.ts declares (cf generates
// those into .cloudflare/types/index.d.ts).

// Build stamp injected by vite `define` (see vite.config.ts); rendered as the
// bottom-right version badge in __root.tsx.
declare const __GATEWAY_BUILD__: string;

declare namespace Cloudflare {
  interface Env {
    // The optional settings below are plain secrets on deployed gateways
    // (`everyapp secret set --for gateway`); in dev cloudflare.config.ts declares
    // the ones that are set locally.

    // Cloudflare account this Gateway is deployed in
    CLOUDFLARE_ACCOUNT_ID?: string;

    // "self_hosted" or "hosted" (`everyapp setup --mode`, set at install):
    // what the gateway does follows from it (server/platform-policy.ts).
    // Anything else, unset included, fails closed: every capability off.
    // Dev builds default to "self_hosted" (cloudflare.config.ts).
    GATEWAY_DEPLOYMENT_MODE?: "self_hosted" | "hosted";

    // "false" keeps the hosted gateway invite-only (the preview launches
    // that way); open sign-up when unset or "true", and any other value is
    // invite-only. Ignored when self-hosted, which is always invite-only.
    HOSTED_OPEN_SIGNUP?: string;

    // "false" turns off the OAuth authorization server for MCP clients (set
    // as a secret so deploys keep it). On when unset or "true"; any other
    // value is off: see server/oauth-flag.ts.
    MCP_OAUTH_ENABLED?: string;

    // "false" turns off dynamic client registration (/oauth/register), so
    // only clients with a metadata document (CIMD) can connect; Cursor and
    // other DCR-only clients can't. On when unset or "true"; any other value
    // is off: see server/oauth-flag.ts.
    MCP_DCR_ENABLED?: string;

    // Browser origins, besides the gateway's own, allowed to call its /mcp
    // (comma or space separated), e.g. MCP Inspector's http://localhost:6274.
    MCP_ALLOWED_ORIGINS?: string;

    // Days of mcp_tool_calls kept by the hourly cron (default 90).
    MCP_AUDIT_RETENTION_DAYS?: string;

    // LOCAL TESTING ONLY: shorter OAuth access tokens (seconds, at least 60),
    // honored only when GATEWAY_URL is http://localhost or 127.0.0.1.
    MCP_ACCESS_TOKEN_TTL?: string;

    // Cloudflare Access sign-in (all optional; set as secrets so deploys keep
    // them). See src/auth/cloudflare-access/config.ts and
    // docs/runbooks/cloudflare-access.md.
    // OIDC sign-in ("Continue with <label>") through an Access for SaaS app:
    CLOUDFLARE_ACCESS_OIDC_ISSUER?: string;
    CLOUDFLARE_ACCESS_OIDC_CLIENT_ID?: string;
    CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET?: string;
    CLOUDFLARE_ACCESS_OIDC_LABEL?: string;
    // The outer ring (Access in front of the gateway's hostnames): the team
    // domain (<team>.cloudflareaccess.com), the AUD tag(s) of the Access
    // application on the gateway's own host (the only one whose assertions
    // sign people in), and those of a separate application on the apps'
    // hosts (comma separated).
    CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
    CLOUDFLARE_ACCESS_AUD?: string;
    CLOUDFLARE_ACCESS_APPS_AUD?: string;
    // Email domains whose people join as members without an invitation
    // (comma separated), and "everyone" to let in all the outer ring admits.
    CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS?: string;
    CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN?: string;
    // "false" turns password sign-in off, only while Access sign-in is set up.
    EMAIL_PASSWORD_SIGN_IN?: string;

    // Provider credentials used by gateway proxy routes
    OPENAI_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    // Workers AI (`/api/ai/workers-ai`): a Cloudflare API token with
    // Workers AI Read and Edit (the "Workers AI" template) on
    // CLOUDFLARE_ACCOUNT_ID, the account it runs and bills in. Unset: the
    // provider answers ai_provider_not_configured.
    WORKERS_AI_API_TOKEN?: string;
    // Integration keys the gateway holds for apps (src/server/integration-proxy.ts).
    DATAFORSEO_API_KEY?: string;
    CONTEXT_API_KEY?: string;
    // Social networks' OAuth clients the gateway holds for apps
    // (src/server/capabilities/oauthClient.ts): it puts them on apps' token
    // endpoint calls only. MASTODON_URL is the instance the Mastodon client
    // is registered on (https://mastodon.social when unset).
    LINKEDIN_CLIENT_ID?: string;
    LINKEDIN_CLIENT_SECRET?: string;
    FACEBOOK_APP_ID?: string;
    FACEBOOK_APP_SECRET?: string;
    INSTAGRAM_APP_ID?: string;
    INSTAGRAM_APP_SECRET?: string;
    THREADS_APP_ID?: string;
    THREADS_APP_SECRET?: string;
    YOUTUBE_CLIENT_ID?: string;
    YOUTUBE_CLIENT_SECRET?: string;
    TIKTOK_CLIENT_ID?: string;
    TIKTOK_CLIENT_SECRET?: string;
    TIKTOK_BUSINESS_CLIENT_ID?: string;
    TIKTOK_BUSINESS_CLIENT_SECRET?: string;
    REDDIT_CLIENT_ID?: string;
    REDDIT_CLIENT_SECRET?: string;
    PINTEREST_CLIENT_ID?: string;
    PINTEREST_CLIENT_SECRET?: string;
    DISCORD_CLIENT_ID?: string;
    DISCORD_CLIENT_SECRET?: string;
    SLACK_CLIENT_ID?: string;
    SLACK_CLIENT_SECRET?: string;
    MASTODON_CLIENT_ID?: string;
    MASTODON_CLIENT_SECRET?: string;
    MASTODON_URL?: string;
    KICK_CLIENT_ID?: string;
    KICK_CLIENT_SECRET?: string;
    TWITCH_CLIENT_ID?: string;
    TWITCH_CLIENT_SECRET?: string;
    TUMBLR_CLIENT_ID?: string;
    TUMBLR_CLIENT_SECRET?: string;
    DRIBBBLE_CLIENT_ID?: string;
    DRIBBBLE_CLIENT_SECRET?: string;

    // OpenAI paths beyond inference that apps may opt into with their
    // manifest's `ai.routes` (comma or space separated, e.g. "/v1/files").
    // Unset: inference only. Set as a secret so deploys keep it.
    AI_PROXY_EXTRA_ROUTES?: string;

    // Optional REST transport for email delivery outside deployed Workers.
    EMAIL_REST_API_TOKEN?: string;

    // Sender identity for Better Auth invitation and password-reset flows,
    // and for apps' mail through the `email` capability when they don't send
    // as an address of their own (src/server/capabilities/email.ts).
    // EMAIL_FROM may also use the legacy display format "Name <email>".
    EMAIL_FROM?: string;
    EMAIL_FROM_NAME?: string;

    // The domain apps live one label below (src/server/app-hosts.ts), each a
    // Workers Custom Domain. The deploy sets it; unset in local dev.
    APP_BASE_DOMAIN?: string;

    // The hosted deploy API (server/deploy/), third-party apps only.
    // THIRD_PARTY_DEPLOYS is the launch gate: exactly "on" opens it on a
    // hosted gateway (server/platform-policy.ts), and it is set by hand
    // only once the launch checks pass (docs/runbooks/hosted-install.md).
    THIRD_PARTY_DEPLOYS?: string;
    // A Cloudflare API token for this account with Workers for Platforms
    // and D1 edit; the deployer uploads apps' Workers and creates their D1
    // with it, in CLOUDFLARE_ACCOUNT_ID.
    CF_DEPLOY_TOKEN?: string;
    // The dispatch namespace third-party Workers go into; the gateway's
    // DISPATCHER binding (added by the hosted install) must name the same.
    DISPATCH_NAMESPACE?: string;
    // The registrable domain third-party apps are named on
    // (<app>-<orgKey>.<domain>), each host with its own session
    // (server/host-session.ts), reached through the route
    // *.<domain>/* (docs/runbooks/hosted-install.md). Unset, or on the
    // gateway's own site, or on a self-hosted gateway: ignored
    // (server/app-hosts.ts), so they get no hostname and nobody can open them.
    THIRD_PARTY_DOMAIN?: string;

    // DEV ONLY (`everyapp dev --mode mirror`): parent domain to scope the
    // session cookie to, so it rides from the gateway base host to sub-app
    // subdomains (e.g. "everyapp.localhost"). Ignored in production builds.
    EVERYAPP_DEV_COOKIE_DOMAIN?: string;
  }
}
