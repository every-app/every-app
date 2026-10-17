import { env } from "cloudflare:workers";
import {
  emailRestBody,
  emailRestUrl,
  parseEmailSender,
  readEmailRestResponse,
  type CheckedEmailAttachment,
  type EmailAddressInput,
} from "@every-app/sdk/internal";
import { type MailKind, platformPolicy } from "@/server/platform-policy";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";

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
  /** Base64 content, which both transports take as is. */
  attachments?: readonly CheckedEmailAttachment[];
};

/** What Email Sending said: accepted (and delivered), or queued for some recipients. */
export type SendEmailResult = {
  messageId?: string;
  status: "delivered" | "queued";
};

type EmailDeliveryErrorCode =
  | "EMAIL_BINDING_UNAVAILABLE"
  | "EMAIL_SENDER_NOT_CONFIGURED"
  | "EMAIL_SEND_FAILED"
  | "EMAIL_BUDGET_EXHAUSTED"
  | "EMAIL_BUDGET_UNAVAILABLE";

const DAY_MS = 24 * 60 * 60 * 1000;
const ADDRESS_KEY_CONTEXT = "every-app-gateway:mail-recipient:v1";

class EmailDeliveryError extends Error {
  readonly code: EmailDeliveryErrorCode;
  /** Email Sending's own code (`E_SENDER_NOT_VERIFIED`, `10004`, ...), when it gave one. */
  readonly providerCode: string | undefined;
  /** When a spent budget refills: the next UTC midnight. */
  readonly retryAt: Date | undefined;

  constructor(
    code: EmailDeliveryErrorCode,
    message: string,
    options?: ErrorOptions & { providerCode?: string; retryAt?: Date },
  ) {
    super(message, options);
    this.name = "EmailDeliveryError";
    this.code = code;
    this.providerCode = options?.providerCode;
    this.retryAt = options?.retryAt;
  }
}

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

function requireEmailBinding(): SendEmail {
  // The generated Env type declares EMAIL, but deployed/self-hosted configs can
  // still omit it. Keep the runtime guard so auth can initialize everywhere.
  const binding = env.EMAIL as SendEmail | undefined;

  if (!binding || typeof binding.send !== "function") {
    throw new EmailDeliveryError(
      "EMAIL_BINDING_UNAVAILABLE",
      "Email delivery is unavailable because the EMAIL send_email binding is not configured.",
    );
  }

  return binding;
}

function getRestConfiguration(): {
  accountId: string;
  apiToken: string;
} | null {
  const apiToken = env.EMAIL_REST_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();

  return apiToken && accountId ? { accountId, apiToken } : null;
}

function getProviderErrorCode(error: unknown): string | undefined {
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
  if (error instanceof EmailDeliveryError) {
    return error;
  }

  const providerCode = getProviderErrorCode(error);
  const suffix = providerCode ? ` (${providerCode})` : "";

  return new EmailDeliveryError(
    "EMAIL_SEND_FAILED",
    `Cloudflare Email Service failed to send the message${suffix}.`,
    { cause: error, ...(providerCode ? { providerCode } : {}) },
  );
}

/** The recipients as lists, for the transports. */
function recipientLists(options: SendEmailOptions) {
  return {
    to: typeof options.to === "string" ? [options.to] : [...options.to],
    cc: [...(options.cc ?? [])],
    bcc: [...(options.bcc ?? [])],
  };
}

async function sendWithRest(
  options: SendEmailOptions,
  from: EmailAddressInput,
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
        ...recipientLists(options),
        subject: options.subject,
        ...(options.text ? { text: options.text } : {}),
        ...(options.html ? { html: options.html } : {}),
        from,
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.attachments
          ? { attachments: [...options.attachments] }
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
  options: SendEmailOptions,
  from: EmailAddressInput,
): Promise<SendEmailResult> {
  const { to, cc, bcc } = recipientLists(options);
  const address = (value: EmailAddressInput) =>
    value.name ? { email: value.address, name: value.name } : value.address;
  const result = (await binding.send({
    to: to.length === 1 ? to[0]! : to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    from: address(from),
    ...(options.replyTo ? { replyTo: address(options.replyTo) } : {}),
    subject: options.subject,
    ...(options.html ? { html: options.html } : {}),
    ...(options.text ? { text: options.text } : {}),
    ...(options.headers && Object.keys(options.headers).length > 0
      ? { headers: options.headers }
      : {}),
    ...(options.attachments && options.attachments.length > 0
      ? {
          attachments: options.attachments.map((attachment) =>
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

/**
 * Whether the gateway can attempt to send email at all: a sender is set and
 * there is a transport (the REST API or the EMAIL binding). Email is
 * optional; without it, invitations and password resets hand the admin a
 * link to share instead.
 */
export function isEmailConfigured(): boolean {
  if (!configuredSender()) return false;
  if (getRestConfiguration()) return true;
  const binding = env.EMAIL as SendEmail | undefined;
  return Boolean(binding && typeof binding.send === "function");
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
 * Send one email, within its kind's daily budgets. Throws an
 * EmailDeliveryError (logged here) when email isn't configured, a budget is
 * spent or the provider refuses.
 */
export async function sendEmail(
  options: SendEmailOptions,
): Promise<SendEmailResult> {
  const { to, cc, bcc } = recipientLists(options);
  try {
    const restConfiguration = getRestConfiguration();

    if (restConfiguration) {
      const from = options.from ?? parseConfiguredSender();
      await spendMailBudget(options.kind, [...to, ...cc, ...bcc]);
      return await sendWithRest(options, from, restConfiguration);
    }

    const binding = requireEmailBinding();
    const from = options.from ?? parseConfiguredSender();
    await spendMailBudget(options.kind, [...to, ...cc, ...bcc]);
    return await sendWithBinding(binding, options, from);
  } catch (error) {
    const deliveryError = asDeliveryError(error);

    console.error("Email delivery failed", {
      event: "email.send.failed",
      kind: options.kind,
      code: deliveryError.code,
      providerCode: deliveryError.providerCode,
      message: deliveryError.message,
    });

    throw deliveryError;
  }
}
