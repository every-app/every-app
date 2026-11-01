/**
 * Setting a provider's key or OAuth client in the run that adds it, so
 * `provider add` is one step: `secret set`'s own path (its routing, the
 * line saying where a registered row's key goes, one Gateway version, the
 * row bound to its hosts), fed from values given without a prompt
 * (`--client-id`, piped `NAME=value` lines, `--from-env`) or asked for at
 * the terminal. Unattended, or when the person presses Enter on nothing,
 * nothing is set and the command names `secret set` as the next step.
 */
import fs from "node:fs";
import { text as readAll } from "node:stream/consumers";
import { isPlainGatewaySetting } from "@every-app/sdk/internal";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { listed } from "@/lib/output/text";
import { askSettingValue, checkedPlainValue } from "@/lib/secretValue";
import type { GatewayCommandFlags } from "../flags";
import { parsePipedLines } from "../configure";
import { applySecretValues } from "../secret";

/** The flags `provider add` sets a key or client from. */
export interface CredentialFlags {
  /** OAuth only: the client id (public). */
  "client-id"?: string;
  /** Read each setting from the environment variable of its name; stdin isn't read. */
  "from-env"?: boolean;
}

/** The seams tests answer through, and the defaults a run uses. */
export interface CredentialSeams {
  /** What was piped in, or null when nothing was (default: stdin when it isn't a terminal). */
  readStdin?: () => Promise<string | null>;
  /** The environment --from-env reads (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** A person is at the terminal to answer (default: canPromptInTerminal). */
  interactive?: boolean;
  /** Ask for one setting's value; "" is Enter on nothing (default: askSettingValue). */
  ask?: (name: string, question: string) => Promise<string>;
}

/** "Google" for "Google (Gmail, Calendar, Search Console and Analytics)": a label without its trailing aside. */
export function shortName(label: string): string {
  return label.replace(/\s*\([^()]*\)$/, "") || label;
}

/**
 * What was piped in, or null at a terminal or when nothing was. Only a
 * pipe or a file is read: a run with stdin left open some other way (a
 * socket, as some agent harnesses hand over) isn't held waiting for it.
 */
async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(0);
  } catch {
    return null;
  }
  if (!stat.isFIFO() && !stat.isFile()) return null;
  const piped = await readAll(process.stdin);
  return piped.trim() ? piped : null;
}

/**
 * The values given without a prompt: piped `NAME=value` lines for any of
 * `settings`, with `--from-env` the variables of their names, and
 * `--client-id` for `clientIdName`. A name that isn't one of `settings` is
 * refused without being echoed; a plain setting's value is checked as
 * `secret set` checks it. Empty when nothing was given.
 */
export async function givenValues(
  settings: readonly string[],
  whose: string,
  flags: CredentialFlags,
  seams: CredentialSeams,
  clientIdName?: string,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const piped = flags["from-env"] ? null : await (seams.readStdin ?? readPipedStdin)();
  if (piped !== null) {
    for (const { name, value, line } of parsePipedLines(piped)) {
      if (!settings.includes(name)) {
        const shown = /^[A-Z][A-Z0-9_]*$/.test(name) ? name : `line ${line} (not shown: it may be a value)`;
        throw new EveryAppError(
          "SECRET_NOT_DECLARED",
          `${whose} isn't ${shown}\nThe piped lines set ${listed([...settings])}. Nothing was set.`,
          { fix: `pipe ${settings.join(" and ")} as NAME=value lines` },
        );
      }
      if (!value.trim()) {
        throw new EveryAppError("SECRET_EMPTY", `${name} is empty in the piped input\nNothing was set.`, {
          fix: "give it a value, or leave the line out",
        });
      }
      values[name] = value;
    }
  }
  if (flags["from-env"]) {
    const env = seams.env ?? process.env;
    for (const name of settings) {
      const value = env[name];
      if (value?.trim() && !(name in values)) values[name] = value;
    }
  }
  const clientId = flags["client-id"]?.trim();
  if (clientId && clientIdName) values[clientIdName] = clientId;
  for (const name of Object.keys(values)) {
    if (isPlainGatewaySetting(name)) values[name] = checkedPlainValue(name, values[name]!);
  }
  return values;
}

/** Enter on nothing at a prompt: nothing is set. */
class Skipped extends Error {}

/** What became of the settings: set in this run, or left for `secret set`. */
type CredentialOutcome = "set" | "skipped";

/**
 * Set the provider's settings in this run: the `given` ones (with every
 * `needed` one among them, else PROVIDER_CLIENT_INCOMPLETE and nothing
 * set), or else, with a person at the terminal, each `needed` one asked
 * for. Enter on nothing, or nobody to ask: nothing set ("skipped").
 */
export async function setProviderSettings(options: {
  flags: GatewayCommandFlags;
  out: EventSink;
  createCf?: (accountId?: string) => CfRunner;
  /** "GitHub's client", "OpenRouter's key": the refusal's subject. */
  whose: string;
  /** Completes the refusal's "Nothing was set; …": "the provider is registered". */
  standing: string;
  /** Every setting the provider reads, in order. */
  settings: readonly string[];
  /** The ones not set yet, which a prompt asks for. */
  needed: readonly string[];
  given: Readonly<Record<string, string>>;
  interactive: boolean;
  ask?: CredentialSeams["ask"];
  /** The prompt's question for a setting (default: its name). */
  questionOf?: (name: string) => string;
}): Promise<CredentialOutcome> {
  const { given, needed, settings } = options;
  const apply = (names: string[], readValue: (name: string) => Promise<string>) =>
    applySecretValues({
      flags: { ...options.flags },
      out: options.out,
      names,
      readValue,
      ...(options.createCf ? { createCf: options.createCf } : {}),
    });
  if (Object.keys(given).length > 0) {
    const missing = needed.filter((name) => !(name in given));
    if (missing.length > 0) {
      throw new EveryAppError(
        "PROVIDER_CLIENT_INCOMPLETE",
        `${options.whose} needs ${listed(missing)} too\nNothing was set; ${options.standing}.`,
        {
          fix: `pipe ${missing.join(" and ")} as NAME=value lines, export ${missing.length === 1 ? "it" : "them"} and add --from-env, or run ${CLI} secret set ${needed.join(" ")}`,
        },
      );
    }
    await apply(
      settings.filter((name) => name in given),
      async (name) => given[name]!,
    );
    return "set";
  }
  if (needed.length === 0 || !options.interactive) return "skipped";
  const ask = options.ask ?? ((name: string, question: string) => askSettingValue(name, { question, optional: true }));
  try {
    // Asked inside secret set's path, so a registered row's line saying where its key goes comes first.
    await apply([...needed], async (name) => {
      const value = (await ask(name, options.questionOf?.(name) ?? name)).trim();
      if (!value) throw new Skipped();
      return value;
    });
    return "set";
  } catch (error) {
    if (error instanceof Skipped) return "skipped";
    throw error;
  }
}
