import fs from "node:fs/promises";
import path from "node:path";

interface UpdatePackageJsonOptions {
  targetDir: string;
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
}

/**
 * Update package.json with app ID
 */
export async function updatePackageJson({
  targetDir,
  appId,
}: UpdatePackageJsonOptions): Promise<void> {
  const packageJsonPath = path.join(targetDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));

  packageJson.name = appId;

  // A scaffolded app lives outside this workspace, where workspace: specs
  // cannot install. Keep this guard so new template dependencies stay portable.
  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps = packageJson[section];
    if (!deps) continue;
    for (const [depName, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      throw new Error(
        `Template dependency "${depName}" uses an unresolvable workspace spec ("${spec}"). Pin it to a published version in the template.`,
      );
    }
  }

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf-8",
  );
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
