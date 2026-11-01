import { runLogged } from "./childLog";

interface InitRepositoryOptions {
  targetDir: string;
  /** Stream git's output to stderr too. */
  verbose?: boolean;
}

/**
 * Initialize a git repository and create an initial commit
 */
export async function initRepository({
  targetDir,
  verbose = false,
}: InitRepositoryOptions): Promise<void> {
  const git = (args: string[]) =>
    runLogged("git", args, {
      cwd: targetDir,
      echo: verbose,
      what: "Initializing the app's git repository",
      code: "GIT_FAILED",
    });
  await git(["init"]);
  await git(["add", "."]);
  await git(["commit", "-m", "Starter template"]);
}
