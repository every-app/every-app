/**
 * The setup prompt (design section 7): one text, kept verbatim in
 * prompts/setup.md and landing-page/content/docs/setup-prompt.txt
 * (prompt.test.ts fails when they differ), its sha256 on every record, and
 * the loop's `checkout-present` variant that replaces step 1 and nothing
 * else.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = join(here, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
export const PROMPT_FILE = join(PACKAGE_ROOT, "prompts", "setup.md");
export const SITE_PROMPT_FILE = join(
  REPO_ROOT,
  "landing-page",
  "content",
  "docs",
  "setup-prompt.txt",
);

export type PromptVariant = "public" | "checkout-present";

export const CHECKOUT_PRESENT_STEP_1 =
  "1. The repository is already cloned at /work/every-app; run `pnpm install`\n   there and every command from that folder. Always `pnpm everyapp`, never npx.";

export function readPrompt(path = PROMPT_FILE): string {
  return readFileSync(path, "utf8");
}

export const promptSha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Step 1 of the public prompt: from "1." to the line before "2.". */
const STEP_1 = /^1\. [\s\S]*?(?=^2\. )/m;

/** The text a visitor pastes, or the loop's variant with step 1 replaced. */
export function promptText(
  variant: PromptVariant,
  base = readPrompt(),
): string {
  if (variant === "public") return base;
  if (!STEP_1.test(base))
    throw new Error("the prompt has no step 1 to replace");
  return base.replace(STEP_1, `${CHECKOUT_PRESENT_STEP_1}\n`);
}
