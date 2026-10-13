let requested: number | undefined;

/**
 * Exit with `code` once the command returns. Stricli's `run()` resets
 * process.exitCode to its own result after every command, so a command's
 * own `process.exitCode = 1` would be lost; bin/cli.ts re-applies this.
 */
export function setExitCode(code: number): void {
  requested = code;
  process.exitCode = code;
}

export function requestedExitCode(): number | undefined {
  return requested;
}
