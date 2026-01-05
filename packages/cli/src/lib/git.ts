import { executeCommandWithFormatting } from "./formatting";

interface CloneRepositoryOptions {
  url: string;
  targetDir: string;
  verbose?: boolean;
}

/**
 * Clone a git repository to a target directory
 */
export async function cloneRepository({
  url,
  targetDir,
  verbose = false,
}: CloneRepositoryOptions): Promise<void> {
  try {
    await executeCommandWithFormatting("git", ["clone", url, targetDir], {
      verbose,
      logCommandToConsole: false,
    });
  } catch (error) {
    throw new Error(
      `Failed to clone repository from ${url}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
