import { execa } from "execa";
import chalk from "chalk";
interface ExecuteCommandWithFormattingOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  verbose?: boolean;
  description?: string;
  logCommandToConsole?: boolean;
  shell?: boolean;
}
/**
 * Wraps execa call to show formatted output for shell commands
 */
export async function executeCommandWithFormatting(
  command: string,
  args: string[],
  options: ExecuteCommandWithFormattingOptions,
) {
  const {
    env,
    cwd,
    verbose = false,
    description,
    logCommandToConsole = true,
  } = options;

  if (verbose) {
    return execVerboseCommand(command, args, options);
  }

  if (!logCommandToConsole) {
    // Silent mode: don't show any logs
    const result = await execa(command, args, {
      cwd,
      env,
      shell: options.shell,
      stdio: "pipe", // Suppress output
    });

    return result;
  }

  // Non-verbose mode: just show the command being run
  console.log(`Running: ${formatCommand(command, args)}`);
  if (description) {
    console.log(chalk.dim(`  ${description}`));
  }

  const result = await execa(command, args, {
    cwd,
    env,
    shell: options.shell,
    stdio: "pipe", // Suppress output
  });

  return result;
}

async function execVerboseCommand(
  command: string,
  args: string[],
  { description, cwd, env, shell }: ExecuteCommandWithFormattingOptions,
) {
  console.log(chalk.dim(`  ┌─ Running: ${formatCommand(command, args)}`));
  if (description) {
    console.log(chalk.dim(`  │ ${description}`));
  }

  const subprocess = execa(command, args, {
    cwd,
    env,
    shell,
    stdio: undefined,
    all: true,
  });

  // Stream and indent output in real-time
  if (subprocess.stdout) {
    subprocess.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      lines.forEach((line) => {
        if (line.trim()) console.log(chalk.dim(`  │ ${line}`));
      });
    });
  }

  if (subprocess.stderr) {
    subprocess.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      lines.forEach((line) => {
        if (line.trim()) console.error(chalk.dim(`  │ ${line}`));
      });
    });
  }

  const result = await subprocess;
  console.log(chalk.dim(`  └─ Complete\n`));
  return result;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}
