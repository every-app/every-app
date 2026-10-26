import fs from "node:fs/promises";
import path from "node:path";
import { publishedRange } from "@/lib/app/publishedVersions";
import { isInCheckout } from "@/lib/checkout";

/** Where the published packages live in the checkout, for `EVERYAPP_CREATE_LINK`. */
const CHECKOUT_PACKAGES: Readonly<Record<string, string>> = {
  "@every-app/sdk": "packages/sdk",
  everyapp: "packages/cli",
};

interface UpdatePackageJsonOptions {
  targetDir: string;
  /** The unprefixed app ID (e.g., "my-app") */
  appId: string;
}

/**
 * Name the copied template's package.json after the app. The template
 * takes the SDK and the CLI from this workspace (`workspace:*`), which
 * pnpm links inside the checkout: an app in the checkout's apps/ keeps
 * them, so it runs on the checkout's own SDK and CLI. An app made
 * anywhere else, by a checkout's everyapp or one installed from npm, is
 * its own repository and takes both from npm at the published range
 * (lib/app/publishedVersions.ts); its install writes the lockfile its
 * first commit records.
 *
 * `EVERYAPP_CREATE_LINK=1`, from a checkout, links the checkout's
 * packages by path instead: for testing this commit's SDK and CLI in a
 * standalone app before they are published (the built-CLI test in CI).
 */
export async function updatePackageJson({
  targetDir,
  appId,
  root,
  env = process.env,
}: UpdatePackageJsonOptions & {
  /** The checkout everyapp runs from; null from an installed package. */
  root: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const packageJsonPath = path.join(targetDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));

  packageJson.name = appId;

  if (!isInCheckout(targetDir, root)) {
    // Real paths both ends: pnpm resolves link: from where the app really is.
    const linkFrom =
      root !== null && env["EVERYAPP_CREATE_LINK"] === "1"
        ? { root: await fs.realpath(root), app: await fs.realpath(targetDir) }
        : null;
    for (const section of ["dependencies", "devDependencies"] as const) {
      const deps = packageJson[section];
      if (!deps) continue;
      for (const [depName, spec] of Object.entries(deps)) {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
        const linked = linkFrom && CHECKOUT_PACKAGES[depName];
        if (linkFrom && linked) {
          const dir = path.join(linkFrom.root, linked);
          deps[depName] = `link:${path.relative(linkFrom.app, dir).split(path.sep).join("/")}`;
          continue;
        }
        const range = publishedRange(depName);
        if (!range) {
          throw new Error(
            `Template dependency "${depName}" is a workspace package ("${spec}") that isn't published to npm.`,
          );
        }
        deps[depName] = range;
      }
    }
  }

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * The app's display name from its id: each dash-separated word with its
 * first letter capitalized ("my-app" is "My App", "crm2" is "Crm2"). What
 * the dev launcher and the Gateway's app library show until the manifest
 * says otherwise.
 */
export function appNameFor(appId: string): string {
  return appId
    .split("-")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Name the copied template's everyapp.config.ts after the app: its `id`,
 * and its `name` as `appNameFor` spells it. The template's description
 * stays: it describes the app until its author changes it.
 */
export async function updateEveryappManifest({
  targetDir,
  appId,
}: UpdatePackageJsonOptions): Promise<void> {
  const manifestPath = path.join(targetDir, "everyapp.config.ts");
  try {
    const manifest = await fs.readFile(manifestPath, "utf-8");
    const withId = manifest.replace(/(\bid\s*:\s*)["'][^"']+["']/, `$1"${appId}"`);
    if (withId === manifest) {
      throw new Error("Could not find an id field in everyapp.config.ts");
    }
    const withName = withId.replace(
      /(\bname\s*:\s*)["'][^"']+["']/,
      `$1"${appNameFor(appId)}"`,
    );
    if (withName === withId) {
      throw new Error("Could not find a name field in everyapp.config.ts");
    }
    await fs.writeFile(manifestPath, withName, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "Starter template does not include everyapp.config.ts, which is required for deployments.",
      );
    }
    throw error;
  }
}

/**
 * Title the copied template's README.md after the app: its first H1
 * becomes the app's name. A template without a README, or with no H1 in
 * it, is left alone; the app runs and deploys without one.
 */
export async function updateReadme({
  targetDir,
  appId,
}: UpdatePackageJsonOptions): Promise<void> {
  const readmePath = path.join(targetDir, "README.md");
  let readme: string;
  try {
    readme = await fs.readFile(readmePath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const titled = readme.replace(/^# .*$/m, `# ${appNameFor(appId)}`);
  if (titled !== readme) await fs.writeFile(readmePath, titled, "utf-8");
}
