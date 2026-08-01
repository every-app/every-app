// Environment variables the SDK reads. Apps declare these via the manifest;
// the CLI/gateway inject them at deploy time.

declare namespace Cloudflare {
  interface Env {
    // App id used as the expected audience for identity verification.
    EVERYAPP_APP_ID: string;
    // JSON array of SPKI PEM public keys (current + next) for identity
    // verification. Injected by the gateway at deploy — never fetched at runtime.
    EVERYAPP_IDENTITY_PUBLIC_KEYS?: string;
    // Private app-to-gateway service binding, omitted by `everyapp dev`.
    EVERY_APP_GATEWAY?: Fetcher;
    // Explicit local-dev opt-in required before the provider-key fallback.
    EVERYAPP_DEV?: string;
    // Developer-owned direct-provider fallback from .dev.vars only.
    OPENAI_API_KEY?: string;
  }
}

interface Env extends Cloudflare.Env {}
