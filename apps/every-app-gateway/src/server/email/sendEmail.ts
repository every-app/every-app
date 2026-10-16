import { env } from "cloudflare:workers";
import { type MailKind, platformPolicy } from "@/server/platform-policy";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";

type SendEmailOptions = {
  /** What the mail is for: each kind has its own daily budgets. */
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
};

type RestEmailResult = {
  delivered: string[];
  permanent_bounces: string[];
  queued: string[];
};

type RestEmailResponse = {
  success: boolean;
  errors?: Array<{ code?: string | number; message?: string }>;
  result?: RestEmailResult | null;
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

  constructor(
    code: EmailDeliveryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EmailDeliveryError";
    this.code = code;
  }
}

function parseConfiguredSender(): EmailAddress {
  const configuredFrom = env.EMAIL_FROM?.trim();
  const configuredName = env.EMAIL_FROM_NAME?.trim();

  if (!configuredFrom) {
    throw new EmailDeliveryError(
      "EMAIL_SENDER_NOT_CONFIGURED",
      "Email sender is not configured. Set EMAIL_FROM and EMAIL_FROM_NAME.",
    );
  }

  const combinedFrom = configuredFrom.match(/^(.*?)\s*<([^<>]+)>$/);
  const email = (combinedFrom?.[2] ?? configuredFrom).trim();
  const combinedName = combinedFrom?.[1]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  const name = configuredName || combinedName;

  if (!email || !name) {
    throw new EmailDeliveryError(
      "EMAIL_SENDER_NOT_CONFIGURED",
      'Email sender is not configured. Set EMAIL_FROM and EMAIL_FROM_NAME, or use EMAIL_FROM="Name <email@example.com>".',
    );
  }

  return { email, name };
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
    { cause: error },
  );
}

async function sendWithRest(
  options: SendEmailOptions,
  from: EmailAddress,
  configuration: { accountId: string; apiToken: string },
): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}/email/sending/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: options.to,
        from: { address: from.email, name: from.name },
        reply_to: { address: from.email, name: from.name },
        subject: options.subject,
        html: options.html,
        text: options.text,
      }),
    },
  );

  let body: RestEmailResponse | undefined;
  try {
    body = (await response.json()) as RestEmailResponse;
  } catch {
    // The HTTP status below still determines whether this send failed.
  }

  const providerError = body?.errors?.[0];
  if (!response.ok || body?.success === false) {
    throw Object.assign(
      new Error(
        providerError?.message ?? `Email API returned ${response.status}.`,
      ),
      providerError?.code === undefined ? {} : { code: providerError.code },
    );
  }

  if (!body?.result) {
    throw new Error("Email API returned no delivery result.");
  }

  if (body.result.permanent_bounces.length > 0) {
    throw new Error("Email API permanently bounced one or more recipients.");
  }
}

/**
 * Whether the gateway can attempt to send email at all: a sender is set and
 * there is a transport (the REST API or the EMAIL binding). Email is
 * optional; without it, invitations and password resets hand the admin a
 * link to share instead.
 */
export function isEmailConfigured(): boolean {
  try {
    parseConfiguredSender();
  } catch {
    return false;
  }
  if (getRestConfiguration()) return true;
  const binding = env.EMAIL as SendEmail | undefined;
  return Boolean(binding && typeof binding.send === "function");
}

/**
 * The recipient as a counter key: an HMAC of the address, so the counters
 * table never holds anyone's email.
 */
async function recipientKey(address: string): Promise<string> {
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
 * mailDaily), to its address and for the whole gateway, in D1
 * (`rate_limit_counters`) so they hold across isolates. Counted before it
 * is sent, so a send that fails still counts: a flood of failures is
 * bounded too. A budget that can't be read or written refuses the mail.
 */
async function spendMailBudget(
  kind: MailKind,
  to: string,
  now = new Date(),
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const dayEnds = new Date(Date.parse(day) + DAY_MS);
  const gatewayKey = `mail:${kind}:gateway:${day}`;
  const addressKey = `mail:${kind}:to:${await recipientKey(to)}:${day}`;
  const { perAddress, perGateway } = platformPolicy(env).mailDaily[kind];

  let counts: Map<string, number>;
  try {
    counts = await RateLimitCounterRepository.read(
      [gatewayKey, addressKey],
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
    (counts.get(gatewayKey) ?? 0) >= perGateway
      ? "gateway"
      : (counts.get(addressKey) ?? 0) >= perAddress
        ? "address"
        : null;
  if (exhausted) {
    throw new EmailDeliveryError(
      "EMAIL_BUDGET_EXHAUSTED",
      exhausted === "gateway"
        ? `The gateway has sent all the ${kind} emails it may today. Try again tomorrow.`
        : `This address has been sent all the ${kind} emails it may get today. Try again tomorrow.`,
    );
  }
  try {
    await RateLimitCounterRepository.increment(
      [gatewayKey, addressKey],
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
export async function sendEmail(options: SendEmailOptions): Promise<void> {
  try {
    const restConfiguration = getRestConfiguration();

    if (restConfiguration) {
      const from = parseConfiguredSender();
      await spendMailBudget(options.kind, options.to);
      await sendWithRest(options, from, restConfiguration);
      return;
    }

    const binding = requireEmailBinding();
    const from = parseConfiguredSender();
    await spendMailBudget(options.kind, options.to);

    await binding.send({
      to: options.to,
      from,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
  } catch (error) {
    const deliveryError = asDeliveryError(error);

    console.error("Email delivery failed", {
      event: "email.send.failed",
      kind: options.kind,
      code: deliveryError.code,
      providerCode: getProviderErrorCode(deliveryError.cause),
      message: deliveryError.message,
    });

    throw deliveryError;
  }
}
