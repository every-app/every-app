import { execa, type Options as ExecaOptions } from "execa";
import {
  getDefaultAccountId,
  getValidCloudflareToken,
  listD1Databases,
} from "@/lib/cloudflare";
import { ensureGeneratedWranglerConfig } from "@/lib/generateWranglerConfig";

interface RemoteD1EnvVars {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_DATABASE_ID: string;
  CLOUDFLARE_API_TOKEN: string;
}

/**
 * Get the environment variables needed to connect to a remote D1 database
 * based on the generated Wrangler configuration in the given directory.
 */
export async function getRemoteD1Env(cwd: string): Promise<RemoteD1EnvVars> {
  const { config } = await ensureGeneratedWranglerConfig(cwd);

  if (!config.d1_databases || config.d1_databases.length === 0) {
    throw new Error(
      "No D1 databases found in everyapp.config.ts. Please add a D1 resource declaration.",
    );
  }

  // Get the first D1 database configuration
  const d1Config = config.d1_databases[0];
  if (!d1Config) {
    throw new Error("No D1 database configuration found.");
  }
  const databaseName = d1Config.database_name;

  if (!databaseName) {
    throw new Error(
      "No database_name found in generated D1 database configuration.",
    );
  }

  const [accountId, token] = await Promise.all([
    getDefaultAccountId(),
    getValidCloudflareToken(),
  ]);

  const databases = await listD1Databases(accountId);

  // Get database ID by looking up the database with matching name
  const database = databases.find((db) => db.name === databaseName);

  if (!database) {
    throw new Error(
      `Database "${databaseName}" not found in your Cloudflare account. ` +
        `Have you run deployment to create the database?`,
    );
  }

  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_DATABASE_ID: database.uuid,
    CLOUDFLARE_API_TOKEN: token,
  };
}

interface RunWithRemoteD1Options {
  /** Working directory */
  cwd: string;
  /** Additional environment variables to merge */
  env?: Record<string, string | undefined>;
  d1DatabaseId?: string;
  /** Whether to show command output */
  verbose?: boolean;
}

/**
 * Execute a command with the environment variables needed to connect
 * to a remote D1 database.
 */
export async function runWithRemoteD1(
  cmd: string,
  args: string[],
  options: RunWithRemoteD1Options,
): Promise<void> {
  const { cwd, env = {}, verbose = false } = options;

  const d1Env = options.d1DatabaseId
    ? {
        CLOUDFLARE_ACCOUNT_ID: await getDefaultAccountId(),
        CLOUDFLARE_DATABASE_ID: options.d1DatabaseId,
        CLOUDFLARE_API_TOKEN: await getValidCloudflareToken(),
      }
    : await getRemoteD1Env(cwd);

  const execaOptions: ExecaOptions = {
    cwd,
    stdio: verbose ? "inherit" : "pipe",
    env: {
      ...process.env,
      ...env,
      ...d1Env,
    },
  };

  await execa(cmd, args, execaOptions);
}
