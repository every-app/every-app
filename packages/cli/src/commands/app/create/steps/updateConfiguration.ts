import fs from "node:fs/promises";
import path from "node:path";

/**
 * Update package.json with app ID
 */
export async function updatePackageJson(
  targetDir: string,
  appId: string,
): Promise<void> {
  const packageJsonPath = path.join(targetDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));

  packageJson.name = appId;

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf-8",
  );
}
