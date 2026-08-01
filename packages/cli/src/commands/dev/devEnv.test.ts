import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDevKeys, upsertDevVars, PUBLIC_KEYS_ENV } from "./devEnv";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-dev-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ensureDevKeys", () => {
  it("generates a persistent RS256 keypair and gitignores it", () => {
    const first = ensureDevKeys(dir);
    expect(first.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(first.publicKeyPem).toContain("BEGIN PUBLIC KEY");

    // Stable across runs — .dev.vars never goes stale.
    const second = ensureDevKeys(dir);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);

    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".everyapp/");
  });
});

describe("upsertDevVars", () => {
  const configPath = () => path.join(dir, ".everyapp", "wrangler.json");

  it("writes a single-line JSON array the SDK can parse", () => {
    const { publicKeyPem } = ensureDevKeys(dir);
    upsertDevVars(dir, configPath(), publicKeyPem);

    const content = fs.readFileSync(
      path.join(dir, ".everyapp", ".dev.vars"),
      "utf-8",
    );
    const line = content
      .split("\n")
      .find((l) => l.startsWith(`${PUBLIC_KEYS_ENV}=`));
    expect(line).toBeDefined();
    // Must be one dotenv-safe line (PEM newlines are JSON-escaped).
    const value = line!.slice(PUBLIC_KEYS_ENV.length + 1);
    const parsed = JSON.parse(value) as string[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe(publicKeyPem);
  });

  it("preserves other vars and replaces its own line idempotently", () => {
    const file = path.join(dir, ".everyapp", ".dev.vars");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "OTHER_VAR=keep-me\n");
    upsertDevVars(
      dir,
      configPath(),
      "-----BEGIN PUBLIC KEY-----\nold\n-----END PUBLIC KEY-----\n",
    );
    upsertDevVars(
      dir,
      configPath(),
      "-----BEGIN PUBLIC KEY-----\nnew\n-----END PUBLIC KEY-----\n",
    );

    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("OTHER_VAR=keep-me");
    expect(content).toContain("new");
    expect(content).not.toContain("old");
    const occurrences = content
      .split("\n")
      .filter((l) => l.startsWith(`${PUBLIC_KEYS_ENV}=`));
    expect(occurrences).toHaveLength(1);
  });

  it("removes a legacy app-root file containing only CLI-managed vars", () => {
    const legacyFile = path.join(dir, ".dev.vars");
    fs.writeFileSync(
      legacyFile,
      `${PUBLIC_KEYS_ENV}=["old-key"]\nEVERYAPP_DEV=1\n`,
    );

    upsertDevVars(dir, configPath(), "new-key");

    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(
      fs.readFileSync(path.join(dir, ".everyapp", ".dev.vars"), "utf-8"),
    ).toContain(`${PUBLIC_KEYS_ENV}=["new-key"]`);
  });

  it("keeps and warns about a legacy app-root file with user content", () => {
    const legacyFile = path.join(dir, ".dev.vars");
    const legacyContent = `${PUBLIC_KEYS_ENV}=["old-key"]\nUSER_SECRET=keep-me\n`;
    fs.writeFileSync(legacyFile, legacyContent);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    upsertDevVars(dir, configPath(), "new-key");

    expect(fs.readFileSync(legacyFile, "utf-8")).toBe(legacyContent);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("contains user-managed content"),
    );
    warn.mockRestore();
  });
});
