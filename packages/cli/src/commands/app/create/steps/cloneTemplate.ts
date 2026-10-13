import path from "node:path";
import chalk from "chalk";
import { copyTemplateFiles, starterTemplateDir } from "@/lib/app/starter";
import { cloneRepository } from "@/lib/git";
import { directoryExists, createTempDirectory } from "@/lib/file-operations";

const EVERY_APP_REPO = "https://github.com/every-app/every-app.git";
const TEMPLATE_RELATIVE_PATH = "templates/simple-todo";

interface CloneTemplateOptions {
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
  verbose?: boolean;
}

interface CloneTemplateResult {
  /** The clone to remove afterwards; null when the bundled template was used. */
  tempDir: string | null;
  targetDir: string;
}

/**
 * Copy the starter template to the target directory: the one bundled with
 * this CLI, or (a CLI built without it) the repository's, cloned.
 */
export async function cloneTemplate({
  appId,
  verbose = false,
}: CloneTemplateOptions): Promise<CloneTemplateResult> {
  const targetDir = path.join(process.cwd(), appId);
  if (await directoryExists(targetDir)) {
    throw new Error(
      `Directory "${appId}" already exists in the current location`,
    );
  }

  const bundled = starterTemplateDir();
  let tempDir: string | null = null;
  let templatePath: string;
  if (bundled) {
    templatePath = bundled;
  } else {
    if (verbose) {
      console.log("Cloning template repository...\n");
    }
    tempDir = await createTempDirectory("every-app-create-");
    await cloneRepository({ url: EVERY_APP_REPO, targetDir: tempDir, verbose });
    templatePath = path.join(tempDir, TEMPLATE_RELATIVE_PATH);
  }

  await copyTemplateFiles(templatePath, targetDir);

  if (verbose) {
    console.log(chalk.dim(`  Template copied to ${targetDir}\n`));
  }

  return { tempDir, targetDir };
}
