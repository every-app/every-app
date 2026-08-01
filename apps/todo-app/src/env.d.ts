// Custom environment variable type definitions
// These extend the auto-generated Env interface from worker-configuration.d.ts

declare namespace Cloudflare {
  interface Env {
    EVERYAPP_APP_ID: string;
    // JSON array of SPKI PEM public keys for identity verification,
    // injected at deploy time (or written to .dev.vars by `everyapp dev`).
    EVERYAPP_IDENTITY_PUBLIC_KEYS: string;
    EVERYAPP_IDENTITY_ISSUER?: string;
  }
}
