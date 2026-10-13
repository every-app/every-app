import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  const devVars = () => path.join(dir, ".dev.vars");
  const read = () => fs.readFileSync(devVars(), "utf-8");

  it("writes a single-line JSON array the SDK can parse", () => {
    const { publicKeyPem } = ensureDevKeys(dir);
    upsertDevVars(dir, publicKeyPem);

    const line = read()
      .split("\n")
      .find((l) => l.startsWith(`${PUBLIC_KEYS_ENV}=`));
    expect(line).toBeDefined();
    // Must be one dotenv-safe line (PEM newlines are JSON-escaped).
    const value = line!.slice(PUBLIC_KEYS_ENV.length + 1);
    const parsed = JSON.parse(value) as string[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe(publicKeyPem);
  });

  it("sets the issuer the local gateway signs with", () => {
    upsertDevVars(dir, "key");
    expect(read()).toContain(
      "EVERYAPP_IDENTITY_ISSUER=https://gateway.dev.localhost",
    );
  });

  it("preserves other vars and replaces its own lines idempotently", () => {
    fs.writeFileSync(devVars(), "OTHER_VAR=keep-me\nEVERYAPP_DEV=1\n");
    upsertDevVars(
      dir,
      "-----BEGIN PUBLIC KEY-----\nold\n-----END PUBLIC KEY-----\n",
    );
    upsertDevVars(
      dir,
      "-----BEGIN PUBLIC KEY-----\nnew\n-----END PUBLIC KEY-----\n",
    );

    const content = read();
    expect(content).toContain("OTHER_VAR=keep-me");
    expect(content).toContain("new");
    expect(content).not.toContain("old");
    // cloudflare.config.ts sets EVERYAPP_DEV now.
    expect(content).not.toContain("EVERYAPP_DEV=");
    const occurrences = content
      .split("\n")
      .filter((l) => l.startsWith(`${PUBLIC_KEYS_ENV}=`));
    expect(occurrences).toHaveLength(1);
  });

  it("moves vars from the old .everyapp/.dev.vars and removes it", () => {
    const legacyFile = path.join(dir, ".everyapp", ".dev.vars");
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(
      legacyFile,
      `${PUBLIC_KEYS_ENV}=["old-key"]\nEVERYAPP_DEV=1\nOPENAI_API_KEY=sk-legacy\n`,
    );
    fs.writeFileSync(devVars(), "OPENAI_API_KEY=sk-current\n");

    upsertDevVars(dir, "new-key");

    expect(fs.existsSync(legacyFile)).toBe(false);
    const content = read();
    expect(content).toContain(`${PUBLIC_KEYS_ENV}=["new-key"]`);
    // The root file's own value wins over the legacy one.
    expect(content).toContain("OPENAI_API_KEY=sk-current");
    expect(content).not.toContain("sk-legacy");
    expect(content).not.toContain("EVERYAPP_DEV=");
  });

  it("gitignores .dev.vars", () => {
    upsertDevVars(dir, "key");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toContain(
      ".dev.vars",
    );
  });
});
