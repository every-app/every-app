/**
 * `gatewayEmailBinding(env)`: the Gateway's `email` capability as a
 * `send_email` binding, for code written against `env.EMAIL.send(message)`.
 *
 * An app on Every App binds no `send_email` of its own: the Gateway sends
 * with its sender, checks `from` against the installation's senders and
 * keeps the mail budgets. Code that already calls `env.EMAIL.send()` gets
 * this object in its place:
 *
 *   const EMAIL = gatewayEmailBinding(env, { for: request });
 *   await EMAIL.send({ from, to, subject, text });
 *
 * Each `send()` is a `sendEmail()` (the manifest lists `capabilities: {
 * email: { access: "write" } }`), so local development works the same way:
 * checked and printed, or sent with the developer's own Email Sending
 * account (EMAIL_REST_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, EMAIL_FROM).
 */
import {
  ConfigurationError,
  type EmailAttachmentInput,
  type SendEmailMessage,
} from "../internal/index.js";
import type { GatewayCallFor } from "./attribution.js";
import { GatewayRefusalError } from "./refusal.js";
import { sendEmail } from "./sendEmail.js";

export interface GatewayEmailBindingOptions {
  /**
   * Whom the mail is for: the inbound request, or `{ background: true,
   * organizationId }` (sendEmail's `for`).
   */
  for?: GatewayCallFor;
}

/** `name <email>` or a bare address, as the binding takes them. */
type BindingAddress = string | { email: string; name?: string };
type BindingRecipients = BindingAddress | BindingAddress[];

/** The structured message `send_email`'s `send()` takes (`EmailMessageBuilder`). */
export interface GatewayEmailBindingMessage {
  from: BindingAddress;
  to?: BindingRecipients;
  cc?: BindingRecipients;
  bcc?: BindingRecipients;
  subject: string;
  replyTo?: BindingAddress;
  headers?: Record<string, string>;
  text?: string;
  html?: string;
  attachments?: {
    disposition?: "inline" | "attachment";
    contentId?: string;
    filename: string;
    type: string;
    content: string | ArrayBuffer | ArrayBufferView;
  }[];
}

/**
 * A `send_email` binding (`SendEmail`) over the Gateway: pass it where code
 * takes `env.EMAIL`. `send()` takes the structured message (`from`, `to`,
 * `cc`, `bcc`, `subject`, `text`, `html`, `replyTo`, `headers`,
 * `attachments`) and resolves `{ messageId }`. A raw MIME `EmailMessage`
 * (`new EmailMessage(from, to, raw)`) is refused with `GatewayRefusalError`
 * `email_invalid_message`: the Gateway takes structured mail only.
 *
 * Errors are sendEmail()'s: `GatewayRefusalError` with the Gateway's code
 * (`email_sender_not_allowed`, `email_budget_exhausted`,
 * `integration_not_configured`, …) and `ConfigurationError` with neither a
 * binding nor `everyapp dev`. Nothing is checked when the binding is made.
 */
export function gatewayEmailBinding(
  env: object,
  options: GatewayEmailBindingOptions = {},
): SendEmail {
  const binding = {
    async send(message: unknown): Promise<{ messageId: string }> {
      const result = await sendEmail({
        env,
        ...(options.for === undefined ? {} : { for: options.for }),
        message: toSendEmailMessage(message),
      });
      return { messageId: result.messageId ?? "" };
    },
  };
  // `SendEmail` is the app's own Workers types' interface, whose `send()`
  // overloads change with the version; this `send()` takes both forms.
  return binding as unknown as SendEmail;
}

/**
 * The binding's message as sendEmail()'s: recipients as bare addresses,
 * `from` and `replyTo` with their display names, attachments base64.
 */
export function toSendEmailMessage(message: unknown): SendEmailMessage {
  if (!message || typeof message !== "object") {
    throw new ConfigurationError("EMAIL.send() takes a message object.");
  }
  if (!("subject" in message)) {
    throw new GatewayRefusalError({
      status: 400,
      code: "email_invalid_message",
      message:
        "Raw MIME messages can't be sent through the Every App gateway; send a structured message ({ from, to, subject, text or html }).",
    });
  }
  const m = message as GatewayEmailBindingMessage;
  return {
    to: addresses(m.to) ?? [],
    ...(m.cc === undefined ? {} : { cc: addresses(m.cc) }),
    ...(m.bcc === undefined ? {} : { bcc: addresses(m.bcc) }),
    subject: m.subject,
    ...(m.text ? { text: m.text } : {}),
    ...(m.html ? { html: m.html } : {}),
    from: named(m.from),
    ...(m.replyTo ? { replyTo: named(m.replyTo) } : {}),
    ...(m.headers && Object.keys(m.headers).length > 0
      ? { headers: m.headers }
      : {}),
    ...(m.attachments?.length
      ? { attachments: m.attachments.map(attachment) }
      : {}),
  };
}

/**
 * One attachment in the Gateway's shape. An inline part without a content
 * id can't be referenced (and the Gateway refuses it), so it goes as an
 * ordinary attachment.
 */
function attachment(
  a: NonNullable<GatewayEmailBindingMessage["attachments"]>[number],
): EmailAttachmentInput {
  const contentId = a.contentId?.trim();
  return {
    filename: a.filename,
    contentType: a.type,
    content: base64(a.content),
    ...(a.disposition === "inline" && contentId
      ? { disposition: "inline", contentId }
      : {}),
  };
}

function named(address: BindingAddress): { address: string; name?: string } {
  if (typeof address === "string") return { address };
  return {
    address: address.email,
    ...(address.name?.trim() ? { name: address.name } : {}),
  };
}

function addresses(
  recipients: BindingRecipients | undefined,
): string | string[] | undefined {
  if (recipients === undefined) return undefined;
  const of = (a: BindingAddress) => (typeof a === "string" ? a : a.email);
  return Array.isArray(recipients) ? recipients.map(of) : of(recipients);
}

/** Strings are taken as base64 already, as the binding takes them; bytes are encoded. */
function base64(content: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof content === "string") return content;
  const bytes =
    content instanceof ArrayBuffer
      ? new Uint8Array(content)
      : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
