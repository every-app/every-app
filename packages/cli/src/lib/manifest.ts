import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import {
  ManifestError,
  validateManifestStrict,
  type EveryAppManifest,
} from "@every-app/perimeter/manifest";

// The shared strict manifest schema covers every CLI field (including the
// dev command string), so the CLI adds nothing on top.
export type EveryAppCliManifest = EveryAppManifest;

export async function loadEveryAppManifest(
  cwd: string,
): Promise<EveryAppCliManifest> {
  const manifestPath = path.join(cwd, "everyapp.config.ts");
  try {
    await fs.access(manifestPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ManifestError(
        "No everyapp.config.ts found in the current directory — run this command from an app root.",
      );
    }
    throw error;
  }

  const jiti = createJiti(pathToFileURL(manifestPath).href);
  const raw = await jiti.import(manifestPath, { default: true });
  return validateManifestStrict(raw);
}

// An absent `migrations` field means drizzle against the first D1 binding, on
// both the deploy and dev-preflight paths. Diverging would silently skip the
// preflight for every app that doesn't spell the field out — which is all of
// the example apps.
export function resolveMigrationBinding(
  d1Bindings: readonly string[],
  migrations: EveryAppManifest["migrations"],
): string {
  const migrationBinding = migrations?.binding ?? d1Bindings[0]!;
  if (!d1Bindings.includes(migrationBinding)) {
    throw new Error(
      `Manifest migrations binding "${migrationBinding}" is not declared in resources.d1.`,
    );
  }
  return migrationBinding;
}
