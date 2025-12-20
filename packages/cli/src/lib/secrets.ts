import { execa } from "execa";
import chalk from "chalk";

interface SecretInfo {
  name: string;
  type: string;
}

/**
 * List all secrets for a worker
 */
async function listSecrets(cwd: string): Promise<SecretInfo[]> {
  const { stdout } = await execa(
    "npx",
    ["wrangler", "secret", "list", "--format", "json"],
    { cwd },
  );
  return JSON.parse(stdout);
}

/**
 * Check if a secret exists
 */
export async function secretExists(
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

/**
 * Upload a secret to Cloudflare
 */
export async function uploadSecret(
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
