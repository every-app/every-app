import { beforeEach, describe, expect, it, vi } from "vitest";

const workerEnv = vi.hoisted(() => ({
  GATEWAY_DEPLOYMENT_MODE: "self_hosted" as string,
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
  EMAIL: undefined as { send: ReturnType<typeof vi.fn> } | undefined,
  EMAIL_REST_API_TOKEN: undefined as string | undefined,
  CLOUDFLARE_ACCOUNT_ID: undefined as string | undefined,
  EMAIL_FROM: undefined as string | undefined,
  EMAIL_FROM_NAME: undefined as string | undefined,
}));

// The daily mail budgets' counters, in memory: key -> count.
const counters = vi.hoisted(() => ({
  values: new Map<string, number>(),
  unreadable: false,
}));

vi.mock("cloudflare:workers", () => ({ env: workerEnv }));
vi.mock("@/server/repositories/RateLimitCounterRepository", () => ({
  RateLimitCounterRepository: {
    read: async (keys: string[]) => {
      if (counters.unreadable) throw new Error("D1 unavailable");
      return new Map(
        keys.flatMap((key) =>
          counters.values.has(key) ? [[key, counters.values.get(key)!]] : [],
        ),
      );
    },
    increment: async (keys: string[]) => {
      for (const key of keys) {
        counters.values.set(key, (counters.values.get(key) ?? 0) + 1);
      }
    },
  },
}));

import { isEmailConfigured, sendEmail } from "./sendEmail";

