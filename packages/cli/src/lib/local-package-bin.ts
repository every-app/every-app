import fs from "node:fs/promises";
import path from "node:path";

interface LocalPackage {
  version: string;
  /** Absolute path of the package's `binName` script. */
  binPath: string;
}

interface PackageJsonWithBin {
  version?: string;
  bin?: string | Record<string, string>;
}

/** Find an installed package's version and binary from a project root. */
export async function resolveLocalPackage(
  projectRoot: string,
  packageName: string,
  binName: string,
): Promise<LocalPackage> {
  const resolvedProjectRoot = path.resolve(projectRoot);

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
      version: packageJson.version ?? "unknown",
      binPath: path.resolve(path.dirname(packageJsonPath), relativeBinPath),
    };
  } catch (error) {
    throw new Error(
      `Could not resolve the project-local "${binName}" binary from project root "${resolvedProjectRoot}". Install the project's declared ${packageName} dependency and try again. (If the install skipped devDependencies, include them; Yarn Plug'n'Play projects are not supported — use nodeLinker: node-modules.)`,
      { cause: error },
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
 * drizzle-kit is one, so every drizzle app hit it. And deliberately not
 * Node's global folders (NODE_PATH, `~/.node_modules`): the walk already
 * covers every ancestor's node_modules, and a binary found only through
 * NODE_PATH is not the project's (pnpm's command shims set NODE_PATH to the
 * workspace's hoisted store, which has the gateway's cf in it).
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
  throw new Error(
    `${packageName} is not installed under ${projectRoot} or any directory above it.`,
  );
}
