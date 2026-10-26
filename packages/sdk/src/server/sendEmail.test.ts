import { afterEach, describe, expect, vi } from "vitest";
import { it } from "../../test/inOrganization";
import { ConfigurationError } from "../internal/index";
import { AttributionError } from "./attribution";
import { GatewayRefusalError } from "./integrationFetch";
import { sendEmail } from "./sendEmail";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const MESSAGE = {
  to: "customer@example.net",
  subject: "Your order",
  text: "It shipped.",
};

function gateway(
  response: () => Response = () =>
    Response.json({ messageId: "<m1@example.com>", status: "delivered" }),
) {
  const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
    async () => response(),
  );
  return { env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } }, bindingFetch };
}

describe("sendEmail through the gateway", () => {
  it("posts the message to the email route with the request's identity", async () => {
    const { env, bindingFetch } = gateway();
    const message = {
      ...MESSAGE,
      from: { address: "support@mail.example.com", name: "Support" },
      headers: { "In-Reply-To": "<prev@example.net>" },
    };

    await expect(
      sendEmail({
        env,
        for: new Request("https://shop.example.com/orders", {
          headers: { "x-everyapp-identity": "signed-user-identity" },
        }),
        message,
      }),
    ).resolves.toEqual({ messageId: "<m1@example.com>", status: "delivered" });

    const sent = bindingFetch.mock.calls[0]![0];
    expect(sent.url).toBe(
      "http://every-app-gateway.internal/api/integrations/email/send",
    );
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(sent.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
    await expect(sent.json()).resolves.toEqual(message);
  });

  it("names the organization for a shared app's background mail", async () => {
    const { env, bindingFetch } = gateway();
    await sendEmail({
      env: { ...env, EVERYAPP_SHARED: "1" },
      for: { background: true, organizationId: "org-acme" },
      message: MESSAGE,
    });
    const sent = bindingFetch.mock.calls[0]![0];
    expect(sent.headers.get("x-everyapp-org")).toBe("org-acme");
    expect(sent.headers.get("x-everyapp-identity")).toBeNull();
  });

  it("refuses a shared app's mail that doesn't say whom it is for, before calling", async () => {
    const { env, bindingFetch } = gateway();
    await expect(
      sendEmail({
        env: { ...env, EVERYAPP_SHARED: "1" },
        for: { background: true },
        message: MESSAGE,
      }),
    ).rejects.toBeInstanceOf(AttributionError);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("throws the gateway's refusal as a GatewayRefusalError", async () => {
    const { env } = gateway(() =>
      Response.json(
        {
          error: "Too Many Requests",
          code: "email_budget_exhausted",
          message:
            "This address has been sent all the app emails it may get today.",
        },
        {
          status: 429,
          headers: { "x-everyapp-error": "email_budget_exhausted" },
        },
      ),
    );
    const refused = await sendEmail({ env, message: MESSAGE }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(GatewayRefusalError);
    expect(refused).toMatchObject({
      name: "GatewayRefusalError",
      status: 429,
      code: "email_budget_exhausted",
      message:
        "This address has been sent all the app emails it may get today.",
    });
  });

  it("throws on a failure that isn't a refusal", async () => {
    const { env } = gateway(() => new Response("boom", { status: 500 }));
    await expect(sendEmail({ env, message: MESSAGE })).rejects.toMatchObject({
      status: 500,
      code: "email_send_failed",
    });
  });

  it("refuses a binding that isn't one", async () => {
    await expect(
      sendEmail({ env: { EVERY_APP_GATEWAY: {} }, message: MESSAGE }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("refuses a deployed-shaped env with no binding, even with REST settings", async () => {
    await expect(
      sendEmail({
        env: {
          EMAIL_REST_API_TOKEN: "token",
          CLOUDFLARE_ACCOUNT_ID: "acc",
          EMAIL_FROM: "noreply@example.com",
        },
        message: MESSAGE,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe("sendEmail in local dev", () => {
  const DEV = {
    EVERYAPP_DEV: "1",
    EVERYAPP_EMAIL_SENDERS: '["*@mail.example.com"]',
  };

  it("prints the mail and sends nothing without the REST settings", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await sendEmail({
      env: DEV,
      message: { ...MESSAGE, cc: ["a@example.net"], bcc: "b@example.net" },
    });

    expect(result.status).toBe("logged");
    expect(result.messageId).toMatch(/^dev-[0-9a-f-]{36}$/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[everyapp dev\] email to 3 recipients subject "Your order"/,
      ),
    );
    // The body is the developer's business, not the console's.
    expect(info.mock.calls[0]![0]).not.toContain("It shipped.");
  });

  it("sends through Email Sending's REST API with the developer's own account", async () => {
    const fetchMock = vi.fn<
      (url: string, init: RequestInit) => Promise<Response>
    >(async () =>
      Response.json({
        success: true,
        errors: [],
        result: {
          message_id: "<rest-1@example.com>",
          delivered: ["customer@example.net"],
          queued: [],
          permanent_bounces: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendEmail({
      env: {
        ...DEV,
        EMAIL_REST_API_TOKEN: "dev-token",
        CLOUDFLARE_ACCOUNT_ID: "dev-account",
        EMAIL_FROM: "noreply@example.com",
      },
      message: {
        ...MESSAGE,
        replyTo: "help@example.com",
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            content: "JVBERi0xLjQK",
          },
        ],
      },
    });

    expect(result).toEqual({
      messageId: "<rest-1@example.com>",
      status: "delivered",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/dev-account/email/sending/send",
    );
    expect(init.headers).toEqual({
      authorization: "Bearer dev-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      to: "customer@example.net",
      // EMAIL_FROM alone: the developer's address, no name needed.
      from: "noreply@example.com",
      reply_to: "help@example.com",
      subject: "Your order",
      text: "It shipped.",
      attachments: [
        {
          content: "JVBERi0xLjQK",
          filename: "invoice.pdf",
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    });
  });

  it("sends from an allowed sender, and maps the provider's refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            errors: [{ code: 10004, message: "email.sending.error.throttled" }],
            result: null,
          },
          { status: 429 },
        ),
      ),
    );
    await expect(
      sendEmail({
        env: {
          ...DEV,
          EMAIL_REST_API_TOKEN: "dev-token",
          CLOUDFLARE_ACCOUNT_ID: "dev-account",
          EMAIL_FROM: "EveryApp <noreply@example.com>",
        },
        message: { ...MESSAGE, from: "support@mail.example.com" },
      }),
    ).rejects.toMatchObject({
      name: "GatewayRefusalError",
      status: 429,
      code: "email_provider_limited",
    });
  });

  it("refuses a sender .dev.vars doesn't list, as the gateway does", async () => {
    await expect(
      sendEmail({
        env: DEV,
        message: { ...MESSAGE, from: { address: "ceo@other.example" } },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "email_sender_not_allowed",
      message: expect.stringContaining("EVERYAPP_EMAIL_SENDERS in .dev.vars"),
    });
    // A subdomain of a listed domain is another domain.
    await expect(
      sendEmail({
        env: DEV,
        message: { ...MESSAGE, from: "x@sub.mail.example.com" },
      }),
    ).rejects.toMatchObject({ code: "email_sender_not_allowed" });
  });

  it("refuses every sender when .dev.vars sets none", async () => {
    await expect(
      sendEmail({
        env: { EVERYAPP_DEV: "1" },
        message: { ...MESSAGE, from: "support@mail.example.com" },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "email_sender_not_allowed",
    });
  });

  it("refuses an invalid message, as the gateway does", async () => {
    await expect(
      sendEmail({
        env: DEV,
        message: { to: "nobody", subject: "x", text: "y" },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "email_invalid_message",
      message: expect.stringContaining("to[0] isn't an email address"),
    });
  });
});