describe("sendEmail", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    counters.values.clear();
    counters.unreadable = false;
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "self_hosted";
    workerEnv.EMAIL = undefined;
    workerEnv.EMAIL_REST_API_TOKEN = undefined;
    workerEnv.CLOUDFLARE_ACCOUNT_ID = undefined;
    workerEnv.EMAIL_FROM = undefined;
    workerEnv.EMAIL_FROM_NAME = undefined;
  });

  it("sends both HTML and text through the structured Workers binding", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "message-1" });
    workerEnv.EMAIL = { send };
    workerEnv.EMAIL_FROM = "noreply@example.com";
    workerEnv.EMAIL_FROM_NAME = "Every App";

    await sendEmail({
      kind: "reset",
      to: "user@example.net",
      subject: "Reset your password",
      html: "<p>Reset it</p>",
      text: "Reset it",
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      to: "user@example.net",
      from: { email: "noreply@example.com", name: "Every App" },
      subject: "Reset your password",
      html: "<p>Reset it</p>",
      text: "Reset it",
    });
  });

  it("prefers REST over the binding and uses the REST field shapes", async () => {
    const bindingSend = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: {
            delivered: ["user@example.net"],
            permanent_bounces: [],
            queued: [],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    workerEnv.EMAIL = { send: bindingSend };
    workerEnv.EMAIL_REST_API_TOKEN = "rest-token";
    workerEnv.CLOUDFLARE_ACCOUNT_ID = "account-id";
    workerEnv.EMAIL_FROM = "noreply@example.com";
    workerEnv.EMAIL_FROM_NAME = "Every App";

    await sendEmail({
      kind: "reset",
      to: "user@example.net",
      subject: "Reset your password",
      html: "<p>Reset it</p>",
      text: "Reset it",
    });

    expect(bindingSend).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-id/email/sending/send",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer rest-token",
          "Content-Type": "application/json",
        },
      }),
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      to: "user@example.net",
      from: { address: "noreply@example.com", name: "Every App" },
      reply_to: { address: "noreply@example.com", name: "Every App" },
      subject: "Reset your password",
      html: "<p>Reset it</p>",
      text: "Reset it",
    });
  });

  it("reports REST HTTP failures through the structured error log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1000, message: "Sender domain not verified" }],
            result: null,
          }),
          { status: 400 },
        ),
      ),
    );
    workerEnv.EMAIL_REST_API_TOKEN = "rest-token";
    workerEnv.CLOUDFLARE_ACCOUNT_ID = "account-id";
    workerEnv.EMAIL_FROM = "noreply@example.com";
    workerEnv.EMAIL_FROM_NAME = "Every App";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      sendEmail({
        kind: "invitation",
        to: "user@example.net",
        subject: "Invitation",
        html: "<p>Join us</p>",
        text: "Join us",
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_SEND_FAILED",
      message: "Cloudflare Email Service failed to send the message (1000).",
    });

    expect(consoleError).toHaveBeenCalledWith(
      "Email delivery failed",
      expect.objectContaining({
        event: "email.send.failed",
        code: "EMAIL_SEND_FAILED",
        providerCode: "1000",
      }),
    );
  });

  it("treats REST permanent bounces as structured send failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: {
              delivered: [],
              permanent_bounces: ["user@example.net"],
              queued: [],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    workerEnv.EMAIL_REST_API_TOKEN = "rest-token";
    workerEnv.CLOUDFLARE_ACCOUNT_ID = "account-id";
    workerEnv.EMAIL_FROM = "noreply@example.com";
    workerEnv.EMAIL_FROM_NAME = "Every App";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      sendEmail({
        kind: "invitation",
        to: "user@example.net",
        subject: "Invitation",
        html: "<p>Join us</p>",
        text: "Join us",
      }),
    ).rejects.toMatchObject({ code: "EMAIL_SEND_FAILED" });

    expect(consoleError).toHaveBeenCalledWith(
      "Email delivery failed",
      expect.objectContaining({
        event: "email.send.failed",
        code: "EMAIL_SEND_FAILED",
      }),
    );
  });

  it("accepts the previous combined sender format", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "message-1" });
    workerEnv.EMAIL = { send };
    workerEnv.EMAIL_FROM = "Every App <noreply@example.com>";

    await sendEmail({
      kind: "invitation",
      to: "user@example.net",
      subject: "Invitation",
      html: "<p>Join us</p>",
      text: "Join us",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { email: "noreply@example.com", name: "Every App" },
      }),
    );
  });

  it("loads without email configuration and fails only when sending", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      sendEmail({
        kind: "reset",
        to: "user@example.net",
        subject: "Reset your password",
        html: "<p>Reset it</p>",
        text: "Reset it",
      }),
    ).rejects.toMatchObject({
      name: "EmailDeliveryError",
      code: "EMAIL_BINDING_UNAVAILABLE",
    });

    expect(consoleError).toHaveBeenCalledWith("Email delivery failed", {
      event: "email.send.failed",
      kind: "reset",
      code: "EMAIL_BINDING_UNAVAILABLE",
      providerCode: undefined,
      message:
        "Email delivery is unavailable because the EMAIL send_email binding is not configured.",
    });
  });

  it("preserves Cloudflare's provider error code in the structured log", async () => {
    const providerError = Object.assign(new Error("sender not verified"), {
      code: "E_SENDER_NOT_VERIFIED",
    });
    workerEnv.EMAIL = { send: vi.fn().mockRejectedValue(providerError) };
    workerEnv.EMAIL_FROM = "noreply@example.com";
    workerEnv.EMAIL_FROM_NAME = "Every App";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      sendEmail({
        kind: "invitation",
        to: "user@example.net",
        subject: "Invitation",
        html: "<p>Join us</p>",
        text: "Join us",
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_SEND_FAILED",
      message:
        "Cloudflare Email Service failed to send the message (E_SENDER_NOT_VERIFIED).",
    });

    expect(consoleError).toHaveBeenCalledWith(
      "Email delivery failed",
      expect.objectContaining({
        event: "email.send.failed",
        code: "EMAIL_SEND_FAILED",
        providerCode: "E_SENDER_NOT_VERIFIED",
      }),
    );
  });
});

