// Environment variables the SDK reads. Apps declare these via the manifest;
// the CLI/gateway inject them at deploy time.

declare namespace Cloudflare {
  interface Env {
    // The app's manifest id.
    EVERYAPP_APP_ID: string;
    // The Worker's name: the expected audience for identity verification.
    // everyAppWorker() sets it at deploy; dev falls back to the app id.
    EVERYAPP_AUDIENCE?: string;
    // JSON array of SPKI PEM public keys (current + next) for identity
    // verification. Injected by the gateway at deploy — never fetched at runtime.
    EVERYAPP_IDENTITY_PUBLIC_KEYS?: string;
    // Private app-to-gateway service binding, omitted by `everyapp dev`.
    EVERY_APP_GATEWAY?: Fetcher;
    // Explicit local-dev opt-in required before the provider-key fallback.
    EVERYAPP_DEV?: string;
    // Developer-owned direct-provider fallbacks from .dev.vars only, read
    // with EVERYAPP_DEV set and no binding: the AI providers' keys
    // (createGatewayFetch) and the capabilities' keys (integrationFetch).
    OPENAI_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    // Workers AI needs both: an API token (Workers AI Read and Edit) and
    // the account it bills.
    WORKERS_AI_API_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    DATAFORSEO_API_KEY?: string;
    CONTEXT_API_KEY?: string;
    // sendEmail() in dev: with the REST token, CLOUDFLARE_ACCOUNT_ID and
    // EMAIL_FROM it sends from the developer's own Email Sending account;
    // otherwise it prints the message.
    EMAIL_REST_API_TOKEN?: string;
    EMAIL_FROM?: string;
    EMAIL_FROM_NAME?: string;
    // In dev, the senders .dev.vars sets (comma-separated or a JSON array),
    // standing in for the installation's (everyapp email set); sendEmail()
    // checks a `from` against them.
    EVERYAPP_EMAIL_SENDERS?: string;
    // integrationFetch() in dev for the OAuth clients' token endpoints: the
    // developer's own clients, under the gateway's names (MASTODON_URL is
    // the instance, https://mastodon.social when unset).
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
    GOOGLE_WORKSPACE_CLIENT_ID?: string;
    GOOGLE_WORKSPACE_CLIENT_SECRET?: string;
    MICROSOFT_365_CLIENT_ID?: string;
    MICROSOFT_365_CLIENT_SECRET?: string;
  }
}

interface Env extends Cloudflare.Env {}
