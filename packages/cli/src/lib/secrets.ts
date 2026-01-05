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

interface SecretExistsOptions {
  secretName: string;
  cwd: string;
  verbose?: boolean;
}

/**
 * Check if a secret exists
 */
export async function secretExists({
  secretName,
  cwd,
  verbose = false,
}: SecretExistsOptions): Promise<boolean> {
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

interface UploadSecretOptions {
  secretName: string;
  secretValue: string;
  cwd: string;
  verbose?: boolean;
  description?: string;
}

/**
 * Upload a secret to Cloudflare
 */
export async function uploadSecret({
  secretName,
  secretValue,
  cwd,
  verbose = false,
  description,
}: UploadSecretOptions): Promise<void> {
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
