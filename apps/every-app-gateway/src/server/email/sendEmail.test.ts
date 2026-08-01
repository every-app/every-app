import { beforeEach, describe, expect, it, vi } from "vitest";

const workerEnv = vi.hoisted(() => ({
  EMAIL: undefined as { send: ReturnType<typeof vi.fn> } | undefined,
  EMAIL_REST_API_TOKEN: undefined as string | undefined,
  CLOUDFLARE_ACCOUNT_ID: undefined as string | undefined,
  EMAIL_FROM: undefined as string | undefined,
  EMAIL_FROM_NAME: undefined as string | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: workerEnv }));

import { sendEmail } from "./sendEmail";

describe("sendEmail", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
