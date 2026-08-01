import { env } from "cloudflare:workers";

type SendEmailOptions = {
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
  | "EMAIL_SEND_FAILED";

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

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  try {
    const restConfiguration = getRestConfiguration();

    if (restConfiguration) {
      const from = parseConfiguredSender();
      await sendWithRest(options, from, restConfiguration);
      return;
    }

    const binding = requireEmailBinding();
    const from = parseConfiguredSender();

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
      code: deliveryError.code,
      providerCode: getProviderErrorCode(deliveryError.cause),
      message: deliveryError.message,
    });

    throw deliveryError;
  }
}
