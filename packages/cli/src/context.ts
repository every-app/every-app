import type { CommandContext } from "@stricli/core";

/**
 * What stricli's `run` needs from everyapp: the process it writes help
 * through. No command reads it (they take `flags` and positionals only).
 */
export function buildContext(process: NodeJS.Process): CommandContext {
  return { process };
}
