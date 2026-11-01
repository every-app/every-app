import { emailProviderRefusal } from "@every-app/sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resendEmailProvider as resend } from "./resend";
import type { OutboundEmail } from "./types";

const ENV = { RESEND_API_KEY: " re_test_key " };
const MESSAGE: OutboundEmail = {
  from: { address: "support@mail.example.com", name: "Support" },
  to: ["a@example.net"],
  cc: [],
  bcc: [],
  subject: "Re: hello",
  text: "Hi",
};

function answer(status: number, body: unknown) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      typeof body === "string"
        ? new Response(body, { status })
        : Response.json(body, { status }),
    );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Resend provider", () => {
  it("is set up by RESEND_API_KEY alone", () => {
    expect(resend.setup(ENV)).toBe("settings");
    expect(resend.configured(ENV)).toBe(true);
    expect(resend.setup({ RESEND_API_KEY: " " })).toBeNull();
    expect(resend.configured({ EMAIL: { send: vi.fn() } })).toBe(false);
    expect(resend.settings).toEqual(["RESEND_API_KEY"]);
  });

  it("posts the message to /emails with the key, as JSON, with a User-Agent", async () => {
    const fetchMock = answer(200, {
      id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    });
    await expect(resend.send(ENV, MESSAGE)).resolves.toEqual({
      messageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
      status: "delivered",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
      "User-Agent": "every-app-gateway",
    });
    // Empty fields are left out.
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Support <support@mail.example.com>",
      to: ["a@example.net"],
      subject: "Re: hello",
      text: "Hi",
    });
  });

  it("sends every field in Resend's shape: lists, reply_to, headers, base64 attachments", async () => {
    const fetchMock = answer(200, { id: "m-2" });
    await resend.send(ENV, {
      from: { address: "orders@mail.example.com", name: 'Acme, Inc. "Orders"' },
      to: ["a@example.net", "b@example.net"],
      cc: ["c@example.net"],
      bcc: ["d@example.net"],
      subject: "Your order",
      text: "Shipped.",
      html: '<p>Shipped.</p><img src="cid:logo">',
      replyTo: { address: "help@mail.example.com" },
      headers: { "In-Reply-To": "<prev@example.net>", "X-Entity-Ref-ID": "42" },
      attachments: [
        {
          filename: "invoice.pdf",
          contentType: "application/pdf",
          content: "JVBERi0xLjQK",
          disposition: "attachment",
        },
        {
          filename: "logo.png",
          contentType: "image/png",
          content: "iVBORw0KGgo=",
          disposition: "inline",
          contentId: "logo",
        },
      ],
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      // A name with specials is quoted, its quotes escaped.
      from: '"Acme, Inc. \\"Orders\\"" <orders@mail.example.com>',
      to: ["a@example.net", "b@example.net"],
      cc: ["c@example.net"],
      bcc: ["d@example.net"],
      reply_to: "help@mail.example.com",
      subject: "Your order",
      html: '<p>Shipped.</p><img src="cid:logo">',
      text: "Shipped.",
      headers: { "In-Reply-To": "<prev@example.net>", "X-Entity-Ref-ID": "42" },
      attachments: [
        {
          filename: "invoice.pdf",
          content: "JVBERi0xLjQK",
          content_type: "application/pdf",
        },
        {
          filename: "logo.png",
          content: "iVBORw0KGgo=",
          content_type: "image/png",
          content_id: "logo",
        },
      ],
    });
  });

  it("answers delivered without an id when Resend's body is unreadable", async () => {
    answer(200, "not json");
    await expect(resend.send(ENV, MESSAGE)).resolves.toEqual({
      status: "delivered",
    });
  });

  // Resend's documented errors (https://resend.com/docs/api-reference/errors),
  // what the provider throws, and the refusal the capability makes of it.
  it.each([
    [
      "an unverified domain",
      403,
      "validation_error",
      "The mail.example.com domain is not verified. Please, add and verify your domain on https://resend.com/domains",
      "E_SENDER_NOT_VERIFIED",
      422,
      "email_sender_not_verified",
    ],
    [
      "a testing-only account",
      403,
      "validation_error",
      "You can only send testing emails to your own email address (owner@example.org). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.",
      "E_SENDER_NOT_VERIFIED",
      422,
      "email_sender_not_verified",
    ],
    [
      "the rate limit",
      429,
      "rate_limit_exceeded",
      "Too many requests. Please limit the number of requests per second.",
      "E_RATE_LIMIT_EXCEEDED",
      429,
      "email_provider_limited",
    ],
    [
      "the daily quota",
      429,
      "daily_quota_exceeded",
      "You have exceeded your daily email sending quota.",
      "E_RATE_LIMIT_EXCEEDED",
      429,
      "email_provider_limited",
    ],
    [
      "the monthly quota",
      429,
      "monthly_quota_exceeded",
      "You have exceeded your monthly email sending quota.",
      "E_RATE_LIMIT_EXCEEDED",
      429,
      "email_provider_limited",
    ],
    [
      "a field it won't take",
      400,
      "validation_error",
      "Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
      "E_VALIDATION_ERROR",
      400,
      "email_invalid_message",
    ],
    [
      "a bad attachment",
      422,
      "invalid_attachment",
      "Attachment must have either a `content` or `path`.",
      "E_VALIDATION_ERROR",
      400,
      "email_invalid_message",
    ],
    [
      "a missing field",
      422,
      "missing_required_field",
      "The request body is missing one or more required fields.",
      "E_VALIDATION_ERROR",
      400,
      "email_invalid_message",
    ],
    [
      "its own failure",
      500,
      "application_error",
      "An unexpected error occurred.",
      "application_error",
      502,
      "email_send_failed",
    ],
    [
      "an outage",
      503,
      "service_unavailable",
      "API is temporarily unavailable",
      "service_unavailable",
      502,
      "email_send_failed",
    ],
  ])(
    "maps %s (%i %s)",
    async (_case, status, name, message, providerCode, refusalStatus, code) => {
      answer(status, { statusCode: status, name, message });
      const error = await resend.send(ENV, MESSAGE).catch((caught) => caught);
      expect(error).toMatchObject({
        name: "EmailDeliveryError",
        code: "EMAIL_SEND_FAILED",
        provider: "resend",
        providerCode,
      });
      expect((error as Error).message).toContain(`HTTP ${status}`);
      // What is logged never names an address.
      expect((error as Error).message).not.toMatch(/owner@example\.org/);
      expect(
        emailProviderRefusal(providerCode, "mail.example.com", "resend"),
      ).toMatchObject({ status: refusalStatus, code });
    },
  );

  it.each([
    [401, "missing_api_key", "Missing API Key"],
    [400, "validation_error", "API key is invalid"],
    [401, "validation_error", "API key is invalid"],
    [403, "restricted_api_key", "API key is not active"],
    [403, "suspended_api_key", "This API key is suspended"],
  ])("says Resend refused the key on %i %s", async (status, name, message) => {
    answer(status, { statusCode: status, name, message });
    await expect(resend.send(ENV, MESSAGE)).rejects.toMatchObject({
      code: "EMAIL_SEND_FAILED",
      provider: "resend",
      providerCode: name,
      message: expect.stringMatching(
        /^Resend refused the API key .*Check RESEND_API_KEY on the gateway\.$/,
      ),
    });
  });

  it("fails with the status when Resend's error isn't JSON, or Resend can't be reached", async () => {
    answer(502, "<html>Bad gateway</html>");
    await expect(resend.send(ENV, MESSAGE)).rejects.toMatchObject({
      code: "EMAIL_SEND_FAILED",
      providerCode: undefined,
      message: "Resend failed to send the message (HTTP 502)",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(resend.send(ENV, MESSAGE)).rejects.toMatchObject({
      code: "EMAIL_SEND_FAILED",
      provider: "resend",
      message: "Resend couldn't be reached.",
    });
  });

  it("sends nothing without a key", async () => {
    const fetchMock = answer(200, { id: "never" });
    await expect(resend.send({}, MESSAGE)).rejects.toMatchObject({
      code: "EMAIL_BINDING_UNAVAILABLE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
