import {
  GATEWAY_WORKER_NAME,
  isReservedAppId,
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
  if (isReservedAppId(input) || workerNameFor(input) === GATEWAY_WORKER_NAME) {
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

/**
 * The new app's name (its id): the one given, once it is valid; otherwise
 * asked for, but only at a terminal (never under --json or --yes).
 */
export async function resolveAppId(
  given: string | undefined,
  { interactive, yes }: { interactive: boolean; yes: boolean },
): Promise<string> {
  if (given !== undefined) {
    const problem = nameProblem(given);
    if (problem) throw new EveryAppError("INVALID_APP_ID", problem.headline, { fix: problem.fix });
    return given;
  }
  if (!interactive) {
    throw new EveryAppError(
      "APP_ID_REQUIRED",
      `No app name given\n${yes ? "--yes means nothing is asked." : "There's no terminal to ask for one."}`,
      { rerun: `${CLI} create <name>${yes ? " --yes" : ""}` },
    );
  }
  return askText("App name", {
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
}
