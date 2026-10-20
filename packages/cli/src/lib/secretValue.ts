import { text } from "node:stream/consumers";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { askSecret, canPromptInTerminal } from "@/lib/output/prompt";

/** Where `secret set` reads its values: never the command line. */
enum SecretSource {
  /** `--from-env <VAR>`. */
  Env = "env",
  /** Piped in: stdin isn't a terminal. */
  Stdin = "stdin",
  /** A hidden prompt at the terminal. */
  Prompt = "prompt",
}

/** Where the values come from: --from-env, else stdin when it isn't a terminal, else a prompt. */
function secretSource(fromEnv: string | undefined): SecretSource {
  if (fromEnv) return SecretSource.Env;
  return process.stdin.isTTY ? SecretSource.Prompt : SecretSource.Stdin;
}

/**
 * Refuse more than one name for a source that holds one value
 * (--from-env, stdin), before anything else is checked.
 */
export function assertOneValueEnough(names: readonly string[], fromEnv: string | undefined): void {
  const source = secretSource(fromEnv);
  if (source === SecretSource.Prompt || names.length < 2) return;
  throw new EveryAppError(
    "SECRET_SEVERAL_NAMES",
    `${source === SecretSource.Env ? "--from-env" : "A piped value"} sets one secret at a time, and you named ${names.length}`,
    {
      fix: `run it once per name, e.g. ${
        source === SecretSource.Env
          ? `${CLI} secret set ${names[0]} --from-env ${fromEnv}`
          : `echo "$${names[0]}" | ${CLI} secret set ${names[0]}`
      }`,
    },
  );
}

/**
 * A secret's value from `--from-env <VAR>`, stdin when something is piped
 * in, or a hidden prompt at a terminal: never from the command line, where
 * it would land in shell history and the process list.
 */
export async function readSecretValue(
  name: string,
  options: { fromEnv?: string; json?: boolean },
): Promise<string> {
  const variable = options.fromEnv;
  const source = secretSource(variable);
  if (source === SecretSource.Env) {
    const value = process.env[variable!];
    if (!value) {
      throw new EveryAppError("SECRET_EMPTY", `$${variable} is empty or not set`, {
        fix: `export ${variable} first, or name another variable with --from-env`,
      });
    }
    return value;
  }
  if (source === SecretSource.Stdin) {
    // One value, its trailing newline (echo's) dropped.
    const value = (await text(process.stdin)).replace(/\r?\n$/, "");
    if (value) return value;
  }
  if (source === SecretSource.Stdin || !canPromptInTerminal(options.json ?? false)) {
    throw new EveryAppError(
      "SECRET_VALUE_REQUIRED",
      `Can't ask for ${name}'s value without a terminal\nOr pipe it in: echo "$${name}" | ${CLI} secret set ${name}`,
      { rerun: `${CLI} secret set ${name} --from-env ${name}` },
    );
  }
  return (await askSecret(`Value for ${name}`)).trim();
}
