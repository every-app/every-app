#!/usr/bin/env node

/**
 * One-off script to regenerate local Cloudflare secrets for every-app-gateway
 * This script generates the same secrets that the CLI deploy command creates
 * and outputs them in .env format for .dev.vars
 */

import crypto from "crypto";
import readline from "readline";

// Color output helpers
const chalk = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
};

/**
 * Generate a secure random secret for Better Auth
 */
function generateBetterAuthSecret() {
  return crypto.randomBytes(32).toString("base64");
}

/**
 * Generate an RSA key pair for JWT signing
 */
function generateJwtKeyPair() {
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

/**
 * Escape a value for .env file format
 * Multi-line values need to be quoted
 */
function formatEnvValue(value) {
  // If it contains newlines, wrap in quotes and escape them
  if (value.includes("\n")) {
    return `"${value.replace(/\n/g, "\\n")}"`;
  }
  return value;
}

/**
 * Prompt user for input
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log(
    chalk.bold("\n🔐 Generating Local Secrets for every-app-gateway\n"),
  );
  console.log(
    chalk.dim(
      "This script will generate secrets in .env format for your .dev.vars file.\n",
    ),
  );

  try {
    console.log(chalk.bold("\nGenerating secrets...\n"));

    // Generate all secrets
    const betterAuthSecret = generateBetterAuthSecret();
    const keyPair = generateJwtKeyPair();

    // Output in .env format
    console.log(
      chalk.green(
        chalk.bold(
          "✓ Secrets generated! Copy the following to your .dev.vars file:\n",
        ),
      ),
    );
    console.log(chalk.dim("─".repeat(80)));
    console.log();
    console.log(`BETTER_AUTH_SECRET=${betterAuthSecret}`);
    console.log(`JWT_PRIVATE_KEY=${formatEnvValue(keyPair.privateKey)}`);
    console.log(`JWT_PUBLIC_KEY=${formatEnvValue(keyPair.publicKey)}`);
    console.log();
    console.log(chalk.dim("─".repeat(80)));
    console.log();
    console.log(
      chalk.yellow(
        "Note: After creating .dev.vars, restart your dev server for changes to take effect.\n",
      ),
    );
  } catch (error) {
    console.error(chalk.red("\n✗ Failed to generate secrets:"), error.message);
    process.exit(1);
  }
}

main();
