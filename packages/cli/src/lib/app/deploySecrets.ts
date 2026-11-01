import { isNotFoundError } from "@/lib/file-operations";
import { ensureGitignored } from "@/lib/gitignore";
import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

import { APP_SECRETS_FILE, type AppSecrets } from "@every-app/perimeter/install";
export {
  APP_SECRETS_FILE,
  describeOriginVariables,
  hyperdriveOriginUrl,
  hyperdriveOriginVariables,
  parseOriginUrl,
  POSTGRES_URL_VARIABLE,
  redactSecrets,
  type AppSecrets,
  type HyperdriveOrigin,
} from "@every-app/perimeter/install";
/** The app's secrets file, or nothing when it has none. */
export async function readAppSecrets(cwd: string): Promise<AppSecrets> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(cwd, APP_SECRETS_FILE), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return {};
    throw error;
  }
  ensureGitignored(cwd, `${path.dirname(APP_SECRETS_FILE)}/`);
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(raw))) {
    if (value?.trim()) values[name] = value.trim();
  }
  return values;
}
