import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { bindings, defineConfig, triggers } from "cf/config";
import { EVERYAPP_OBSERVABILITY } from "@every-app/sdk/cloudflare";
import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

// The gateway Worker, for `cf dev` and the release build CI runs
// (scripts/build-release.ts). It is never deployed from here:
// `everyapp setup` (and the rebind in `everyapp deploy`) patches the
// release's Build Output with the install's resource ids, app bindings,
// domains and release stamp, and refuses to upload if any PATCH
// placeholder survives.
const NAME = "every-app-gateway";
const PATCH = "__EVERYAPP_PATCH__";

// `cf d1 … --local` only accepts a UUID or 32-hex id, so dev gives the
// database a fixed one (scripts/cf-local.mjs computes the same).
const LOCAL_D1_ID = createHash("sha256")
  .update(`${NAME}:DB`)
  .digest("hex")
  .slice(0, 32);

// Settings the gateway reads only when they are set. Deployed gateways keep
// them as plain secrets (`everyapp secret set <NAME>`), which survive every
// deploy. In dev the Vite plugin passes a value through only for a declared
// secret, so the ones set locally are declared. A test checks every AI
// provider's and capability's settings are here (src/optional-secrets.test.ts).
export const OPTIONAL_SECRETS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  // Workers AI (`/api/ai/workers-ai`), with CLOUDFLARE_ACCOUNT_ID below.
  "WORKERS_AI_API_TOKEN",
  "DATAFORSEO_API_KEY",
  "CONTEXT_API_KEY",
  // Social networks' OAuth clients (src/server/capabilities/oauthClient.ts).
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "FACEBOOK_APP_ID",
  "FACEBOOK_APP_SECRET",
  "INSTAGRAM_APP_ID",
  "INSTAGRAM_APP_SECRET",
  "THREADS_APP_ID",
  "THREADS_APP_SECRET",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "TIKTOK_CLIENT_ID",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_BUSINESS_CLIENT_ID",
  "TIKTOK_BUSINESS_CLIENT_SECRET",
  "REDDIT_CLIENT_ID",
  "REDDIT_CLIENT_SECRET",
  "PINTEREST_CLIENT_ID",
  "PINTEREST_CLIENT_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "MASTODON_CLIENT_ID",
  "MASTODON_CLIENT_SECRET",
  "MASTODON_URL",
  "KICK_CLIENT_ID",
  "KICK_CLIENT_SECRET",
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TUMBLR_CLIENT_ID",
  "TUMBLR_CLIENT_SECRET",
  "DRIBBBLE_CLIENT_ID",
  "DRIBBBLE_CLIENT_SECRET",
  // Mail and calendar clients.
  "GOOGLE_WORKSPACE_CLIENT_ID",
  "GOOGLE_WORKSPACE_CLIENT_SECRET",
  "MICROSOFT_365_CLIENT_ID",
  "MICROSOFT_365_CLIENT_SECRET",
  "AI_PROXY_EXTRA_ROUTES",
  // Email's providers (src/server/email/providers): Cloudflare's REST pair
  // (with CLOUDFLARE_ACCOUNT_ID below), Resend's key, and the choice.
  "EMAIL_REST_API_TOKEN",
  "RESEND_API_KEY",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
  "GATEWAY_DEPLOYMENT_MODE",
  "MCP_OAUTH_ENABLED",
  "MCP_DCR_ENABLED",
  "MCP_ALLOWED_ORIGINS",
  "MCP_AUDIT_RETENTION_DAYS",
  // Local testing only: honored only on a localhost GATEWAY_URL.
  "MCP_ACCESS_TOKEN_TTL",
  // Cloudflare Access sign-in (src/auth/cloudflare-access/config.ts).
  "CLOUDFLARE_ACCESS_OIDC_ISSUER",
  "CLOUDFLARE_ACCESS_OIDC_CLIENT_ID",
  "CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET",
  "CLOUDFLARE_ACCESS_OIDC_LABEL",
  "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
  "CLOUDFLARE_ACCESS_AUD",
  "CLOUDFLARE_ACCESS_APPS_AUD",
  "CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS",
  "CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN",
  "EMAIL_PASSWORD_SIGN_IN",
  "EVERYAPP_DEV_COOKIE_DOMAIN",
  "APP_BASE_DOMAIN",
  // The hosted gateway's sign-up switch (src/server/platform-policy.ts).
  "HOSTED_OPEN_SIGNUP",
  // The hosted deploy API's gate, deployer and third-party domain
  // (src/server/deploy, docs/runbooks/hosted-install.md).
  "THIRD_PARTY_DEPLOYS",
  "CF_DEPLOY_TOKEN",
  // Self-hosted browser installs are on by default; set to "off" to opt out.
  "BROWSER_APP_INSTALLS",
  "DISPATCH_NAMESPACE",
  "THIRD_PARTY_DOMAIN",
] as const;

