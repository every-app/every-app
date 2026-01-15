import type { LocalContext } from "@/context";
import chalk from "chalk";
import { execa } from "execa";
import { getRemoteD1Env } from "@/lib/remote-d1";
import { requireCloudflareAuth } from "@/lib/cloudflare";

/**
 * Remote D1 shell command implementation
 * Sets environment variables needed for connecting to D1 and runs a command
 */
export async function remoteD1Shell(
  this: LocalContext,
  _flags: Record<string, never>,
  ...command: string[]
): Promise<void> {
  await requireCloudflareAuth();

  const cwd = process.cwd();

  try {
    // Validate that a command was provided
    if (!command || command.length === 0) {
      throw new Error(
        "No command provided. Usage: npx everyapp app remote-d1-shell -- <command>\nExample: npx everyapp app remote-d1-shell -- npx drizzle-kit migrate",
      );
    }

    const [cmd, ...cmdArgs] = command;
    if (!cmd) {
      throw new Error("Invalid command");
    }

    console.log("Retrieving shell info from Cloudflare...");
    const d1Env = await getRemoteD1Env(cwd);

    // Run the command with environment variables
    console.log(
      chalk.bold(`\nRunning: ${chalk.cyan([cmd, ...cmdArgs].join(" "))}\n`),
    );

    await execa(cmd, cmdArgs, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        ...d1Env,
      },
    });

    console.log("\nCommand executed!");
  } catch (error) {
    console.error(
      chalk.red("\nFailed to execute command:"),
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}
