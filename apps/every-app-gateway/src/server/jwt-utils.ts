import { SignJWT, importPKCS8, importSPKI, exportJWK } from "jose";
import invariant from "tiny-invariant";
import { z } from "zod";
import { auth } from "../auth";
import { env } from "cloudflare:workers";
import { EMBEDDED_APP_TOKEN_EXPIRY_SECONDS } from "./constants";

// Key ID for JWKS - must match between token header and JWKS endpoint
// Per RFC 7515, this allows verifiers to identify which key to use
const JWT_KEY_ID = "embedded-app-key-1";

// JWT additional claims schema - minimal for security
// appId uses aud claim, permissions/embeddedApp/name removed as unused
const JWTAdditionalClaimsSchema = z.object({});

type JWTAdditionalClaims = z.infer<typeof JWTAdditionalClaimsSchema>;

// Singleton key pair - loaded from environment variables
let signingKeyPair: { privateKey: CryptoKey; publicKey: CryptoKey } | null =
  null;

/**
 * Load the signing keys from environment variables
 * This ensures consistent keys across app restarts
 */
async function getSigningKey() {
  if (!signingKeyPair) {
    invariant(
      env?.JWT_PRIVATE_KEY,
      "JWT_PRIVATE_KEY environment variable is required",
    );
    invariant(
      env?.JWT_PUBLIC_KEY,
      "JWT_PUBLIC_KEY environment variable is required",
    );

    // Replace \n with actual newlines in the PEM strings
    const privateKeyPem = env.JWT_PRIVATE_KEY.replace(/\\n/g, "\n");
    const publicKeyPem = env.JWT_PUBLIC_KEY.replace(/\\n/g, "\n");

    const privateKey = await importPKCS8(privateKeyPem, "RS256");
    const publicKey = await importSPKI(publicKeyPem, "RS256");

    signingKeyPair = { privateKey, publicKey };
  }
  return signingKeyPair;
}

/**
 * Issue a properly signed session token for embedded apps
 */
export async function issueEmbeddedAppToken(
  user: typeof auth.$Infer.Session.user,
  audience: string,
  additionalClaims: JWTAdditionalClaims,
): Promise<string> {
  const { privateKey } = await getSigningKey();

  invariant(
    env?.GATEWAY_URL,
    "GATEWAY_URL secret is required to be set or specified in .dev.vars",
  );

  const jwt = await new SignJWT({
    email: user.email,
    ...additionalClaims,
  })
    .setProtectedHeader({ alg: "RS256", kid: JWT_KEY_ID })
    .setSubject(user.id)
    .setIssuer(env.GATEWAY_URL)
    .setAudience(audience)
    .setExpirationTime(`${EMBEDDED_APP_TOKEN_EXPIRY_SECONDS}s`)
    .setIssuedAt()
    .sign(privateKey);

  return jwt;
}

/**
 * Get the public JWKS for embedded apps
 */
export async function getPublicJWKS() {
  const { publicKey } = await getSigningKey();
  const jwk = await exportJWK(publicKey);

  return {
    keys: [
      {
        ...jwk,
        kid: JWT_KEY_ID,
        use: "sig",
        alg: "RS256",
      },
    ],
  };
}
