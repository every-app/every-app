import { execa, type Options as ExecaOptions } from "execa";
import {
  getDefaultAccountId,
  getValidCloudflareToken,
  listD1Databases,
} from "@/lib/cloudflare";
import { readWranglerConfig } from "@/lib/wrangler-config";

interface RemoteD1EnvVars {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_DATABASE_ID: string;
  CLOUDFLARE_API_TOKEN: string;
}

/**
 * Get the environment variables needed to connect to a remote D1 database
 * based on the wrangler.jsonc configuration in the given directory.
 */
export async function getRemoteD1Env(cwd: string): Promise<RemoteD1EnvVars> {
  // Read wrangler.jsonc to get database_name
  const config = await readWranglerConfig(cwd);

  if (!config.d1_databases || config.d1_databases.length === 0) {
    throw new Error(
      "No D1 databases found in wrangler.jsonc. Please add a D1 database configuration.",
    );
  }

  // Get the first D1 database configuration
  const d1Config = config.d1_databases[0];
  if (!d1Config) {
    throw new Error("No D1 database configuration found in wrangler.jsonc.");
  }
  const databaseName = d1Config.database_name;

  if (!databaseName) {
    throw new Error(
      "No database_name found in D1 database configuration in wrangler.jsonc.",
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

  const d1Env = await getRemoteD1Env(cwd);

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
