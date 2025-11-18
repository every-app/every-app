import { execa } from "execa";
import crypto from "node:crypto";
import chalk from "chalk";
import type { JwtKeyPair, SecretInfo } from "./types";

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

async function listSecrets(cwd: string): Promise<SecretInfo[]> {
  const { stdout } = await execa(
    "npx",
    ["wrangler", "secret", "list", "--format", "json"],
    { cwd },
  );
  return JSON.parse(stdout);
}

async function secretExists(
  secretName: string,
  cwd: string,
  verbose: boolean = false,
): Promise<boolean> {
  if (verbose) {
    console.log(chalk.dim(`   Checking secret: ${secretName}`));
  }
  const secrets = await listSecrets(cwd);
  const exists = secrets.some((secret) => secret.name === secretName);

  if (exists && verbose) {
    console.log(chalk.dim("   Secret already exists\n"));
  }

  return exists;
}

async function uploadSecret(
  secretName: string,
  secretValue: string,
  cwd: string,
  verbose: boolean = false,
  description?: string,
): Promise<void> {
  if (verbose && description) {
    console.log(chalk.dim(`   ${description}\n`));
  }

  const subprocess = execa("npx", ["wrangler", "secret", "put", secretName], {
    cwd,
  });

  // Write the secret value to stdin
  if (subprocess.stdin) {
    subprocess.stdin.write(secretValue);
    subprocess.stdin.end();
  }

  await subprocess;

  if (verbose) {
    console.log(chalk.green(`Created secret: ${secretName}\n`));
  }
}

export async function setupSecrets(
  gatewayUrl: string,
  homebasePath: string,
  verbose: boolean = false,
): Promise<void> {
  console.log("\nConfiguring Secrets...");

  try {
    // Check and setup GATEWAY_URL
    const gatewayUrlExists = await secretExists(
      "GATEWAY_URL",
      homebasePath,
      verbose,
    );
    if (!gatewayUrlExists) {
      await uploadSecret(
        "GATEWAY_URL",
        gatewayUrl,
        homebasePath,
        verbose,
        `Setting GATEWAY_URL to: ${gatewayUrl}`,
      );
    }

    // Check and setup BETTER_AUTH_SECRET
    const betterAuthSecretExists = await secretExists(
      "BETTER_AUTH_SECRET",
      homebasePath,
      verbose,
    );
    if (!betterAuthSecretExists) {
      const betterAuthSecret = generateBetterAuthSecret();
      await uploadSecret(
        "BETTER_AUTH_SECRET",
        betterAuthSecret,
        homebasePath,
        verbose,
        "Generating new Better Auth secret...",
      );
    }

    // Check and setup JWT key pair
    const privateKeyExists = await secretExists(
      "JWT_PRIVATE_KEY",
      homebasePath,
      verbose,
    );
    const publicKeyExists = await secretExists(
      "JWT_PUBLIC_KEY",
      homebasePath,
      verbose,
    );

    if (privateKeyExists && publicKeyExists) {
      if (verbose) {
        console.log(chalk.dim("   JWT key pair already exists\n"));
      }
    } else if (!privateKeyExists && !publicKeyExists) {
      if (verbose) {
        console.log(chalk.dim("   Generating new JWT key pair...\n"));
      }
      const keyPair = generateJwtKeyPair();
      await uploadSecret(
        "JWT_PRIVATE_KEY",
        keyPair.privateKey,
        homebasePath,
        verbose,
      );
      await uploadSecret(
        "JWT_PUBLIC_KEY",
        keyPair.publicKey,
        homebasePath,
        verbose,
      );
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
