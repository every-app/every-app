import { afterEach, describe, expect, vi } from "vitest";
import { it } from "../../test/inOrganization";
import { ConfigurationError } from "../internal/index";
import {
  gatewayEmailBinding,
  type GatewayEmailBindingMessage,
  type GatewayEmailBindingOptions,
} from "./emailBinding";
import { GatewayRefusalError } from "./refusal";

afterEach(() => {
  vi.restoreAllMocks();
});

function gateway(
  response: () => Response = () =>
    Response.json({ messageId: "<m1@example.com>", status: "delivered" }),
) {
  const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
    async () => response(),
  );
  return { env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } }, bindingFetch };
}

/**
 * The binding as an app's runtime types see it (`send(builder)`); the SDK
 * builds against older Workers types whose SendEmail takes raw MIME only.
 */
function binding(env: object, options?: GatewayEmailBindingOptions) {
  return gatewayEmailBinding(env, options) as unknown as {
    send(message: GatewayEmailBindingMessage): Promise<{ messageId: string }>;
  };
}

describe("gatewayEmailBinding", () => {
  it("is a SendEmail: assignable where env.EMAIL is expected, with no cast", () => {
    const EMAIL: SendEmail = gatewayEmailBinding({});
    const withEmail: { EMAIL: SendEmail } = {
      EMAIL: gatewayEmailBinding(gateway().env),
    };
    expect(typeof EMAIL.send).toBe("function");
    expect(typeof withEmail.EMAIL.send).toBe("function");
  });

  it("sends the binding's message through the gateway's email route, for the request", async () => {
    const { env, bindingFetch } = gateway();
    const EMAIL = binding(env, {
      for: new Request("https://inbox.example.com/api/send", {
        headers: { "x-everyapp-identity": "signed-user-identity" },
      }),
    });

    const result = await EMAIL.send({
      from: { email: "support@mail.example.com", name: "Support" },
      to: [{ email: "customer@example.net", name: "Pat" }, "ops@example.net"],
      cc: "lead@example.net",
      replyTo: "replies@mail.example.com",
      subject: "Your order",
      text: "It shipped.",
      html: "<p>It shipped.</p>",
      headers: { "In-Reply-To": "<prev@example.net>" },
      attachments: [
        {
          disposition: "attachment",
          filename: "a.txt",
          type: "text/plain",
          content: new TextEncoder().encode("hi"),
        },
        {
          disposition: "inline",
          contentId: "logo",
          filename: "logo.png",
          type: "image/png",
          content: "iVBORw0K",
        },
      ],
    });

    expect(result).toEqual({ messageId: "<m1@example.com>" });
    const sent = bindingFetch.mock.calls[0]![0];
    expect(sent.url).toBe(
      "http://every-app-gateway.internal/api/integrations/email/send",
    );
    expect(sent.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
    await expect(sent.json()).resolves.toEqual({
      to: ["customer@example.net", "ops@example.net"],
      cc: "lead@example.net",
      subject: "Your order",
      text: "It shipped.",
      html: "<p>It shipped.</p>",
      from: { address: "support@mail.example.com", name: "Support" },
      replyTo: { address: "replies@mail.example.com" },
      headers: { "In-Reply-To": "<prev@example.net>" },
      attachments: [
        { filename: "a.txt", contentType: "text/plain", content: "aGk=" },
        {
          filename: "logo.png",
          contentType: "image/png",
          content: "iVBORw0K",
          disposition: "inline",
          contentId: "logo",
        },
      ],
    });
  });

  it("throws the gateway's refusal with its code", async () => {
    const { env } = gateway(
      () =>
        new Response(
          JSON.stringify({ message: "That sender isn't allowed." }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "x-everyapp-error": "email_sender_not_allowed",
            },
          },
        ),
    );
    await expect(
      binding(env).send({
        from: "someone@else.example",
        to: "customer@example.net",
        subject: "Hi",
        text: "Hi",
      }),
    ).rejects.toMatchObject({
      name: "GatewayRefusalError",
      code: "email_sender_not_allowed",
      status: 403,
    });
  });

  it("refuses a raw MIME message without calling the gateway", async () => {
    const { env, bindingFetch } = gateway();
    const raw = { from: "a@example.com", to: "b@example.net" } as EmailMessage;
    const error = await gatewayEmailBinding(env)
      .send(raw)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayRefusalError);
    expect(error).toMatchObject({ code: "email_invalid_message" });
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("prints the mail under everyapp dev, and throws ConfigurationError with neither", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await binding({
      EVERYAPP_DEV: "1",
      EVERYAPP_EMAIL_SENDERS: "app@example.com",
    }).send({
      from: "app@example.com",
      to: "customer@example.net",
      subject: "Hi",
      text: "Hi",
    });
    expect(result).toMatchObject({ messageId: expect.stringMatching(/^dev-/) });
    expect(info).toHaveBeenCalled();

    await expect(
      binding({}).send({
        from: "app@example.com",
        to: "customer@example.net",
        subject: "Hi",
        text: "Hi",
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
