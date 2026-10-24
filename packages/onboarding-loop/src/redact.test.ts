import { describe, expect, it } from "vitest";
import { createRedactor, exposed } from "./redact";
import { spawnProcess } from "./spawn";

// Fake values with the shape of the real ones; none is a real credential.
const CF_TOKEN = "fakeCfToken_0123456789abcdefghijklmnopqrstuvwxyz";
const PROVIDER_KEY =
  "sk-ant-api03-fakeProviderKey0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
const PASSWORD = "loop-pw-9f8e7d6c5b4a";

const secrets = () =>
  createRedactor([
    { name: "cf_token", value: CF_TOKEN },
    { name: "provider_key", value: PROVIDER_KEY },
    { name: "owner_password", value: PASSWORD },
  ]);

describe("redact", () => {
  it("a fake harness that prints `env` leaks nothing: every value is replaced and counted by name", async () => {
    const redactor = secrets();
    const lines: string[] = [];
    // The harness in the sandbox runs `env`; the driver sees its lines through the redactor.
    const result = await spawnProcess("/usr/bin/env", [], {
      env: {
        PATH: process.env["PATH"] ?? "",
        CLOUDFLARE_API_TOKEN: CF_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        ANTHROPIC_API_KEY: PROVIDER_KEY,
        EVERYAPP_EVENT_LOG: "/loop/everyapp-events.ndjson",
      },
      onStdout: (line) => lines.push(redactor.redact(line)),
    });
    expect(result.code).toBe(0);
    const output = lines.join("\n");
    expect(output).not.toContain(CF_TOKEN);
    expect(output).not.toContain(PROVIDER_KEY);
    expect(output).toContain("CLOUDFLARE_API_TOKEN=[REDACTED:cf_token]");
    expect(output).toContain("ANTHROPIC_API_KEY=[REDACTED:provider_key]");
    // The variable names and the non-secrets stay: the record says what was set.
    expect(output).toContain("EVERYAPP_EVENT_LOG=/loop/everyapp-events.ndjson");
    expect(output).toContain(
      "CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef",
    );
    const exposure = redactor.exposure();
    expect(exposure.cf_token).toBe(1);
    expect(exposure.provider_key).toBe(1);
    expect(exposure.owner_password).toBe(0);
    expect(exposed(exposure)).toBe(true);
  });

  it("removes the base64 and hex encodings of a value, not only the value", () => {
    const redactor = secrets();
    const base64 = Buffer.from(CF_TOKEN).toString("base64");
    const hex = Buffer.from(CF_TOKEN).toString("hex");
    const text = `auth: ${base64}\nhex: ${hex}\nb64url: ${Buffer.from(CF_TOKEN).toString("base64url")}`;
    const out = redactor.redact(text);
    expect(out).not.toContain(base64);
    expect(out).not.toContain(hex);
    expect(out).toBe(
      "auth: [REDACTED:cf_token]\nhex: [REDACTED:cf_token]\nb64url: [REDACTED:cf_token]",
    );
    expect(redactor.exposure().cf_token).toBe(3);
  });

  it("removes an est_ setup link the driver never held, keeping the host", () => {
    const redactor = secrets();
    const link =
      "https://apps.example.com/setup#token=est_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdef";
    const out = redactor.redact(
      `{"type":"action_required","data":{"url":"${link}"}}`,
    );
    expect(out).toContain(
      "https://apps.example.com/setup#token=[REDACTED:est_link]",
    );
    expect(out).not.toMatch(/est_[A-Za-z0-9_-]{20,}/);
    expect(redactor.exposure().est_link).toBe(1);
  });

  it("removes Bearer headers, x-api-key and cf-aig-authorization values, and unknown sk- keys", () => {
    const redactor = createRedactor();
    const text = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      'x-api-key: "xk-proj-0123456789abcdefghijklmnop"',
      "cf-aig-authorization=zzzzzzzzzzzzzzzzzzzz",
      "ANTHROPIC_API_KEY=sk-ant-api03-somethingelse0123456789",
    ].join("\n");
    const out = redactor.redact(text);
    expect(out).toBe(
      [
        "Authorization: Bearer [REDACTED:bearer]",
        'x-api-key: "[REDACTED:bearer]"',
        "cf-aig-authorization=[REDACTED:bearer]",
        "ANTHROPIC_API_KEY=[REDACTED:provider_key]",
      ].join("\n"),
    );
    expect(redactor.exposure()).toEqual({
      cf_token: 0,
      provider_key: 1,
      est_link: 0,
      owner_password: 0,
      bearer: 3,
    });
  });

  it("a value learnt later (the owner password) is redacted from then on", () => {
    const redactor = createRedactor();
    redactor.add({ name: "owner_password", value: PASSWORD });
    expect(redactor.redact(`{"password":"${PASSWORD}"}`)).toBe(
      '{"password":"[REDACTED:owner_password]"}',
    );
  });

  it("leaves ordinary text alone and counts nothing", () => {
    const redactor = secrets();
    const text =
      '{"v":1,"type":"step","step":"setup.gateway","status":"ok","message":"Deployed"}';
    expect(redactor.redact(text)).toBe(text);
    expect(exposed(redactor.exposure())).toBe(false);
  });
});
