import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOneValueEnough, readSecretValue } from "./secretValue";

const tty = process.stdin.isTTY;
/** stdin as a terminal, or as something piped in. */
function stdinIsTerminal(terminal: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: terminal, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  vi.unstubAllEnvs();
});

describe("assertOneValueEnough", () => {
  it("takes several names from a prompt, one from --from-env or stdin", () => {
    stdinIsTerminal(true);
    expect(() => assertOneValueEnough(["A_KEY", "B_KEY"], undefined)).not.toThrow();
    expect(() => assertOneValueEnough(["A_KEY", "B_KEY"], "X")).toThrow(
      expect.objectContaining({
        code: "SECRET_SEVERAL_NAMES",
        message: "--from-env sets one secret at a time, and you named 2",
        fix: "run it once per name, e.g. pnpm everyapp secret set A_KEY --from-env X",
      }),
    );
    expect(() => assertOneValueEnough(["A_KEY"], "X")).not.toThrow();
    stdinIsTerminal(false);
    expect(() => assertOneValueEnough(["A_KEY", "B_KEY"], undefined)).toThrow(
      expect.objectContaining({ message: "A piped value sets one secret at a time, and you named 2" }),
    );
  });
});

describe("readSecretValue", () => {
  it("reads --from-env, and says what to do when the variable is empty", async () => {
    vi.stubEnv("AUDIT_VAR", "sk-1");
    await expect(readSecretValue("OPENAI_API_KEY", { fromEnv: "AUDIT_VAR" })).resolves.toBe("sk-1");
    vi.stubEnv("AUDIT_VAR", "");
    await expect(readSecretValue("OPENAI_API_KEY", { fromEnv: "AUDIT_VAR" })).rejects.toMatchObject({
      code: "SECRET_EMPTY",
      message: "$AUDIT_VAR is empty or not set",
      fix: "export AUDIT_VAR first, or name another variable with --from-env",
    });
  });

  it("without a terminal or anything piped in, offers --from-env and a pipe", async () => {
    stdinIsTerminal(true);
    await expect(readSecretValue("OPENAI_API_KEY", { json: true })).rejects.toMatchObject({
      code: "SECRET_VALUE_REQUIRED",
      message:
        'Can\'t ask for OPENAI_API_KEY\'s value without a terminal\nOr pipe it in: echo "$OPENAI_API_KEY" | pnpm everyapp secret set OPENAI_API_KEY',
      rerun: "pnpm everyapp secret set OPENAI_API_KEY --from-env OPENAI_API_KEY",
    });
  });
});
