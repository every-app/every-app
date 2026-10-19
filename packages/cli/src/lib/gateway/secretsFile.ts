/**
 * The gateway's secrets. A first deploy generates them and sends them with
 * the upload (`cf deploy --secrets-file`), so the first version already has
 * them. `everyapp secret set <NAME>` changes the optional ones afterwards,
 * on the live Worker (the names in `SETTABLE_GATEWAY_SETTINGS` of
 * `@every-app/sdk/internal`); everything else stays as it is.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

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
