import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_PRESENT_STEP_1,
  PROMPT_FILE,
  promptSha256,
  promptText,
  readPrompt,
  SITE_PROMPT_FILE,
} from "./prompt";

describe("the setup prompt", () => {
  const prompt = readPrompt();
  it("is the same bytes in the loop and on the site", () => {
    expect(readFileSync(SITE_PROMPT_FILE, "utf8")).toBe(prompt);
    expect(readFileSync(PROMPT_FILE, "utf8")).toBe(prompt);
  });
  it("says create then deploy from the app folder, never create --deploy, with the installed everyapp", () => {
    expect(prompt).toContain("`everyapp create hello --json`");
    expect(prompt).toContain("`everyapp deploy --json`");
    expect(prompt).toContain("from hello");
    expect(prompt).not.toContain("create --deploy");
    expect(prompt).not.toMatch(/pnpm everyapp/);
    expect(prompt).toContain("`npm install -g everyapp@latest`");
  });
  it("keys only on setup, create, deploy, install and the --json protocol", () => {
    expect(prompt).toContain(
      "`everyapp setup --domain apps.<my domain> --json`",
    );
    expect(prompt).toContain("Setup can run 20 minutes");
    expect(prompt).toContain('"type":"action_required"');
    expect(prompt).toContain("run its data.rerun exactly as given");
    expect(prompt).toContain("data.needsTerminal");
    expect(prompt).toContain("print DONE and the Gateway URL");
    expect(prompt).toContain("BLOCKED: <why>");
    expect(prompt).not.toMatch(/gateway deploy|everyapp update/);
  });

  it("installs the four apps by default and asks once which to skip", () => {
    expect(prompt).toContain("unless I say which to skip");
    expect(prompt).toContain(
      "`everyapp install https://github.com/every-app/<repo> --json`",
    );
    expect(prompt).toContain("open-seo, open-crm, open-analytics or open-mail");
    expect(prompt).toContain(
      "answers NO_RELEASE, say which app and continue; do not try to",
    );
  });
  it("starts with the one entry point and the install step, no clone", () => {
    expect(
      prompt.startsWith(
        "Set up EveryApp for me. Docs: https://everyapp.com/llms.txt",
      ),
    ).toBe(true);
    expect(prompt).toContain("1. Check `node --version` is 22.18 or newer");
    expect(prompt).not.toContain("git clone");
    expect(prompt).not.toContain("Clone https://github.com");
  });
  it("has a stable sha256 that goes on every record", () => {
    expect(promptSha256(prompt)).toMatch(/^[0-9a-f]{64}$/);
    expect(promptSha256(prompt)).toBe(
      promptSha256(readFileSync(SITE_PROMPT_FILE, "utf8")),
    );
  });
  it("replaces only step 1 in the checkout-present variant", () => {
    const variant = promptText("checkout-present", prompt);
    expect(variant).toContain(CHECKOUT_PRESENT_STEP_1);
    expect(variant).not.toContain("npm install -g everyapp");
    expect(variant).toContain("/work/every-app");
    const [, afterStep1] = prompt.split(/^2\. /m);
    const [, variantAfter] = variant.split(/^2\. /m);
    expect(variantAfter).toBe(afterStep1);
    expect(variant.split("\n1. ")[0]).toBe(prompt.split("\n1. ")[0]);
    expect(promptText("public", prompt)).toBe(prompt);
    expect(promptSha256(variant)).not.toBe(promptSha256(prompt));
  });
});
