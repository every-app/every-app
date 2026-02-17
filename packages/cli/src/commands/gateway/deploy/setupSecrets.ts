import crypto from "node:crypto";
import chalk from "chalk";
import type { JwtKeyPair } from "./types";
import { listSecretNames, uploadSecret } from "@/lib/secrets";

/**
 * Generate a secure random secret for Better Auth
 */
function generateBetterAuthSecret(): string {
  return crypto.randomBytes(32).toString("base64");
}

/**
 * Generate an RSA key pair for JWT signing
 */
function generateJwtKeyPair(): JwtKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  return { privateKey, publicKey };
}

interface SetupSecretsOptions {
  gatewayUrl: string;
  cloudflareAccountId: string;
  gatewayPath: string;
  verbose?: boolean;
}

export async function setupSecrets({
  gatewayUrl,
  cloudflareAccountId,
  gatewayPath,
  verbose = false,
}: SetupSecretsOptions): Promise<void> {
  try {
    // Fetch all existing secrets in a single API call
    const existingSecrets = new Set(await listSecretNames({ cwd: gatewayPath }));

    const gatewayUrlExists = existingSecrets.has("GATEWAY_URL");
    const cloudflareAccountIdExists = existingSecrets.has(
      "CLOUDFLARE_ACCOUNT_ID",
    );
    const betterAuthSecretExists = existingSecrets.has("BETTER_AUTH_SECRET");
    const privateKeyExists = existingSecrets.has("JWT_PRIVATE_KEY");
    const publicKeyExists = existingSecrets.has("JWT_PUBLIC_KEY");

    // Only show auth secrets message if any are missing
    const authSecretsNeeded =
      !betterAuthSecretExists || !privateKeyExists || !publicKeyExists;

    if (authSecretsNeeded) {
      console.log(
        "Configuring secrets for the authentication service (Better Auth)...",
      );
      console.log(
        chalk.dim("  BETTER_AUTH_SECRET - Session signing and encryption"),
      );
      console.log(
        chalk.dim("  JWT_PRIVATE_KEY    - Signs JWTs issued to your apps"),
      );
      console.log(
        chalk.dim("  JWT_PUBLIC_KEY     - Apps use this to verify JWTs"),
      );
      console.log();
    }

    // Setup GATEWAY_URL if needed
    if (!gatewayUrlExists) {
      await uploadSecret({
        secretName: "GATEWAY_URL",
        secretValue: gatewayUrl,
        cwd: gatewayPath,
        verbose,
        description: `Setting GATEWAY_URL to: ${gatewayUrl}`,
      });
    }

    if (!cloudflareAccountIdExists) {
      await uploadSecret({
        secretName: "CLOUDFLARE_ACCOUNT_ID",
        secretValue: cloudflareAccountId,
        cwd: gatewayPath,
        verbose,
        description: `Setting CLOUDFLARE_ACCOUNT_ID to: ${cloudflareAccountId}`,
      });
    }

    // Setup BETTER_AUTH_SECRET if needed
    if (!betterAuthSecretExists) {
      const betterAuthSecret = generateBetterAuthSecret();
      await uploadSecret({
        secretName: "BETTER_AUTH_SECRET",
        secretValue: betterAuthSecret,
        cwd: gatewayPath,
        verbose,
        description: "Generating new Better Auth secret...",
      });
    }

    // Setup JWT key pair
    if (privateKeyExists && publicKeyExists) {
      if (verbose) {
        console.log(chalk.dim("   JWT key pair already exists\n"));
      }
    } else if (!privateKeyExists && !publicKeyExists) {
      if (verbose) {
        console.log(chalk.dim("   Generating new JWT key pair...\n"));
      }
      const keyPair = generateJwtKeyPair();
      await uploadSecret({
        secretName: "JWT_PRIVATE_KEY",
        secretValue: keyPair.privateKey,
        cwd: gatewayPath,
        verbose,
      });
      await uploadSecret({
        secretName: "JWT_PUBLIC_KEY",
        secretValue: keyPair.publicKey,
        cwd: gatewayPath,
        verbose,
      });
      if (verbose) {
        console.log(chalk.green("Created JWT key pair secrets\n"));
      }
    } else {
      // One exists but not the other - this is an error state
      throw new Error(
        "JWT key pair is incomplete. Both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must exist together. Please delete the existing key and redeploy.",
      );
    }

    if (authSecretsNeeded) {
      if (verbose) {
        console.log("Secret setup complete!\n");
      } else {
        console.log("  Finished.\n");
      }
    }
  } catch (error) {
    console.error(
      "\nFailed to setup secrets",
      error instanceof Error ? `\n   ${error.message}` : "",
    );
    throw error;
  }
}
