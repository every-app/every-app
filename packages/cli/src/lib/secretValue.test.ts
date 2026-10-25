import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askSecret, askText } from "@/lib/output/prompt";
import { assertOneValueEnough, readSecretValue } from "./secretValue";

vi.mock("@/lib/output/prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/output/prompt")>()),
  canPromptInTerminal: (json: boolean) => !json,
  askText: vi.fn(),
  askSecret: vi.fn(),
}));

const tty = process.stdin.isTTY;
const stdin = process.stdin;
/** stdin as a terminal, or as something piped in. */
function stdinIsTerminal(terminal: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: terminal, configurable: true });
}
/** stdin as a pipe carrying `piped`. */
function pipedIn(piped: string) {
  const stream = Readable.from([piped]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
}

/** What the visible prompt was asked, and the answers its validate gives. */
function answerText(typed: string) {
  let asked: { question: string; context?: readonly string[]; validate?: (value: string) => string | null } | undefined;
  vi.mocked(askText).mockImplementation(async (question, options = {}) => {
    asked = { question, ...options };
    return typed;
  });
  return () => asked!;
}

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  vi.unstubAllEnvs();
  vi.mocked(askText).mockReset();
  vi.mocked(askSecret).mockReset();
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
    await expect(readSecretValue("EMAIL_FROM", { json: true })).rejects.toMatchObject({
      code: "SECRET_VALUE_REQUIRED",
    });
    expect(askText).not.toHaveBeenCalled();
  });

  it("asks for a credential at the hidden prompt, as before", async () => {
    stdinIsTerminal(true);
    vi.mocked(askSecret).mockResolvedValue("  sk-2 ");
    await expect(readSecretValue("OPENAI_API_KEY", {})).resolves.toBe("sk-2");
    expect(askSecret).toHaveBeenCalledWith("Value for OPENAI_API_KEY");
    expect(askText).not.toHaveBeenCalled();
  });

  it("asks for a plain setting visibly, saying what it takes, and re-asks with the reason", async () => {
    stdinIsTerminal(true);
    const asked = answerText(" false ");
    await expect(readSecretValue("EMAIL_PASSWORD_SIGN_IN", {})).resolves.toBe("false");
    expect(askSecret).not.toHaveBeenCalled();
    const { question, context, validate } = asked();
    expect(question).toBe("EMAIL_PASSWORD_SIGN_IN");
    expect(context).toEqual([
      "Takes true or false; false turns password sign-in off (only while Cloudflare Access sign-in is on)",
    ]);
    expect(validate!("")).toBe("Enter a value.");
    expect(validate!("maybe")).toBe("Not one of true, false, 1, 0, on, off, yes or no.");
    expect(validate!(" FALSE ")).toBeNull();
    expect(validate!("no")).toBeNull();
  });

  it("re-asks for an EMAIL_FROM that isn't an address, and takes Name <address>", async () => {
    stdinIsTerminal(true);
    const asked = answerText("Acme <hi@example.com>");
    await expect(readSecretValue("EMAIL_FROM", {})).resolves.toBe("Acme <hi@example.com>");
    const { context, validate } = asked();
    expect(context).toEqual(["Takes an address, or Name <address> (with EMAIL_FROM_NAME set, unless the name is in it)"]);
    expect(validate!("hello")).toBe('"hello" isn\'t an address or Name <address>.');
    expect(validate!("Acme <hi@example.com")).toBe('"Acme <hi@example.com" isn\'t an address or Name <address>.');
    expect(validate!("hi@example.com")).toBeNull();
    expect(validate!("<hi@example.com>")).toBeNull();
  });

  it("checks the plain settings' lists, numbers and URLs the way the Gateway reads them", async () => {
    stdinIsTerminal(true);
    const problems = async (name: string, values: string[]) => {
      const asked = answerText(values[0]!);
      await readSecretValue(name, {});
      return values.map((value) => asked().validate!(value));
    };
    expect(
      await problems("CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS", ["example.com, @Acme.co", "example.com foo", ","]),
    ).toEqual([null, '"foo" isn\'t a domain like example.com.', "Name a domain like example.com."]);
    expect(await problems("MCP_ALLOWED_ORIGINS", ["http://localhost:6274", "localhost:6274"])).toEqual([
      null,
      '"localhost:6274" isn\'t an http or https URL.',
    ]);
    expect(await problems("MCP_AUDIT_RETENTION_DAYS", ["30", "0", "3651", "ninety"])).toEqual([
      null,
      "Not a whole number from 1 to 3650.",
      "Not a whole number from 1 to 3650.",
      "Not a whole number from 1 to 3650.",
    ]);
    expect(await problems("MASTODON_URL", ["mastodon.social", "https://m.example/path", "http://m.example"])).toEqual([
      null,
      '"https://m.example/path" isn\'t an https origin (no path).',
      '"http://m.example" isn\'t an https origin (no path).',
    ]);
    expect(await problems("EMAIL_PROVIDER", ["Resend", "sendgrid"])).toEqual([null, "Not cloudflare or resend."]);
    expect(await problems("BROWSER_APP_INSTALLS", ["off", "Off"])).toEqual([null, "Not on or off."]);
    expect(await problems("HOSTED_OPEN_SIGNUP", ["false", "no"])).toEqual([null, "Not true or false."]);
    // The Gateway turns private event targets on for exactly "true" (server/events/target.ts).
    expect(await problems("EVENTS_ALLOW_PRIVATE_TARGETS", ["true", "false", "True", "yes"])).toEqual([
      null,
      null,
      "Not true or false.",
      "Not true or false.",
    ]);
    expect(await problems("CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN", ["everyone", "all"])).toEqual([
      null,
      "Not everyone.",
    ]);
    // Team domain and issuer: what the Gateway's `accessUrl` refuses (user info, a query, a fragment) is refused here.
    expect(
      await problems("CLOUDFLARE_ACCESS_TEAM_DOMAIN", [
        "acme.cloudflareaccess.com",
        "https://acme.cloudflareaccess.com/",
        "acme.example.com",
        "https://u:p@acme.cloudflareaccess.com",
      ]),
    ).toEqual([
      null,
      null,
      '"acme.example.com" isn\'t <team>.cloudflareaccess.com.',
      '"https://u:p@acme.cloudflareaccess.com" isn\'t <team>.cloudflareaccess.com.',
    ]);
    expect(
      await problems("CLOUDFLARE_ACCESS_OIDC_ISSUER", [
        "https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc123",
        "https://acme.cloudflareaccess.com",
        "https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc?x=1",
        "https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc#x",
      ]),
    ).toEqual([
      null,
      '"https://acme.cloudflareaccess.com" isn\'t an Access for SaaS issuer URL.',
      '"https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc?x=1" isn\'t an Access for SaaS issuer URL.',
      '"https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc#x" isn\'t an Access for SaaS issuer URL.',
    ]);
    // THIRD_PARTY_DOMAIN is read by `thirdPartyDomain`, not the auto-join rule: a trailing `.` is dropped, an `@` is not.
    expect(await problems("THIRD_PARTY_DOMAIN", ["apps.example.com", "example.com.", "@example.com"])).toEqual([
      null,
      null,
      '"@example.com" isn\'t a domain like example.com.',
    ]);
    expect(await problems("AI_PROXY_EXTRA_ROUTES", ["/v1/files, /v1/batches", "/files"])).toEqual([
      null,
      '"/files" isn\'t a /v1/... path.',
    ]);
    expect(await problems("CLOUDFLARE_ACCESS_AUD", ["abc.123, def_4", "a b/c"])).toEqual([
      null,
      '"b/c" isn\'t an AUD tag.',
    ]);
    // A plain setting with no fixed form takes anything but nothing.
    expect(await problems("EMAIL_FROM_NAME", ["Acme Support", ""])).toEqual([null, "Enter a value."]);
    expect(await problems("DISPATCH_NAMESPACE", ["every-app-third-party"])).toEqual([null]);
  });

  it("refuses a plain --from-env value the Gateway wouldn't read, naming what it takes", async () => {
    vi.stubEnv("SIGN_IN", "maybe");
    const refused = readSecretValue("EMAIL_PASSWORD_SIGN_IN", { fromEnv: "SIGN_IN", json: true });
    await expect(refused).rejects.toMatchObject({
      code: "SETTING_VALUE_INVALID",
      message: 'EMAIL_PASSWORD_SIGN_IN can\'t be "maybe"\nNot one of true, false, 1, 0, on, off, yes or no.',
      fix: "use true or false; false turns password sign-in off (only while Cloudflare Access sign-in is on)",
      data: { name: "EMAIL_PASSWORD_SIGN_IN" },
      retryable: false,
      rerun: undefined,
    });
    vi.stubEnv("SIGN_IN", " FALSE\n");
    await expect(readSecretValue("EMAIL_PASSWORD_SIGN_IN", { fromEnv: "SIGN_IN" })).resolves.toBe("FALSE");

    vi.stubEnv("FROM", "hello");
    await expect(readSecretValue("EMAIL_FROM", { fromEnv: "FROM" })).rejects.toMatchObject({
      code: "SETTING_VALUE_INVALID",
      message: 'EMAIL_FROM can\'t be "hello"\n"hello" isn\'t an address or Name <address>.',
      fix: "use an address, or Name <address> (with EMAIL_FROM_NAME set, unless the name is in it)",
      data: { name: "EMAIL_FROM" },
    });
    vi.stubEnv("FROM", "Acme <hi@example.com>");
    await expect(readSecretValue("EMAIL_FROM", { fromEnv: "FROM" })).resolves.toBe("Acme <hi@example.com>");

    // A credential is never checked or trimmed.
    vi.stubEnv("KEY", " maybe\n");
    await expect(readSecretValue("OPENAI_API_KEY", { fromEnv: "KEY" })).resolves.toBe(" maybe\n");
  });

  it("checks a piped plain value too, and shows a long one cut short on one line", async () => {
    pipedIn("off\n");
    await expect(readSecretValue("BROWSER_APP_INSTALLS", {})).resolves.toBe("off");
    pipedIn(`${"x".repeat(70)}\nmore\n`);
    await expect(readSecretValue("MCP_AUDIT_RETENTION_DAYS", {})).rejects.toMatchObject({
      code: "SETTING_VALUE_INVALID",
      message: `MCP_AUDIT_RETENTION_DAYS can't be "${"x".repeat(64)}"\nNot a whole number from 1 to 3650.`,
    });
    pipedIn("sk-3\n");
    await expect(readSecretValue("OPENAI_API_KEY", {})).resolves.toBe("sk-3");
  });
});
