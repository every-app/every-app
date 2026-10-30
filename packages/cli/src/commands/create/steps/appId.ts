import os from "node:os";
import path from "node:path";
import {
  GATEWAY_WORKER_NAME,
  isReservedAppId,
  isReservedName,
  workerNameFor,
} from "@every-app/perimeter/manifest";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { askText } from "@/lib/output/prompt";

const KEBAB_CASE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

/** What the prompt offers when Enter is pressed on nothing. */
const DEFAULT_NAME = "my-app";

/** What is wrong with a name: the headline, and how to fix it. */
interface NameProblem {
  headline: string;
  fix: string;
  /** A well-formed name the platform keeps. */
  reserved?: boolean;
}

/** Why `input` can't name an app, or null when it can. */
function nameProblem(input: string): NameProblem | null {
  const invalid = `"${input}" isn't a valid app name`;
  if (input.length > 64) return { headline: invalid, fix: "use 64 characters or fewer" };
  // "--" separates an app's Worker name from its resources' names.
  if (input.includes("--")) {
    return {
      headline: invalid,
      fix: `don't put two dashes in a row, e.g. ${input.replace(/-{2,}/g, "-")}`,
    };
  }
  if (!KEBAB_CASE.test(input)) {
    const slug = slugify(input);
    return {
      headline: invalid,
      fix: `use lowercase letters, digits and dashes${slug ? `, e.g. ${slug}` : ", starting with a letter"}`,
    };
  }
  // No app is `app-gateway` on any Gateway, nor anything whose Worker would
  // start with `every-app-gateway-`: those are the Gateways' own names.
  if (
    isReservedAppId(input) ||
    workerNameFor(input) === GATEWAY_WORKER_NAME ||
    isReservedName(workerNameFor(input))
  ) {
    return { headline: `"${input}" is reserved for the platform`, fix: "pick another name", reserved: true };
  }
  return null;
}

/** `input` made into a name, when it can be ("Analytics_App" → "analytics-app"). */
function slugify(input: string): string | null {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "");
  return slug && slug.length <= 64 && KEBAB_CASE.test(slug) ? slug : null;
}

/** Where the new app goes, and what it is called. */
interface AppTarget {
  appId: string;
  /**
   * The directory a path argument named, resolved; null for a bare name
   * (then `newAppDir` in lib/app/starter.ts decides).
   */
  dir: string | null;
  /**
   * The path was given from the root or from `~`: messages show it whole,
   * not relative to the current directory.
   */
  absolute: boolean;
}

/**
 * Whether `given` names a directory rather than an app: it has a slash (POSIX
 * or Windows), or starts with `.`, `~` or `/`. A name has none of these.
 */
export function isPathArgument(given: string): boolean {
  return (
    given.includes("/") ||
    given.includes("\\") ||
    given.startsWith(".") ||
    given.startsWith("~") ||
    path.isAbsolute(given)
  );
}

/** `given` as an absolute directory: `~` is the home directory, a relative path is from `cwd`. */
export function resolvePathArgument(given: string, { cwd, home }: { cwd: string; home: string }): string {
  if (given === "~" || given.startsWith("~/") || given.startsWith("~\\")) {
    return path.resolve(home, given.slice(given === "~" ? 1 : 2));
  }
  return path.resolve(cwd, given);
}

/**
 * The new app's name (its id) and, when a path was given, its directory.
 * A bare name is checked as given; a path is resolved and its last part is
 * the name, checked the same way. No argument: asked for, but only at a
 * terminal (never under --json or --yes).
 */
export async function resolveAppTarget(
  given: string | undefined,
  {
    interactive,
    yes,
    cwd,
    home = os.homedir(),
  }: { interactive: boolean; yes: boolean; cwd: string; home?: string },
): Promise<AppTarget> {
  if (given !== undefined && isPathArgument(given)) {
    const dir = resolvePathArgument(given, { cwd, home });
    const appId = path.basename(dir);
    const problem = nameProblem(appId);
    if (problem) {
      throw new EveryAppError(
        "INVALID_APP_ID",
        `${problem.headline}\nAn app is named after the last part of its path, ${given}.`,
        { fix: problem.fix },
      );
    }
    return { appId, dir, absolute: path.isAbsolute(given) || given.startsWith("~") };
  }
  if (given !== undefined) {
    const problem = nameProblem(given);
    if (problem) throw new EveryAppError("INVALID_APP_ID", problem.headline, { fix: problem.fix });
    return { appId: given, dir: null, absolute: false };
  }
  if (!interactive) {
    throw new EveryAppError(
      "APP_ID_REQUIRED",
      `No app name given\n${yes ? "--yes means nothing is asked." : "There's no terminal to ask for one."}`,
      { rerun: `${CLI} create <name>${yes ? " --yes" : ""}` },
    );
  }
  const appId = await askText("App name", {
    context: ["Lowercase letters, digits and dashes. It becomes part of the app's URL."],
    initial: DEFAULT_NAME,
    validate: (input) => {
      const problem = nameProblem(input);
      if (!problem) return null;
      if (problem.reserved) return `${input} is reserved for the platform. Pick another name.`;
      const slug = slugify(input);
      return `Use lowercase letters, digits and dashes.${slug && !nameProblem(slug) ? ` Try ${slug}` : ""}`;
    },
  });
  return { appId, dir: null, absolute: false };
}
