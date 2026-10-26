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
    // The developer's own provider keys from .dev.vars (read with
    // EVERYAPP_DEV set and no binding) are not listed here: the SDK reads
    // them by the catalog's names (DEV_GATEWAY_KEYS in
    // cloudflare/catalogSettings.generated.ts), and everyAppWorker() types
    // the ones an app's manifest asks for.
    // The account Workers AI and Email Sending's REST API bill in dev.
    CLOUDFLARE_ACCOUNT_ID?: string;
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
  }
}

interface Env extends Cloudflare.Env {}
