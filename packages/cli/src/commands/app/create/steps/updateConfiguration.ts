import fs from "node:fs/promises";
import path from "node:path";
import { isInCheckout } from "@/lib/checkout";

interface UpdatePackageJsonOptions {
  targetDir: string;
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
}

/**
 * Name the copied template's package.json after the app. The template
 * takes the SDK and the CLI from this workspace (`workspace:*`), which
 * pnpm links inside the checkout. An app created anywhere else links
 * those packages from the checkout by path instead: nothing is published
 * while we work from the repository.
 */
export async function updatePackageJson({
  targetDir,
  appId,
  root,
}: UpdatePackageJsonOptions & {
  /** The checkout the workspace packages come from. */
  root: string;
}): Promise<void> {
  const packageJsonPath = path.join(targetDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));

  packageJson.name = appId;

  if (!isInCheckout(targetDir, root)) {
    // Real paths both ends: pnpm resolves link: from where the app really is.
    const packages = await workspacePackages(await fs.realpath(root));
    const from = await fs.realpath(targetDir);
    for (const section of ["dependencies", "devDependencies"] as const) {
      const deps = packageJson[section];
      if (!deps) continue;
      for (const [depName, spec] of Object.entries(deps)) {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
        const packageDir = packages.get(depName);
        if (!packageDir) {
          throw new Error(
            `Template dependency "${depName}" is a workspace package ("${spec}") that isn't in ${path.join(root, "packages")}.`,
          );
        }
        deps[depName] = `link:${path.relative(from, packageDir).split(path.sep).join("/")}`;
      }
    }
  }

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf-8",
  );
}

/** The checkout's packages/*, by package name. */
async function workspacePackages(root: string): Promise<Map<string, string>> {
  const packages = new Map<string, string>();
  const packagesDir = path.join(root, "packages");
  for (const entry of await fs.readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    try {
      const { name } = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
      if (typeof name === "string") packages.set(name, dir);
    } catch {
      // Not a package.
    }
  }
  return packages;
}

export async function updateEveryappManifestId({
  targetDir,
  appId,
}: UpdatePackageJsonOptions): Promise<void> {
  const manifestPath = path.join(targetDir, "everyapp.config.ts");
  try {
    const manifest = await fs.readFile(manifestPath, "utf-8");
    const updated = manifest.replace(
      /(\bid\s*:\s*)["'][^"']+["']/,
      `$1"${appId}"`,
    );
    if (updated === manifest) {
      throw new Error("Could not find an id field in everyapp.config.ts");
    }
    await fs.writeFile(manifestPath, updated, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "Starter template does not include everyapp.config.ts, which is required for deployments.",
      );
    }
    throw error;
  }
}
