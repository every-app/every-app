import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import {
  validateManifestStrict,
  type EveryAppManifest,
} from "@every-app/perimeter/manifest";
import { EveryAppError } from "@/lib/errors";
import { isNotFoundError } from "@/lib/file-operations";

// The shared strict manifest schema covers every CLI field (including the
// dev command string), so the CLI adds nothing on top.
export type EveryAppCliManifest = EveryAppManifest;

export async function loadEveryAppManifest(
  cwd: string,
): Promise<EveryAppCliManifest> {
  return loadEveryAppManifestFile(path.join(cwd, "everyapp.config.ts"), {
    message: "No everyapp.config.ts in this directory",
    fix: "run this from the app's directory",
  });
}

/**
 * The manifest of the app in `cwd`, or null when there is no
 * everyapp.config.ts there (a command that works outside an app directory
 * too, like `secret`). One that is there but invalid still throws.
 */
export async function loadEveryAppManifestIfPresent(
  cwd: string,
): Promise<EveryAppCliManifest | null> {
  try {
    await fs.access(path.join(cwd, "everyapp.config.ts"));
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  return loadEveryAppManifest(cwd);
}

/**
 * An app's manifest from its file (`delete`, and `email --manifest`),
 * validated as a deploy validates the app's own.
 */
export async function loadEveryAppManifestFile(
  manifestPath: string,
  /** What MANIFEST_NOT_FOUND says when there is no file there, and how to fix it. */
  missing: { message: string; fix?: string } = { message: `No manifest at ${manifestPath}` },
): Promise<EveryAppCliManifest> {
  try {
    await fs.access(manifestPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new EveryAppError("MANIFEST_NOT_FOUND", missing.message, { fix: missing.fix });
    }
    throw error;
  }

  const jiti = createJiti(pathToFileURL(manifestPath).href);
  const raw = await jiti.import(manifestPath, { default: true });
  return validateManifestStrict(raw, LOCAL_MANIFEST_OPTIONS);
}

/**
 * How the CLI validates a manifest before it has asked a Gateway: every
 * field strictly, and a capability id outside the built-in catalog as a
 * well-formed entry (`access` and its need), since it may be a provider
 * registered on the Gateway (`everyapp provider add`). `deploy` checks the
 * ids against the Gateway's registry once connected (CAPABILITY_UNKNOWN),
 * and `dev` warns about each (CAPABILITY_NOT_IN_CATALOG).
 */
export const LOCAL_MANIFEST_OPTIONS = { unknownCapabilities: "accept" } as const;

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

/** The app's migrations directory, relative to the app (default drizzle). */
export function migrationsDir(manifest: EveryAppCliManifest): string {
  return manifest.migrations?.dir ?? "drizzle";
}