/**
 * The settings for local dev, read the way the Vite plugin reads them:
 * `.dev.vars[.<mode>]` alone when present, otherwise `.env` files and the
 * process environment.
 */
function localSettings(mode: string): Record<string, string | undefined> {
  const file = (name: string) => new URL(name, import.meta.url);
  const read = (name: string) =>
    existsSync(file(name)) ? parseEnv(readFileSync(file(name), "utf8")) : {};
  const devVars = [`.dev.vars.${mode}`, ".dev.vars"].find((name) =>
    existsSync(file(name)),
  );
  return devVars
    ? read(devVars)
    : {
        ...read(".env"),
        ...read(".env.local"),
        ...read(`.env.${mode}`),
        ...read(`.env.${mode}.local`),
        ...process.env,
      };
}

/** The optional secrets set for local dev. */
function locallySetSecrets(
  values: Record<string, string | undefined>,
): Partial<
  Record<(typeof OPTIONAL_SECRETS)[number], ReturnType<typeof bindings.secret>>
> {
  return Object.fromEntries(
    OPTIONAL_SECRETS.filter((name) => values[name]).map((name) => [
      name,
      bindings.secret(),
    ]),
  );
}

/**
 * Remote MCP apps' credentials (`<ID>_MCP_TOKEN`, docs/design/2026-10-mcp-by-url.md)
 * are named by registry rows, not here: in dev every such name set in
 * .dev.vars is declared, so the Worker sees it as a deployed one would.
 * The family rule is `isRemoteMcpSecretName` in
 * packages/sdk/src/internal/gatewaySettings.ts, kept as a regex here
 * since this file loads before the SDK is built.
 */
const REMOTE_MCP_SECRET_PATTERN = /^[A-Z][A-Z0-9_]*_MCP_TOKEN$/;

function locallySetRemoteMcpSecrets(
  values: Record<string, string | undefined>,
): Record<string, ReturnType<typeof bindings.secret>> {
  return Object.fromEntries(
    Object.keys(values)
      .filter((name) => REMOTE_MCP_SECRET_PATTERN.test(name) && values[name])
      .map((name) => [name, bindings.secret()]),
  );
}

function devBindings(values: Record<string, string | undefined>) {
  return {
    GATEWAY_DEPLOYMENT_MODE: bindings.text<string>(
      values["GATEWAY_DEPLOYMENT_MODE"] || "self_hosted",
    ),
    ...locallySetSecrets(values),
    ...locallySetRemoteMcpSecrets(values),
  };
}

