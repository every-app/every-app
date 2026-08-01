import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

interface LocalPackageBin {
  command: string;
  argsPrefix: string[];
}

interface PackageJsonWithBin {
  bin?: string | Record<string, string>;
}

export async function resolveLocalPackageBin(
  projectRoot: string,
  packageName: string,
  binName: string,
): Promise<LocalPackageBin> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const command = resolveNodeCommand();

  try {
    const packageJsonPath = await findPackageJsonPath(
      resolvedProjectRoot,
      packageName,
    );
    const packageJson = JSON.parse(
      await fs.readFile(packageJsonPath, "utf-8"),
    ) as PackageJsonWithBin;
    const relativeBinPath =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.[binName];

    if (!relativeBinPath) {
      throw new Error(`Package does not declare the "${binName}" binary.`);
    }

    return {
      command,
      argsPrefix: [
        path.resolve(path.dirname(packageJsonPath), relativeBinPath),
      ],
    };
  } catch (error) {
    throw new Error(
      `Could not resolve the project-local "${binName}" binary from project root "${resolvedProjectRoot}". Install the project's declared ${packageName} dependency and try again. (If the install skipped devDependencies, include them; Yarn Plug'n'Play projects are not supported — use nodeLinker: node-modules.)`,
      { cause: error },
    );
  }
}

function resolveNodeCommand(): string {
  if (!process.versions["bun"]) {
    return process.execPath;
  }

  try {
    execFileSync("node", ["--version"], { stdio: "ignore" });
    return "node";
  } catch {
    throw new Error(
      "Every App CLI must run project binaries under Node.js because Wrangler deploys silently no-op under Bun. Install Node.js and ensure `node` is available on PATH.",
    );
  }
}

/**
 * Locate a dependency's package.json by walking node_modules up from the
 * project root.
 *
 * Deliberately not `require.resolve("<pkg>/package.json")`: a package whose
 * `exports` map omits "./package.json" makes that throw
 * ERR_PACKAGE_PATH_NOT_EXPORTED even though the file is right there —
 * drizzle-kit is one, so every drizzle app hit it. Falls back to module
 * resolution for layouts where the package isn't under an ancestor's
 * node_modules.
 */
async function findPackageJsonPath(
  projectRoot: string,
  packageName: string,
): Promise<string> {
  let dir = projectRoot;
  for (;;) {
    const candidate = path.join(
      dir,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    );
    try {
      return await fs.realpath(candidate);
    } catch {
      // Not at this level; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  return projectRequire.resolve(`${packageName}/package.json`);
}
