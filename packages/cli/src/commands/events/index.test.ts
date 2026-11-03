/**
 * `events add`'s CLI side, before any tool runs: what a person typed is
 * checked (a secret typed after --secret is never sent), and the signing
 * secret is read from the environment, a pipe or a prompt. The rules of
 * the subscription itself are the Gateway's, tested there.
 */
import { describe, expect, it, vi } from "vitest";
import { addArgs, readSigningSecret } from "./index";

const noStdin = { readStdin: async () => null, interactive: false };

describe("addArgs", () => {
  it("refuses a value typed after --secret, which lands as the URL, without reading or sending it", async () => {
    const readStdin = vi.fn(async () => null);
    await expect(addArgs({ secret: true }, "s3cret-value", { readStdin })).rejects.toMatchObject({ code: "VALUE_ON_COMMAND_LINE" });
    await expect(addArgs({ "secret-from-env": "HOOK_SECRET" }, "s3cret-value", { readStdin })).rejects.toMatchObject({
      code: "VALUE_ON_COMMAND_LINE",
    });
    expect(readStdin).not.toHaveBeenCalled();
  });

  it("refuses a URL and --email together, a secret on an email subscription, and neither target", async () => {
    await expect(addArgs({ email: "admins" }, "https://hooks.example.com/x", noStdin)).rejects.toMatchObject({ code: "EVENT_SINK_CONFLICT" });
    await expect(addArgs({ email: "owners", secret: true }, undefined, noStdin)).rejects.toMatchObject({ code: "EVENT_SINK_CONFLICT" });
    await expect(addArgs({}, undefined, noStdin)).rejects.toMatchObject({ code: "EVENT_TARGET_REQUIRED" });
  });

  it("builds the tool's arguments: the URL trimmed, --events split on commas, the secret read when asked for", async () => {
    expect(await addArgs({ events: ["member.*, app.*", "cap.reached"], name: "Hooks" }, " https://hooks.example.com/x ", noStdin)).toEqual({
      url: "https://hooks.example.com/x",
      events: ["member.*", "app.*", "cap.reached"],
      name: "Hooks",
    });
    expect(await addArgs({ email: "admins" }, undefined, noStdin)).toEqual({ email: "admins" });
    expect(
      await addArgs({ secret: true }, "https://hooks.example.com/x", { readStdin: async () => "piped-secret-0123\n" }),
    ).toEqual({ url: "https://hooks.example.com/x", secret: "piped-secret-0123" });
  });
});

describe("readSigningSecret", () => {
  it("reads --secret-from-env, and refuses an empty or unset variable", async () => {
    expect(await readSigningSecret({ "secret-from-env": "HOOK" }, { env: { HOOK: "from-env-0123456" } })).toBe("from-env-0123456");
    await expect(readSigningSecret({ "secret-from-env": "HOOK" }, { env: {} })).rejects.toMatchObject({ code: "SECRET_EMPTY" });
  });

  it("takes what is piped in, else asks at a terminal, else refuses", async () => {
    expect(await readSigningSecret({}, { readStdin: async () => "piped\r\n" })).toBe("piped");
    const prompt = vi.fn(async () => "typed-at-prompt");
    expect(await readSigningSecret({}, { readStdin: async () => null, interactive: true, prompt })).toBe("typed-at-prompt");
    await expect(readSigningSecret({}, noStdin)).rejects.toMatchObject({ code: "SECRET_VALUE_REQUIRED" });
    await expect(readSigningSecret({}, { readStdin: async () => "\n", interactive: true, prompt })).rejects.toMatchObject({
      code: "SECRET_VALUE_REQUIRED",
    });
  });
});
