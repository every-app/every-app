/**
 * Cloudflare Email Sending, through either of its two transports: the REST
 * API when EMAIL_REST_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are both set (a
 * gateway outside Workers: Docker's local binding only writes .eml files),
 * otherwise the Worker's EMAIL `send_email` binding. Sending domains are
 * onboarded in the gateway's Cloudflare account
 * (docs/runbooks/email-sending-setup.md).
 */
import {
  EMAIL_PROVIDER_LABELS,
  emailRestBody,
  emailRestUrl,
  readEmailRestResponse,
  type EmailAddressInput,
} from "@every-app/sdk/internal";
import { EmailDeliveryError } from "../errors";
import type {
  EmailProvider,
  EmailProviderEnv,
  OutboundEmail,
  SendEmailResult,
} from "./types";

function restConfiguration(env: EmailProviderEnv): {
  accountId: string;
  apiToken: string;
} | null {
  const apiToken = env.EMAIL_REST_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  return apiToken && accountId ? { accountId, apiToken } : null;
}

/**
 * The EMAIL binding, when it can send. The generated Env type declares
 * EMAIL, but deployed/self-hosted configs can still omit it; the runtime
 * guard lets auth initialize everywhere.
 */
function emailBinding(env: EmailProviderEnv): SendEmail | null {
  const binding = env.EMAIL as SendEmail | undefined;
  return binding && typeof binding.send === "function" ? binding : null;
}

function providerErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (typeof error.code === "string" || typeof error.code === "number")
  ) {
    return String(error.code);
  }
  return undefined;
}

function asDeliveryError(error: unknown): EmailDeliveryError {
  if (error instanceof EmailDeliveryError) return error;
  const providerCode = providerErrorCode(error);
  const suffix = providerCode ? ` (${providerCode})` : "";
  return new EmailDeliveryError(
    "EMAIL_SEND_FAILED",
    `Cloudflare Email Service failed to send the message${suffix}.`,
    {
      cause: error,
      provider: "cloudflare",
      ...(providerCode ? { providerCode } : {}),
    },
  );
}

async function sendWithRest(
  message: OutboundEmail,
  configuration: { accountId: string; apiToken: string },
): Promise<SendEmailResult> {
  const response = await fetch(emailRestUrl(configuration.accountId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${configuration.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      emailRestBody({
        to: [...message.to],
        cc: [...message.cc],
        bcc: [...message.bcc],
        subject: message.subject,
        ...(message.text ? { text: message.text } : {}),
        ...(message.html ? { html: message.html } : {}),
        from: message.from,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        ...(message.attachments
          ? { attachments: [...message.attachments] }
          : {}),
      }),
    ),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // The HTTP status below still determines whether this send failed.
  }

  const result = readEmailRestResponse(response.status, body);
  if (!result.ok) {
    throw Object.assign(
      new Error(result.message),
      result.providerCode === undefined ? {} : { code: result.providerCode },
    );
  }
  return {
    status: result.status,
    ...(result.messageId ? { messageId: result.messageId } : {}),
  };
}

async function sendWithBinding(
  binding: SendEmail,
  message: OutboundEmail,
): Promise<SendEmailResult> {
  const { to, cc, bcc } = message;
  const address = (value: EmailAddressInput) =>
    value.name ? { email: value.address, name: value.name } : value.address;
  const result = (await binding.send({
    to: to.length === 1 ? to[0]! : [...to],
    ...(cc.length > 0 ? { cc: [...cc] } : {}),
    ...(bcc.length > 0 ? { bcc: [...bcc] } : {}),
    from: address(message.from),
    ...(message.replyTo ? { replyTo: address(message.replyTo) } : {}),
    subject: message.subject,
    ...(message.html ? { html: message.html } : {}),
    ...(message.text ? { text: message.text } : {}),
    ...(message.headers && Object.keys(message.headers).length > 0
      ? { headers: message.headers }
      : {}),
    ...(message.attachments && message.attachments.length > 0
      ? {
          attachments: message.attachments.map((attachment) =>
            attachment.disposition === "inline"
              ? {
                  disposition: "inline" as const,
                  contentId: attachment.contentId ?? attachment.filename,
                  filename: attachment.filename,
                  type: attachment.contentType,
                  content: attachment.content,
                }
              : {
                  disposition: "attachment" as const,
                  filename: attachment.filename,
                  type: attachment.contentType,
                  content: attachment.content,
                },
          ),
        }
      : {}),
  })) as EmailSendResult | undefined;
  // Older local simulators resolve without a result.
  return {
    status: "delivered",
    ...(result?.messageId ? { messageId: result.messageId } : {}),
  };
}

export const cloudflareEmailProvider: EmailProvider = {
  id: "cloudflare",
  label: EMAIL_PROVIDER_LABELS.cloudflare,
  // Or the EMAIL binding, which every gateway Worker declares.
  settings: ["EMAIL_REST_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  configured: (env) => cloudflareEmailProvider.setup(env) !== null,
  setup: (env) =>
    restConfiguration(env) ? "settings" : emailBinding(env) ? "binding" : null,
  async send(env, message) {
    try {
      // REST, when its pair is set, takes precedence over the binding.
      const rest = restConfiguration(env);
      if (rest) return await sendWithRest(message, rest);
      const binding = emailBinding(env);
      if (!binding) {
        throw new EmailDeliveryError(
          "EMAIL_BINDING_UNAVAILABLE",
          "Email delivery is unavailable because the EMAIL send_email binding is not configured.",
          { provider: "cloudflare" },
        );
      }
      return await sendWithBinding(binding, message);
    } catch (error) {
      throw asDeliveryError(error);
    }
  },
};
