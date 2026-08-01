import chalk from "chalk";
import {
  makeCloudflareAPIRequest,
  getDefaultAccountId,
} from "@/lib/cloudflare/auth";
import { loadEveryAppManifest } from "@/lib/generateWranglerConfig";
import { workerNameFor } from "@every-app/perimeter/manifest";

interface SecretInfo {
  name: string;
  type: string;
}

interface WorkerContext {
  accountId: string;
  workerName: string;
}

/**
 * Resolve worker context (account ID and worker name) for secrets operations
 */
async function resolveWorkerContext(
  cwd: string,
  workerName?: string,
): Promise<WorkerContext> {
  const accountId = await getDefaultAccountId();
  if (workerName) {
    return { accountId, workerName };
  }
  const manifest = await loadEveryAppManifest(cwd);
  const resolvedWorkerName = workerNameFor(manifest.id);
  return { accountId, workerName: resolvedWorkerName };
}

/**
 * List all secrets for a worker using the Cloudflare REST API
 * GET /accounts/{account_id}/workers/scripts/{script_name}/secrets
 */
async function listSecrets(ctx: WorkerContext): Promise<SecretInfo[]> {
  const result = await makeCloudflareAPIRequest<SecretInfo[]>(
    `/accounts/${ctx.accountId}/workers/scripts/${ctx.workerName}/secrets`,
  );

  return result;
}

interface ListSecretNamesOptions {
  cwd: string;
  workerName?: string;
}

/**
 * List all secret names for a worker
 */
export async function listSecretNames({
  cwd,
  workerName,
}: ListSecretNamesOptions): Promise<string[]> {
  const ctx = await resolveWorkerContext(cwd, workerName);
  const secrets = await listSecrets(ctx);
  return secrets.map((secret) => secret.name);
}

interface SecretExistsOptions {
  secretName: string;
  cwd: string;
  workerName?: string;
  verbose?: boolean;
}

/**
 * Check if a secret exists
 */
export async function secretExists({
  secretName,
  cwd,
  workerName,
  verbose = false,
}: SecretExistsOptions): Promise<boolean> {
  if (verbose) {
    console.log(chalk.dim(`   Checking secret: ${secretName}`));
  }

  const ctx = await resolveWorkerContext(cwd, workerName);
  const secrets = await listSecrets(ctx);
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
  workerName?: string;
  verbose?: boolean;
  description?: string;
}

/**
 * Upload a secret to Cloudflare using the REST API
 * PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets
 */
export async function uploadSecret({
  secretName,
  secretValue,
  cwd,
  workerName,
  verbose = false,
  description,
}: UploadSecretOptions): Promise<void> {
  if (verbose && description) {
    console.log(chalk.dim(`   ${description}\n`));
  }

  const ctx = await resolveWorkerContext(cwd, workerName);

  await makeCloudflareAPIRequest(
    `/accounts/${ctx.accountId}/workers/scripts/${ctx.workerName}/secrets`,
    {
      method: "PUT",
      body: JSON.stringify({
        name: secretName,
        text: secretValue,
        type: "secret_text",
      }),
    },
  );

  if (verbose) {
    console.log(chalk.green(`Created secret: ${secretName}\n`));
  }
}
