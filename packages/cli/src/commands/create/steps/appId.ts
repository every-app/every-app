import {
  GATEWAY_WORKER_NAME,
  isReservedAppId,
  workerNameFor,
} from "@every-app/perimeter/manifest";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { askText } from "@/lib/output/prompt";

const KEBAB_CASE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

/** Why `input` can't be an app id (a headline, then a detail line), or null when it can. */
function validateAppId(input: string): string | null {
  if (!input || input.trim().length === 0) {
    return "The app id can't be empty";
  }
  if (input.length > 64) {
    return "The app id must be 64 characters or less";
  }
  if (!KEBAB_CASE.test(input)) {
    return "The app id must be kebab-case\nUse lowercase letters, digits and hyphens, starting with a letter.";
  }
  // "--" separates an app's Worker name from its resources' names.
  if (input.includes("--")) {
    return "The app id can't contain two hyphens in a row";
  }
  if (isReservedAppId(input) || workerNameFor(input) === GATEWAY_WORKER_NAME) {
    return `"${input}" is reserved for the platform\nPick another app id.`;
  }
  return null;
}

/** `input` made into an app id, when it can be ("Analytics_App" → "analytics-app"). */
function slugify(input: string): string | null {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "");
  return slug && validateAppId(slug) === null ? slug : null;
}

/**
 * The new app's id: the one given, once it validates; otherwise asked for,
 * but only at a terminal (never under --json or --yes).
 */
export async function resolveAppId(
  given: string | undefined,
  { interactive }: { interactive: boolean },
): Promise<string> {
  if (given !== undefined) {
    const problem = validateAppId(given);
    if (problem) {
      const slug = slugify(given);
      throw new EveryAppError("INVALID_APP_ID", problem, slug ? { rerun: `${CLI} create ${slug}` } : {});
    }
    return given;
  }
  if (!interactive) {
    throw new EveryAppError("APP_ID_REQUIRED", "Name the new app (kebab-case, e.g. my-app)", {
      data: { usage: `${CLI} create <id>` },
    });
  }
  return askText("App id (kebab-case, e.g. my-app)", {
    validate: (input) => validateAppId(input)?.split("\n")[0] ?? null,
  });
}
