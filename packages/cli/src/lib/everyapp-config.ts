import fs from "node:fs/promises";
import path from "node:path";
import * as jsonc from "jsonc-parser";
import { z } from "zod";

const CONFIG_FILENAME = "every-app.jsonc";

/**
 * Schema for every-app.jsonc
 */
const EveryAppConfigSchema = z.object({
  appId: z.string().min(1, "appId cannot be empty"),
  displayName: z.string().min(1, "displayName cannot be empty").optional(),
  description: z.string().optional(),
});

type EveryAppConfig = z.infer<typeof EveryAppConfigSchema>;

/**
 * Read every-app.jsonc from a directory
 * @param cwd - Directory containing every-app.jsonc
 * @returns Parsed config
 * @throws Error if file doesn't exist or is invalid
 */
export async function readEveryAppConfig(cwd: string): Promise<EveryAppConfig> {
  const configPath = path.join(cwd, CONFIG_FILENAME);

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = jsonc.parse(content);
    return EveryAppConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "every-app.jsonc not found. Make sure you're running this command from an Every App project directory.",
      );
    }
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((i) => i.message).join(", ");
      throw new Error(`Invalid every-app.jsonc: ${issues}`);
    }
    throw error;
  }
}

/**
 * Convert kebab-case to Title Case
 * e.g., "my-cool-app" -> "My Cool App"
 */
function kebabToTitleCase(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Write every-app.jsonc to a directory
 * @param cwd - Directory to write to
 * @param config - Configuration to write (displayName will be auto-generated from appId if not provided)
 */
export async function writeEveryAppConfig(
  cwd: string,
  config: EveryAppConfig,
): Promise<void> {
  const configPath = path.join(cwd, CONFIG_FILENAME);

  // Auto-generate displayName from appId if not provided
  const fullConfig: EveryAppConfig = {
    ...config,
    displayName: config.displayName ?? kebabToTitleCase(config.appId),
  };

  const content = JSON.stringify(fullConfig, null, 2) + "\n";
  await fs.writeFile(configPath, content);
}

/**
 * Get the appId for deployment from every-app.jsonc
 *
 * @param cwd - Directory containing config files
 * @returns The appId (unprefixed)
 */
export async function getAppId(cwd: string): Promise<string> {
  const config = await readEveryAppConfig(cwd);
  return config.appId;
}
