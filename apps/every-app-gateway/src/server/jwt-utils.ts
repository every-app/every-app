import { SignJWT, importPKCS8, importSPKI, exportJWK } from "jose";
import invariant from "tiny-invariant";
import { z } from "zod";
import { auth } from "../auth";
import { getBindings } from "./bindings";

// JWT additional claims schema
const JWTAdditionalClaimsSchema = z.object({
  appId: z.string(),
  permissions: z.array(z.string()),
  embeddedApp: z.boolean(),
});

type JWTAdditionalClaims = z.infer<typeof JWTAdditionalClaimsSchema>;

// Singleton key pair - loaded from environment variables
let signingKeyPair: { privateKey: any; publicKey: any } | null = null;

/**
 * Load the signing keys from environment variables
 * This ensures consistent keys across app restarts
 */
async function getSigningKey() {
  if (!signingKeyPair) {
    const env = getBindings();
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
  const env = getBindings();

  invariant(
    env?.GATEWAY_URL,
    "GATEWAY_URL secret is required to be set or specified in .dev.vars",
  );

  const jwt = await new SignJWT({
    email: user.email,
    name: user.name,
    ...additionalClaims,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(user.id)
    .setIssuer(env.GATEWAY_URL)
    .setAudience(audience)
    .setExpirationTime("60s") // 1 minute
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
        kid: "embedded-app-key-1",
        use: "sig",
        alg: "RS256",
      },
    ],
  };
}