export default defineConfig(({ mode }) => {
  // cf API commands and `cf workers types` load the config without a mode;
  // they get the dev shape, which declares every binding the code reads.
  const production = mode === "production";
  return {
    worker: {
      name: NAME,
      entrypoint,
      compatibilityDate: "2025-09-02",
      // global_fetch_strictly_public: the MCP OAuth server fetches clients'
      // metadata documents (CIMD, e.g. claude.ai's) as a request from the
      // internet would go, through Cloudflare's front door, never straight
      // to an origin behind a zone (SSRF protection). A URL on this
      // gateway's own domain would still reach this Worker that way, so the
      // server refuses client ids there before fetching
      // (src/server/mcp-auth/own-domain.ts). Without the flag the server
      // doesn't advertise CIMD and claude.ai falls back to DCR.
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      // The Worker sees every request: app hosts are proxied to their
      // private Workers, so an asset must never answer one. The control
      // plane serves its own assets through ASSETS.
      assets: { runWorkerFirst: true },
      workersDev: false,
      previewUrls: false,
      // No routes: the deploy publishes the gateway's own host and its apps'
      // as Custom Domains. A hosted install with third-party apps adds one
      // route by hand, `*.<THIRD_PARTY_DOMAIN>/*` (`*.everyapp.dev/*`) on that
      // zone, for their hosts (src/server/app-hosts.ts,
      // docs/runbooks/hosted-install.md).
      // Hourly MCP housekeeping (src/server/mcp-auth/maintenance.ts): prune
      // the tool-call audit table, expire idle connections, sweep OAuth
      // storage. The deploy keeps it next to the domains it publishes.
      triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
      observability: {
        ...EVERYAPP_OBSERVABILITY,
        logs: { ...EVERYAPP_OBSERVABILITY.logs },
        traces: { ...EVERYAPP_OBSERVABILITY.traces },
        issues: { ...EVERYAPP_OBSERVABILITY.issues },
      },
      env: {
        ASSETS: bindings.assets(),
        DB: bindings.d1({
          name: NAME,
          ...(production ? {} : { id: LOCAL_D1_ID }),
        }),
        // The MCP OAuth server's storage (grants, tokens, clients, consent
        // transactions), and the hourly sweep's cursor.
        OAUTH_KV: bindings.kv(),
        EMAIL: bindings.sendEmail(),
        CF_VERSION_METADATA: bindings.versionMetadata(),
        // Brute-force limits on sign-in, sign-up, password reset, the setup
        // claim and OAuth (src/server/auth-rate-limit.ts), counted per
        // Cloudflare location: generous per client address (an IPv6 /64),
        // so an office behind one is fine; tighter per (address, email); and
        // per email alone, generous, whatever addresses the guesses come
        // from. The namespace ids are per account; no other Worker in it may
        // reuse them.
        AUTH_RATE_LIMIT_IP: bindings.rateLimit({
          namespace: "4180",
          simple: { limit: 60, period: 60 },
        }),
        AUTH_RATE_LIMIT_EMAIL: bindings.rateLimit({
          namespace: "4181",
          simple: { limit: 10, period: 60 },
        }),
        AUTH_RATE_LIMIT_ACCOUNT: bindings.rateLimit({
          namespace: "4182",
          simple: { limit: 30, period: 60 },
        }),
        // The gateway's own origin. A secret, as on gateways that predate
        // this config.
        GATEWAY_URL: bindings.secret(),
        // Better Auth's secret, also HMAC key material for personal access
        // token hashes (with domain separation).
        BETTER_AUTH_SECRET: bindings.secret(),
        // RS256 keypair for the identity JWTs the perimeter mints per proxied
        // request (kid "everyapp-identity"); apps verify with the public key,
        // which `everyapp deploy` builds into them.
        JWT_PRIVATE_KEY: bindings.secret(),
        JWT_PUBLIC_KEY: bindings.secret(),
        // Which gateway release this Worker runs, patched in by the deploy.
        EVERYAPP_RELEASE: bindings.json(
          production
            ? { version: PATCH, sha256: PATCH }
            : { version: "dev", sha256: "dev" },
        ),
        // The domain apps live one label below, each a Workers Custom
        // Domain on this Worker (src/server/app-hosts.ts). The deploy sets
        // it, or removes it for an install still served through a wildcard
        // route; a CLI that predates it leaves the placeholder and so
        // refuses to deploy this release, rather than dropping the apps'
        // domains from it.
        // Dev runs as a self-hosted gateway (src/server/platform-policy.ts)
        // unless GATEWAY_DEPLOYMENT_MODE is set locally (the value is
        // declared here, so whatever it says reaches the policy, which
        // refuses an unknown one); a deployed one has the secret the CLI set
        // at install.
        ...(production
          ? { APP_BASE_DOMAIN: bindings.text<string>(PATCH) }
          : devBindings(localSettings(mode ?? "development"))),
      },
    },
  };
});
