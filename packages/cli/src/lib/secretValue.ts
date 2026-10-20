import { EveryAppError } from "@/lib/errors";
import { thisCommand } from "@/lib/output/command";
import { askSecret, canPromptInTerminal } from "@/lib/output/prompt";

/**
 * A secret's value from `--from-env <VAR>`, or a hidden prompt at a
 * terminal: never from the command line, where it would land in shell
 * history and the process list.
 */
export async function readSecretValue(
  name: string,
  options: { fromEnv?: string; json?: boolean },
): Promise<string> {
  const variable = options.fromEnv;
  if (variable) {
    const value = process.env[variable];
    if (!value) {
      throw new EveryAppError("SECRET_EMPTY", `${variable} is empty or unset in this environment`, {
        fix: `set ${variable} to ${name}'s value, then run this again`,
      });
    }
    return value;
  }
  if (!canPromptInTerminal(options.json ?? false)) {
    throw new EveryAppError("SECRET_VALUE_REQUIRED", `No terminal to ask for ${name}'s value`, {
      rerun: `${thisCommand()} --from-env ${name}`,
    });
  }
  return (await askSecret(`Value for ${name}`)).trim();
}
