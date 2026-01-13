import crypto from "node:crypto";
import chalk from "chalk";
import type { JwtKeyPair } from "./types";
import { secretExists, uploadSecret } from "@/lib/secrets";

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
  gatewayPath: string;
  verbose?: boolean;
}

export async function setupSecrets({
  gatewayUrl,
  gatewayPath,
  verbose = false,
}: SetupSecretsOptions): Promise<void> {
  console.log("Configuring secrets for the authentication service (Better Auth)...");
  console.log(chalk.dim("  BETTER_AUTH_SECRET - Session signing and encryption"));
  console.log(chalk.dim("  JWT_PRIVATE_KEY    - Signs JWTs issued to your apps"));
  console.log(chalk.dim("  JWT_PUBLIC_KEY     - Apps use this to verify JWTs"));
  console.log();

  try {
    // Check and setup GATEWAY_URL
    const gatewayUrlExists = await secretExists({
      secretName: "GATEWAY_URL",
      cwd: gatewayPath,
      verbose,
    });
    if (!gatewayUrlExists) {
      await uploadSecret({
        secretName: "GATEWAY_URL",
        secretValue: gatewayUrl,
        cwd: gatewayPath,
        verbose,
        description: `Setting GATEWAY_URL to: ${gatewayUrl}`,
      });
    }

    // Check and setup BETTER_AUTH_SECRET
    const betterAuthSecretExists = await secretExists({
      secretName: "BETTER_AUTH_SECRET",
      cwd: gatewayPath,
      verbose,
    });
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

    // Check and setup JWT key pair
    const privateKeyExists = await secretExists({
      secretName: "JWT_PRIVATE_KEY",
      cwd: gatewayPath,
      verbose,
    });
    const publicKeyExists = await secretExists({
      secretName: "JWT_PUBLIC_KEY",
      cwd: gatewayPath,
      verbose,
    });

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

    if (verbose) {
      console.log("Secret setup complete!\n");
    } else {
      console.log("  Finished.\n");
    }
  } catch (error) {
    console.error(
      "\nFailed to setup secrets",
      error instanceof Error ? `\n   ${error.message}` : "",
    );
    throw error;
  }
}
