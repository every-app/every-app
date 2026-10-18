import { env } from "cloudflare:workers";
import {
  EMAIL_PROVIDER_LABELS,
  parseEmailSender,
  type CheckedEmailAttachment,
  type EmailAddressInput,
  type EmailProviderId,
} from "@every-app/sdk/internal";
import { type MailKind, platformPolicy } from "@/server/platform-policy";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";
import { EmailDeliveryError } from "./errors";
import { selectEmailProvider } from "./providers";
import type { SendEmailResult } from "./providers/types";

export type { SendEmailResult };

export type SendEmailOptions = {
  /** What the mail is for: each kind has its own daily budgets. */
  kind: MailKind;
  to: string | readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject: string;
  /** At least one of `text` and `html`. */
  text?: string;
  html?: string;
  /** Absent: the configured sender (EMAIL_FROM, EMAIL_FROM_NAME). */
  from?: EmailAddressInput;
  /** Absent: replies go to the sender. */
  replyTo?: EmailAddressInput;
  headers?: Record<string, string>;
  /** Base64 content, which every provider takes as is. */
  attachments?: readonly CheckedEmailAttachment[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ADDRESS_KEY_CONTEXT = "every-app-gateway:mail-recipient:v1";

type ConfiguredSender = { address: string; name: string };

/** The configured sender, or null when EMAIL_FROM (and a name) aren't set. */
export function configuredSender(): ConfiguredSender | null {
  return parseEmailSender(env.EMAIL_FROM, env.EMAIL_FROM_NAME);
}

function parseConfiguredSender(): ConfiguredSender {
  const sender = configuredSender();
  if (!sender) {
    throw new EmailDeliveryError(
      "EMAIL_SENDER_NOT_CONFIGURED",
      env.EMAIL_FROM?.trim()
        ? 'Email sender is not configured. Set EMAIL_FROM and EMAIL_FROM_NAME, or use EMAIL_FROM="Name <email@example.com>".'
        : "Email sender is not configured. Set EMAIL_FROM and EMAIL_FROM_NAME.",
    );
  }
  return sender;
}

/** A provider's unexpected throw, as the gateway's error. */
function asDeliveryError(
  error: unknown,
  provider: EmailProviderId | undefined,
): EmailDeliveryError {
  if (error instanceof EmailDeliveryError) return error;
  return new EmailDeliveryError(
    "EMAIL_SEND_FAILED",
    `${provider ? EMAIL_PROVIDER_LABELS[provider] : "The email provider"} failed to send the message.`,
    { cause: error, ...(provider ? { provider } : {}) },
  );
}

/** The recipients as lists, for the providers. */
function recipientLists(options: SendEmailOptions) {
  return {
    to: typeof options.to === "string" ? [options.to] : [...options.to],
    cc: [...(options.cc ?? [])],
    bcc: [...(options.bcc ?? [])],
  };
}

/**
 * Whether the gateway can attempt to send email at all: a sender is set and
 * a provider is selectable (providers/index.ts). Email is optional; without
 * it, invitations and password resets hand the admin a link to share
 * instead.
 */
export function isEmailConfigured(): boolean {
  return configuredEmailProvider() !== null;
}

/** The provider mail goes out with, or null when the gateway can't send. */
export function configuredEmailProvider(): EmailProviderId | null {
  if (!configuredSender()) return null;
  const selected = selectEmailProvider(env);
  return "provider" in selected ? selected.provider.id : null;
}

/**
 * The recipient as a counter key: an HMAC of the address, so the counters
 * table never holds anyone's email (nor do logs that name a recipient).
 */
export async function recipientKey(address: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `${ADDRESS_KEY_CONTEXT}:${address.trim().toLowerCase()}`,
    ),
  );
  return [...new Uint8Array(signature)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Count this mail against its kind's daily budgets (platformPolicy's
 * mailDaily), once for each distinct recipient: to that address, and for
 * the whole gateway, in D1 (`rate_limit_counters`) so they hold across
 * isolates. Counted before it is sent, so a send that fails still counts:
 * a flood of failures is bounded too. A budget that can't be read or
 * written refuses the mail; one any recipient has spent refuses all of it.
 */
async function spendMailBudget(
  kind: MailKind,
  recipients: readonly string[],
  now = new Date(),
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const dayEnds = new Date(Date.parse(day) + DAY_MS);
  const gatewayKey = `mail:${kind}:gateway:${day}`;
  const addresses = [
    ...new Set(recipients.map((address) => address.trim().toLowerCase())),
  ];
  const addressKeys = await Promise.all(
    addresses.map(
      async (address) =>
        `mail:${kind}:to:${await recipientKey(address)}:${day}`,
    ),
  );
  const { perAddress, perGateway } = platformPolicy(env).mailDaily[kind];

  let counts: Map<string, number>;
  try {
    counts = await RateLimitCounterRepository.read(
      [gatewayKey, ...addressKeys],
      now,
    );
  } catch (error) {
    throw new EmailDeliveryError(
      "EMAIL_BUDGET_UNAVAILABLE",
      "The gateway couldn't check its email budget, so nothing was sent.",
      { cause: error },
    );
  }
  const exhausted =
    (counts.get(gatewayKey) ?? 0) + addressKeys.length > perGateway
      ? "gateway"
      : addressKeys.some((key) => (counts.get(key) ?? 0) >= perAddress)
        ? "address"
        : null;
  if (exhausted) {
    throw new EmailDeliveryError(
      "EMAIL_BUDGET_EXHAUSTED",
      exhausted === "gateway"
        ? `The gateway has sent all the ${kind} emails it may today. Try again tomorrow.`
        : addressKeys.length === 1
          ? `This address has been sent all the ${kind} emails it may get today. Try again tomorrow.`
          : `A recipient has been sent all the ${kind} emails they may get today, so nothing was sent. Try again tomorrow.`,
      { retryAt: dayEnds },
    );
  }
  try {
    // The gateway's count goes up once for each recipient.
    await RateLimitCounterRepository.increment(
      [...addressKeys.map(() => gatewayKey), ...addressKeys],
      dayEnds,
    );
  } catch (error) {
    throw new EmailDeliveryError(
      "EMAIL_BUDGET_UNAVAILABLE",
      "The gateway couldn't record its email budget, so nothing was sent.",
      { cause: error },
    );
  }
}

/**
 * Send one email, within its kind's daily budgets, through the selected
 * provider. Throws an EmailDeliveryError (logged here) when email isn't
 * configured, a budget is spent or the provider refuses.
 */
export async function sendEmail(
  options: SendEmailOptions,
): Promise<SendEmailResult> {
  const { to, cc, bcc } = recipientLists(options);
  let provider: EmailProviderId | undefined;
  try {
    const selected = selectEmailProvider(env);
    if (!("provider" in selected)) {
      throw new EmailDeliveryError(
        "EMAIL_BINDING_UNAVAILABLE",
        selected.message,
      );
    }
    provider = selected.provider.id;
    const from = options.from ?? parseConfiguredSender();
    await spendMailBudget(options.kind, [...to, ...cc, ...bcc]);
    return await selected.provider.send(env, {
      from,
      to,
      cc,
      bcc,
      subject: options.subject,
      ...(options.text ? { text: options.text } : {}),
      ...(options.html ? { html: options.html } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
    });
  } catch (error) {
    const deliveryError = asDeliveryError(error, provider);

    console.error("Email delivery failed", {
      event: "email.send.failed",
      kind: options.kind,
      provider: deliveryError.provider ?? provider,
      code: deliveryError.code,
      providerCode: deliveryError.providerCode,
      message: deliveryError.message,
    });

    throw deliveryError;
  }
}
