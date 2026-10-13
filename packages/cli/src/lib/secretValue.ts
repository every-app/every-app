import enquirer from "enquirer";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { EveryAppError } from "@/lib/errors";

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
      throw new EveryAppError(
        "SECRET_EMPTY",
        `${variable} is empty or unset in this environment.`,
      );
    }
    return value;
  }
  if (!canPromptInTerminal(options.json ?? false)) {
    throw new EveryAppError(
      "SECRET_VALUE_REQUIRED",
      `Pass the value through an environment variable: --from-env <VAR>.`,
    );
  }
  const { value } = await enquirer.prompt<{ value: string }>({
    type: "password",
    name: "value",
    message: `${name}`,
    validate: (input: string) => (input.trim() ? true : "Enter a value"),
  });
  return value.trim();
}
