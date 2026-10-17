/**
 * The gateway's secrets. A first deploy generates them and sends them with
 * the upload (`cf deploy --secrets-file`), so the first version already has
 * them. Later deploys send only what `everyapp secret set --for gateway` sets;
 * everything else stays as it is on the Worker.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { EveryAppError } from "@/lib/errors";

/** Optional settings `everyapp secret set --for gateway` may change. */
const SETTABLE_GATEWAY_SECRETS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  // Workers AI's API token; its account is the install's CLOUDFLARE_ACCOUNT_ID.
  "WORKERS_AI_API_TOKEN",
  "DATAFORSEO_API_KEY",
  "CONTEXT_API_KEY",
  // Social networks' OAuth clients, and the Mastodon instance's URL.
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
  "AI_PROXY_EXTRA_ROUTES",
  "EMAIL_REST_API_TOKEN",
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "MCP_OAUTH_ENABLED",
  "MCP_DCR_ENABLED",
  "MCP_ALLOWED_ORIGINS",
  "MCP_AUDIT_RETENTION_DAYS",
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
  // "false" keeps the hosted gateway's sign-up invite-only.
  "HOSTED_OPEN_SIGNUP",
  // The hosted deploy API's deployer and the third-party domain. Its launch
  // gate, THIRD_PARTY_DEPLOYS, is never set from here: it is opened by
  // hand once the launch checks pass (docs/runbooks/hosted-install.md).
  "CF_DEPLOY_TOKEN",
  "DISPATCH_NAMESPACE",
  "THIRD_PARTY_DOMAIN",
] as const;

/**
 * What the gateway is (GATEWAY_DEPLOYMENT_MODE, ADR-0001): an operator's
 * own install, or the hosted one. Set once, with a new gateway's secrets:
 * nothing changes it after the first deploy.
 */
export const DEPLOYMENT_MODES = ["self_hosted", "hosted"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

/**
 * A new gateway's secrets, with a new identity key pair. The public half
 * comes with them, apart, because whatever sends these must record it in
 * the install row with the upload (lib/gateway/apply.ts record()): app
 * deploys hand it to their Workers, and a new pair the row doesn't name
 * leaves every app rejecting the gateway's identities.
 */
export function newGatewaySecrets({
  gatewayUrl,
  accountId,
  deploymentMode,
}: {
  gatewayUrl: string;
  accountId: string;
  deploymentMode: DeploymentMode;
}): { secrets: Record<string, string>; jwtPublicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    secrets: {
      GATEWAY_URL: gatewayUrl,
      // Session signing and encryption; HMAC key material for app tokens.
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
      // Signs the identity JWTs the gateway mints; apps verify with the public key.
      JWT_PRIVATE_KEY: privateKey,
      JWT_PUBLIC_KEY: publicKey,
      GATEWAY_DEPLOYMENT_MODE: deploymentMode,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
    jwtPublicKey: publicKey,
  };
}

/** Refuse anything but the gateway's optional settings. */
export function assertSettableSecret(name: string): void {
  if (!(SETTABLE_GATEWAY_SECRETS as readonly string[]).includes(name)) {
    throw new EveryAppError(
      "SECRET_NOT_SETTABLE",
      `${name} isn't a gateway setting this command changes. It sets: ${SETTABLE_GATEWAY_SECRETS.join(", ")}.`,
    );
  }
}
