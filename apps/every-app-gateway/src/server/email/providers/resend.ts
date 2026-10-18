/**
 * Resend (https://resend.com/docs/api-reference/emails/send-email): one
 * POST per message, with the gateway's RESEND_API_KEY. Sending domains,
 * the gateway's and the apps', are verified in the gateway's Resend
 * account (docs/runbooks/email-sending-setup.md, "Resend"). Resend's errors
 * map onto the `E_*` codes emailProviderRefusal() already reads, so an app
 * gets the same refusals whichever provider the gateway uses.
 */
import {
  EMAIL_PROVIDER_LABELS,
  type EmailAddressInput,
} from "@every-app/sdk/internal";
import { EmailDeliveryError } from "../errors";
import type {
  EmailProvider,
  EmailProviderEnv,
  OutboundEmail,
  SendEmailResult,
} from "./types";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

/** Resend's error names for a key it won't take. */
const API_KEY_ERRORS = new Set([
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
  "suspended_api_key",
  "invalid_permission",
]);
/** Resend's error names for a spent rate or quota. */
const LIMIT_ERRORS = new Set([
  "rate_limit_exceeded",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
]);
/** RFC 5322 specials: a display name with one is quoted. */
const SPECIALS = /[()<>[\]:;@\\,."]/;
/** An address in Resend's message ("only send testing emails to your own email address (…)"). */
const ADDRESS_IN_TEXT = /[^\s<>()"'`,;]+@[^\s<>()"'`,;]+/g;

function apiKey(env: EmailProviderEnv): string | null {
  return env.RESEND_API_KEY?.trim() || null;
}

/** `Name <address>`, or the address alone; the name quoted when it must be. */
function resendAddress(value: EmailAddressInput): string {
  if (!value.name) return value.address;
  const name = SPECIALS.test(value.name)
    ? `"${value.name.replace(/(["\\])/g, "\\$1")}"`
    : value.name;
  return `${name} <${value.address}>`;
}

/** A message as Resend's `POST /emails` takes it: snake_case, empty fields left out. */
function resendEmailBody(message: OutboundEmail): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: resendAddress(message.from),
    to: [...message.to],
    subject: message.subject,
  };
  if (message.cc.length > 0) body["cc"] = [...message.cc];
  if (message.bcc.length > 0) body["bcc"] = [...message.bcc];
  if (message.replyTo) body["reply_to"] = resendAddress(message.replyTo);
  if (message.html) body["html"] = message.html;
  if (message.text) body["text"] = message.text;
  if (message.headers && Object.keys(message.headers).length > 0) {
    body["headers"] = message.headers;
  }
  if (message.attachments && message.attachments.length > 0) {
    body["attachments"] = message.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      content_type: attachment.contentType,
      // Resend has no disposition: a content id makes it inline (`cid:`).
      ...(attachment.disposition === "inline"
        ? { content_id: attachment.contentId ?? attachment.filename }
        : {}),
    }));
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resend's error (`{ statusCode, name, message }`) as the gateway's: a
 * domain it won't send from is `E_SENDER_NOT_VERIFIED`, a spent rate or
 * quota `E_RATE_LIMIT_EXCEEDED`, any other malformed request
 * `E_VALIDATION_ERROR`; a refused key, and anything else, keep Resend's
 * name. The message, which is logged, never names an address.
 */
function resendError(status: number, body: unknown): EmailDeliveryError {
  const fields = isRecord(body) ? body : {};
  const name = typeof fields["name"] === "string" ? fields["name"] : undefined;
  const text =
    typeof fields["message"] === "string"
      ? fields["message"].replace(ADDRESS_IN_TEXT, "<address>").slice(0, 300)
      : "";
  const detail = `(${name ? `${name}, ` : ""}HTTP ${status})${text ? `: ${text}` : ""}`;
  const failure = (providerCode: string | undefined, message: string) =>
    new EmailDeliveryError("EMAIL_SEND_FAILED", message, {
      provider: "resend",
      ...(providerCode ? { providerCode } : {}),
    });

  if (status === 429 || (name && LIMIT_ERRORS.has(name))) {
    return failure(
      "E_RATE_LIMIT_EXCEEDED",
      `Resend refused the message: the account has reached its sending limit ${detail}`,
    );
  }
  if ((status === 403 || name === "validation_error") && /domain/i.test(text)) {
    return failure(
      "E_SENDER_NOT_VERIFIED",
      `Resend won't send from the sender's domain ${detail}`,
    );
  }
  if (
    status === 401 ||
    (name && API_KEY_ERRORS.has(name)) ||
    /api key/i.test(text)
  ) {
    return failure(
      name,
      `Resend refused the API key ${detail}. Check RESEND_API_KEY on the gateway.`,
    );
  }
  if (status === 400 || status === 422) {
    return failure(
      "E_VALIDATION_ERROR",
      `Resend refused the message as invalid ${detail}`,
    );
  }
  return failure(name, `Resend failed to send the message ${detail}`);
}

async function send(
  env: EmailProviderEnv,
  message: OutboundEmail,
): Promise<SendEmailResult> {
  const key = apiKey(env);
  if (!key) {
    throw new EmailDeliveryError(
      "EMAIL_BINDING_UNAVAILABLE",
      "Email delivery through Resend is unavailable because RESEND_API_KEY is not set.",
      { provider: "resend" },
    );
  }
  let response: Response;
  try {
    response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Resend refuses a request without one (403).
        "User-Agent": "every-app-gateway",
      },
      body: JSON.stringify(resendEmailBody(message)),
    });
  } catch (error) {
    throw new EmailDeliveryError(
      "EMAIL_SEND_FAILED",
      "Resend couldn't be reached.",
      { cause: error, provider: "resend" },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // The HTTP status still says whether it was sent.
  }
  if (!response.ok) throw resendError(response.status, body);
  const id = isRecord(body) && typeof body["id"] === "string" ? body["id"] : "";
  return { status: "delivered", ...(id ? { messageId: id } : {}) };
}

export const resendEmailProvider: EmailProvider = {
  id: "resend",
  label: EMAIL_PROVIDER_LABELS.resend,
  settings: ["RESEND_API_KEY"],
  configured: (env) => apiKey(env) !== null,
  setup: (env) => (apiKey(env) ? "settings" : null),
  send,
};
