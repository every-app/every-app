/**
 * An app's upload for the hosted deploy API: its Build Output (the
 * tenant-neutral build, uninstalled: the gateway's deployer installs it), its
 * evaluated manifest, its migrations and the stamp the gateway checks, as
 * the multipart body HOSTED_DEPLOY_PARTS names
 * (@every-app/perimeter/manifest).
 */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  bundleModuleType,
  HOSTED_DEPLOY_PARTS,
  HOSTED_DEPLOY_PROTOCOL,
} from "@every-app/perimeter/manifest";
import { version as cliVersion } from "../../../package.json";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { resolveMigrationBinding } from "@/lib/manifest";

const WORKER_DIR = path.join(".cloudflare", "output", "v0", "workers", "default");

async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

/** The app's migration files, in the order they apply. */
async function migrationFiles(
  cwd: string,
  manifest: EveryAppCliManifest,
): Promise<Array<{ name: string; file: string }>> {
  const bindings = manifest.resources?.d1 ?? [];
  if (bindings.length === 0) return [];
  resolveMigrationBinding(bindings, manifest.migrations);
  const dir = path.resolve(cwd, manifest.migrations?.dir ?? "drizzle");
  return (await filesUnder(dir))
    // `<name>.sql`, or drizzle-kit's newer `<tag>/migration.sql`.
    .filter((name) => /^[^/]+\.sql$/.test(name) || /^[^/]+\/migration\.sql$/.test(name))
    .map((name) => ({ name, file: path.join(dir, name) }));
}

/** The app's own @every-app/sdk version, when it has one installed. */
function appSdkVersion(cwd: string): string | null {
  try {
    const require = createRequire(path.join(cwd, "package.json"));
    return (require("@every-app/sdk/package.json") as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

async function file(name: string, at: string): Promise<File> {
  return new File([await fs.readFile(at)], path.basename(name));
}

/** The upload of the app built in `cwd`. */
export async function packageHostedBundle(
  cwd: string,
  manifest: EveryAppCliManifest,
): Promise<{ form: FormData; modules: number; assets: number; migrations: number }> {
  const workerDir = path.join(cwd, WORKER_DIR);
  const configText = await fs.readFile(path.join(workerDir, "worker.config.json"), "utf8");
  const config = JSON.parse(configText) as {
    manifest?: { modules?: Record<string, { type?: string }> };
  };
  const declared = config.manifest?.modules ?? {};
  const form = new FormData();
  form.set(HOSTED_DEPLOY_PARTS.manifest, JSON.stringify(manifest));
  form.set(
    HOSTED_DEPLOY_PARTS.stamp,
    JSON.stringify({
      protocol: HOSTED_DEPLOY_PROTOCOL,
      sdkVersion: appSdkVersion(cwd),
      cliVersion,
    }),
  );
  form.set(HOSTED_DEPLOY_PARTS.worker, configText);

  const bundleDir = path.join(workerDir, "bundle");
  let modules = 0;
  for (const name of await filesUnder(bundleDir)) {
    // What cf wouldn't upload as a module, the gateway wouldn't either.
    if (!bundleModuleType(name, declared[name]?.type)) continue;
    form.set(`${HOSTED_DEPLOY_PARTS.modulePrefix}${name}`, await file(name, path.join(bundleDir, name)));
    modules += 1;
  }
  const assetsDir = path.join(workerDir, "assets");
  const assets = await filesUnder(assetsDir);
  for (const name of assets) {
    form.set(`${HOSTED_DEPLOY_PARTS.assetPrefix}/${name}`, await file(name, path.join(assetsDir, name)));
  }
  const migrations = await migrationFiles(cwd, manifest);
  for (const migration of migrations) {
    form.set(`${HOSTED_DEPLOY_PARTS.migrationPrefix}${migration.name}`, await file(migration.name, migration.file));
  }
  return { form, modules, assets: assets.length, migrations: migrations.length };
}
