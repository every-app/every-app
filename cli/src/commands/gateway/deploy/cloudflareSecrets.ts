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
  try {
    const { stdout } = await execa(
      "npx",
      ["wrangler", "secret", "list", "--format", "json"],
      { cwd },
    );
    return JSON.parse(stdout);
  } catch (error) {
    // If the command fails, return empty array (no secrets exist yet)
    return [];
  }
}

async function secretExists(secretName: string, cwd: string): Promise<boolean> {
  const secrets = await listSecrets(cwd);
  return secrets.some((secret) => secret.name === secretName);
}

async function uploadSecret(
  secretName: string,
  secretValue: string,
  cwd: string,
): Promise<void> {
  const subprocess = execa("npx", ["wrangler", "secret", "put", secretName], {
    cwd,
  });

  // Write the secret value to stdin
  if (subprocess.stdin) {
    subprocess.stdin.write(secretValue);
    subprocess.stdin.end();
  }

  await subprocess;
}

export async function setupSecrets(
  coreAppUrl: string,
  homebasePath: string,
): Promise<void> {
  console.log(chalk.bold("\nSetting up secrets...\n"));

  try {
    // Check and setup CORE_APP_URL
    console.log(chalk.bold("Checking secret: CORE_APP_URL\n"));
    const coreAppUrlExists = await secretExists("CORE_APP_URL", homebasePath);
    if (coreAppUrlExists) {
      console.log(chalk.dim("   Secret already exists\n"));
    } else {
      console.log(chalk.dim(`   Setting CORE_APP_URL to: ${coreAppUrl}\n`));
      await uploadSecret("CORE_APP_URL", coreAppUrl, homebasePath);
      console.log(chalk.green("Created secret: CORE_APP_URL\n"));
    }

    console.log(chalk.bold("Checking secret: BETTER_AUTH_URL\n"));
    const betterAuthUrlExists = await secretExists(
      "BETTER_AUTH_URL",
      homebasePath,
    );
    if (betterAuthUrlExists) {
      console.log(chalk.dim("   Secret already exists\n"));
    } else {
      console.log(chalk.dim(`   Setting BETTER_AUTH_URL to: ${coreAppUrl}\n`));
      await uploadSecret("BETTER_AUTH_URL", coreAppUrl, homebasePath);
      console.log(chalk.green("Created secret: BETTER_AUTH_URL\n"));
    }

    // Check and setup BETTER_AUTH_SECRET
    console.log(chalk.bold("Checking secret: BETTER_AUTH_SECRET\n"));
    const betterAuthSecretExists = await secretExists(
      "BETTER_AUTH_SECRET",
      homebasePath,
    );
    if (betterAuthSecretExists) {
      console.log(chalk.dim("   Secret already exists\n"));
    } else {
      console.log(chalk.dim("   Generating new Better Auth secret...\n"));
      const betterAuthSecret = generateBetterAuthSecret();
      await uploadSecret("BETTER_AUTH_SECRET", betterAuthSecret, homebasePath);
      console.log(chalk.green("Created secret: BETTER_AUTH_SECRET\n"));
    }

    // Check and setup JWT key pair
    console.log(chalk.bold("Checking secret: JWT_PRIVATE_KEY\n"));
    const privateKeyExists = await secretExists(
      "JWT_PRIVATE_KEY",
      homebasePath,
    );
    const publicKeyExists = await secretExists("JWT_PUBLIC_KEY", homebasePath);

    if (privateKeyExists && publicKeyExists) {
      console.log(chalk.dim("   JWT key pair already exists\n"));
    } else if (!privateKeyExists && !publicKeyExists) {
      console.log(chalk.dim("   Generating new JWT key pair...\n"));
      const keyPair = generateJwtKeyPair();
      await uploadSecret("JWT_PRIVATE_KEY", keyPair.privateKey, homebasePath);
      await uploadSecret("JWT_PUBLIC_KEY", keyPair.publicKey, homebasePath);
      console.log(chalk.green("Created JWT key pair secrets\n"));
    } else {
      // One exists but not the other - this is an error state
      throw new Error(
        "JWT key pair is incomplete. Both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must exist together. Please delete the existing key and redeploy.",
      );
    }

    console.log(chalk.green("Secret setup complete!\n"));
  } catch (error) {
    console.error(
      chalk.red("\nFailed to setup secrets"),
      error instanceof Error ? chalk.dim(`\n   ${error.message}`) : "",
    );
    throw error;
  }
}
