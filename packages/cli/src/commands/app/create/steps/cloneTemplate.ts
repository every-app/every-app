import path from "node:path";
import chalk from "chalk";
import { cloneRepository } from "@/lib/git";
import {
  copyDirectory,
  directoryExists,
  createTempDirectory,
} from "@/lib/file-operations";

const EVERY_APP_REPO = "https://github.com/every-app/every-app.git";
const TEMPLATE_RELATIVE_PATH = "templates/simple-todo";

interface CloneTemplateOptions {
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
  verbose?: boolean;
}

interface CloneTemplateResult {
  tempDir: string;
  targetDir: string;
}

/**
 * Clone the template repository and copy it to the target directory
 */
export async function cloneTemplate({
  appId,
  verbose = false,
}: CloneTemplateOptions): Promise<CloneTemplateResult> {
  if (verbose) {
    console.log("Cloning template repository...\n");
  }

  const tempDir = await createTempDirectory("every-app-create-");
  await cloneRepository({ url: EVERY_APP_REPO, targetDir: tempDir, verbose });

  if (verbose) {
    console.log("Extracting template...\n");
  }

  const templatePath = path.join(tempDir, TEMPLATE_RELATIVE_PATH);
  const targetDir = path.join(process.cwd(), appId);

  if (await directoryExists(targetDir)) {
    throw new Error(
      `Directory "${appId}" already exists in the current location`,
    );
  }

  await copyDirectory(templatePath, targetDir, {
    exclude: [
      "node_modules",
      ".git",
      "pnpm-lock.yaml",
      "package-lock.json",
      ".env.local",
      ".env.production",
      ".dev.vars",
      "manual-steps.md",
    ],
  });

  if (verbose) {
    console.log(chalk.dim(`  Template copied to ${targetDir}\n`));
  }

  return { tempDir, targetDir };
}
