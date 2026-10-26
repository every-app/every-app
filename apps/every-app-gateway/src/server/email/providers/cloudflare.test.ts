import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareEmailProvider as cloudflare } from "./cloudflare";
import type { OutboundEmail } from "./types";

const MESSAGE: OutboundEmail = {
  from: { address: "noreply@example.com", name: "EveryApp" },
  to: ["user@example.net"],
  cc: [],
  bcc: [],
  subject: "Reset your password",
  html: "<p>Reset it</p>",
  text: "Reset it",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Cloudflare provider", () => {
  it("is set up by the REST pair, or by the binding alone", () => {
    const send = vi.fn();
    expect(cloudflare.setup({})).toBeNull();
    expect(cloudflare.setup({ EMAIL: { send } })).toBe("binding");
    expect(
      cloudflare.setup({
        EMAIL_REST_API_TOKEN: " token ",
        CLOUDFLARE_ACCOUNT_ID: "account",
      }),
    ).toBe("settings");
    expect(cloudflare.setup({ EMAIL_REST_API_TOKEN: "token" })).toBeNull();
    expect(cloudflare.setup({ EMAIL: { send: "not a function" } })).toBeNull();
    expect(cloudflare.configured({ EMAIL: { send } })).toBe(true);
    expect(cloudflare.configured({})).toBe(false);
  });

  it("hands the binding structured fields, inline attachments with their content id", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "<b1@example.com>" });
    await expect(
      cloudflare.send(
        { EMAIL: { send } },
        {
          ...MESSAGE,
          to: ["a@example.net", "b@example.net"],
          cc: ["c@example.net"],
          replyTo: { address: "help@example.com" },
          headers: { "In-Reply-To": "<prev@example.net>" },
          attachments: [
            {
              filename: "logo.png",
              contentType: "image/png",
              content: "iVBORw0KGgo=",
              disposition: "inline",
              contentId: "logo",
            },
          ],
        },
      ),
    ).resolves.toEqual({ messageId: "<b1@example.com>", status: "delivered" });
    expect(send).toHaveBeenCalledWith({
      to: ["a@example.net", "b@example.net"],
      cc: ["c@example.net"],
      from: { email: "noreply@example.com", name: "EveryApp" },
      replyTo: "help@example.com",
      subject: "Reset your password",
      html: "<p>Reset it</p>",
      text: "Reset it",
      headers: { "In-Reply-To": "<prev@example.net>" },
      attachments: [
        {
          disposition: "inline",
          contentId: "logo",
          filename: "logo.png",
          type: "image/png",
          content: "iVBORw0KGgo=",
        },
      ],
    });
  });

  it("prefers REST over the binding", async () => {
    const send = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        errors: [],
        result: {
          message_id: "<r1@example.com>",
          delivered: ["x"],
          queued: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      cloudflare.send(
        {
          EMAIL: { send },
          EMAIL_REST_API_TOKEN: "rest-token",
          CLOUDFLARE_ACCOUNT_ID: "account-id",
        },
        MESSAGE,
      ),
    ).resolves.toEqual({ messageId: "<r1@example.com>", status: "delivered" });
    expect(send).not.toHaveBeenCalled();
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
  });

  it("throws EmailDeliveryErrors carrying Cloudflare's code", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("nope"), { code: "E_SENDER_NOT_VERIFIED" }),
      );
    await expect(
      cloudflare.send({ EMAIL: { send } }, MESSAGE),
    ).rejects.toMatchObject({
      name: "EmailDeliveryError",
      code: "EMAIL_SEND_FAILED",
      provider: "cloudflare",
      providerCode: "E_SENDER_NOT_VERIFIED",
      message:
        "Cloudflare Email Service failed to send the message (E_SENDER_NOT_VERIFIED).",
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { success: false, errors: [{ code: 10004, message: "slow down" }] },
            { status: 429 },
          ),
        ),
    );
    await expect(
      cloudflare.send(
        { EMAIL_REST_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" },
        MESSAGE,
      ),
    ).rejects.toMatchObject({
      code: "EMAIL_SEND_FAILED",
      providerCode: "10004",
    });

    await expect(cloudflare.send({}, MESSAGE)).rejects.toMatchObject({
      code: "EMAIL_BINDING_UNAVAILABLE",
    });
  });
});
