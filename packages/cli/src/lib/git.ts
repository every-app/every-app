import { executeCommandWithFormatting } from "./formatting";

interface InitRepositoryOptions {
  targetDir: string;
  verbose?: boolean;
}

/**
 * Initialize a git repository and create an initial commit
 */
export async function initRepository({
  targetDir,
  verbose = false,
}: InitRepositoryOptions): Promise<void> {
  try {
    // Initialize git repository
    await executeCommandWithFormatting("git", ["init"], {
      verbose,
      logCommandToConsole: false,
      cwd: targetDir,
    });

    // Stage all files
    await executeCommandWithFormatting("git", ["add", "."], {
      verbose,
      logCommandToConsole: false,
      cwd: targetDir,
    });

    // Create initial commit
    await executeCommandWithFormatting(
      "git",
      ["commit", "-m", "Starter template"],
      {
        verbose,
        logCommandToConsole: false,
        cwd: targetDir,
      },
    );
  } catch (error) {
    throw new Error(
      `Failed to initialize git repository: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
