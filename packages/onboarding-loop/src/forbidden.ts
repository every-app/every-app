/**
 * The accounts the loop never touches, from the same configuration the
 * CLI's teardown reads (packages/cli/src/lib/teardown/guards.ts): the
 * variable `EVERYAPP_FORBIDDEN_ACCOUNTS` (ids separated by commas or
 * whitespace) and the file `~/.config/everyapp/forbidden-accounts`
 * (`$XDG_CONFIG_HOME` honoured; one id per line, `#` starts a comment),
 * together. No id ships in the code: the machine that can reach a live
 * account lists it there. Anything that isn't 32 hex characters is skipped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FORBIDDEN_VARIABLE = "EVERYAPP_FORBIDDEN_ACCOUNTS";

/** `$XDG_CONFIG_HOME/everyapp/forbidden-accounts`, else `~/.config/everyapp/forbidden-accounts`. */
export function forbiddenAccountsPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configHome = env["XDG_CONFIG_HOME"] || path.join(home, ".config");
  return path.join(configHome, "everyapp", "forbidden-accounts");
}

function parseIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const entry of line.replace(/#.*$/, "").split(/[\s,]+/)) {
      const id = entry.toLowerCase();
      if (/^[0-9a-f]{32}$/.test(id)) ids.push(id);
    }
  }
  return ids;
}

/** The variable's and the file's ids, each once (a missing file is an empty list). */
export function forbiddenAccountIds(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  let fromFile = "";
  try {
    fromFile = fs.readFileSync(forbiddenAccountsPath(env, home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [
    ...new Set([
      ...parseIds(env[FORBIDDEN_VARIABLE] ?? ""),
      ...parseIds(fromFile),
    ]),
  ];
}