describe("sendEmail's daily budgets", () => {
  const send = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    counters.values.clear();
    counters.unreadable = false;
    send.mockReset().mockResolvedValue({ messageId: "message-1" });
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "hosted";
    workerEnv.EMAIL = { send };
    workerEnv.EMAIL_REST_API_TOKEN = undefined;
    workerEnv.CLOUDFLARE_ACCOUNT_ID = undefined;
    workerEnv.EMAIL_FROM = "noreply@example.com";
    workerEnv.EMAIL_FROM_NAME = "Every App";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  const mail = (
    kind: "verification" | "reset" | "invitation",
    to = "someone@example.net",
  ) => sendEmail({ kind, to, subject: "s", html: "<p>h</p>", text: "t" });

  it("sends a few mails of a kind a day to one address, then refuses", async () => {
    // The hosted policy: five a day to any one address, per kind.
    for (let i = 0; i < 5; i += 1) await mail("verification");
    await expect(mail("verification")).rejects.toMatchObject({
      code: "EMAIL_BUDGET_EXHAUSTED",
    });
    expect(send).toHaveBeenCalledTimes(5);

    // The address, as typed or not, is one address.
    await expect(
      mail("verification", " SomeOne@Example.NET "),
    ).rejects.toMatchObject({ code: "EMAIL_BUDGET_EXHAUSTED" });
    // Another kind, and another address, have budgets of their own.
    await mail("reset");
    await mail("verification", "other@example.net");
    expect(send).toHaveBeenCalledTimes(7);
  });

  it("caps each kind for the whole gateway", async () => {
    const day = new Date().toISOString().slice(0, 10);
    counters.values.set(`mail:invitation:gateway:${day}`, 2_000);

    await expect(mail("invitation")).rejects.toMatchObject({
      code: "EMAIL_BUDGET_EXHAUSTED",
      message: expect.stringContaining("The gateway has sent all"),
    });
    await mail("verification");
    expect(send).toHaveBeenCalledOnce();
  });

  it("never stores the address in a counter key", async () => {
    await mail("reset", "private.person@example.net");
    const keys = [...counters.values.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.join(" ")).not.toContain("private.person");
    expect(keys).toContainEqual(
      expect.stringMatching(/^mail:reset:to:[0-9a-f]{32}:\d{4}-\d{2}-\d{2}$/),
    );
  });

  it("counts a mail the provider then refuses", async () => {
    send.mockRejectedValue(new Error("provider down"));
    for (let i = 0; i < 5; i += 1) {
      await expect(mail("reset")).rejects.toMatchObject({
        code: "EMAIL_SEND_FAILED",
      });
    }
    await expect(mail("reset")).rejects.toMatchObject({
      code: "EMAIL_BUDGET_EXHAUSTED",
    });
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("refuses when the budget can't be read", async () => {
    counters.unreadable = true;
    await expect(mail("verification")).rejects.toMatchObject({
      code: "EMAIL_BUDGET_UNAVAILABLE",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing when the mode is invalid", async () => {
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "nonsense";
    await expect(mail("reset")).rejects.toMatchObject({
      code: "EMAIL_BUDGET_EXHAUSTED",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("gives a self-hosted gateway roomier budgets", async () => {
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "self_hosted";
    for (let i = 0; i < 10; i += 1) await mail("invitation");
    await expect(mail("invitation")).rejects.toMatchObject({
      code: "EMAIL_BUDGET_EXHAUSTED",
    });
  });
});

describe("isEmailConfigured", () => {
  beforeEach(() => {
    workerEnv.EMAIL = undefined;
    workerEnv.EMAIL_REST_API_TOKEN = undefined;
    workerEnv.CLOUDFLARE_ACCOUNT_ID = undefined;
    workerEnv.EMAIL_FROM = undefined;
    workerEnv.EMAIL_FROM_NAME = undefined;
  });

  it("is false without a sender, even with a transport", () => {
    workerEnv.EMAIL = { send: vi.fn() };
    expect(isEmailConfigured()).toBe(false);
  });

  it("is false with a sender but no transport", () => {
    workerEnv.EMAIL_FROM = "Every App <noreply@example.com>";
    expect(isEmailConfigured()).toBe(false);
  });

  it("is true with a sender and the binding or the REST API", () => {
    workerEnv.EMAIL_FROM = "Every App <noreply@example.com>";
    workerEnv.EMAIL = { send: vi.fn() };
    expect(isEmailConfigured()).toBe(true);

    workerEnv.EMAIL = undefined;
    workerEnv.EMAIL_REST_API_TOKEN = "token";
    workerEnv.CLOUDFLARE_ACCOUNT_ID = "account";
    expect(isEmailConfigured()).toBe(true);
  });
});
