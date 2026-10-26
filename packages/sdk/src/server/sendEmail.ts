import {
  ConfigurationError,
  EMAIL_SENDERS_ENV,
  emailDomain,
  emailProviderRefusal,
  emailRestBody,
  emailRestUrl,
  emailSenderRefusal,
  parseEmailList,
  parseEmailSender,
  parseSendEmailMessage,
  readEmailRestResponse,
  senderAllowed,
  serviceRoutePath,
  type CheckedEmailMessage,
  type SendEmailMessage,
  type SendEmailResult,
} from "../internal/index.js";
import {
  applyAttribution,
  attributionFor,
  type GatewayCallFor,
} from "./attribution.js";
import { BINDING_ORIGIN, type GatewayServiceBinding } from "./gatewayFetch.js";
import { GatewayRefusalError, gatewayRefusal } from "./refusal.js";

export interface SendEmailOptions {
  /**
   * The Worker env: the EVERY_APP_GATEWAY binding when deployed; in local
   * dev EVERYAPP_DEV, EVERYAPP_EMAIL_SENDERS in `.dev.vars` for the senders
   * a `from` may name, and optionally EMAIL_REST_API_TOKEN,
   * CLOUDFLARE_ACCOUNT_ID and EMAIL_FROM there to really send.
   */
  env: object;
  /**
   * Whom the mail is for: the inbound request (its user), or
   * `{ background: true, organizationId }` for work no person started (an
   * `email()` handler, a cron, a Workflow). An organization's own app may
   * omit it for background work; a shared app's Worker must pass one or
   * the other ({@link AttributionError}).
   */
  for?: GatewayCallFor;
  message: SendEmailMessage;
}

/**
 * Send an email through the gateway's `email` capability: its sender
 * (EMAIL_FROM) unless `message.from` names an address the installation's
 * senders allow (`everyapp email set --sender`; in dev, `.dev.vars`'
 * EVERYAPP_EMAIL_SENDERS), within the gateway's daily budgets. The app
 * lists `capabilities: { email: { access: "write" } }`.
 *
 * Throws {@link GatewayRefusalError} when the gateway won't send
 * (`email_sender_not_allowed`, `email_budget_exhausted`,
 * `integration_not_configured`, ...), with the code and a message to show.
 *
 * In local dev (`everyapp dev`, no binding) the message is checked the way
 * the gateway checks it, then printed and answered `{ status: "logged" }`;
 * with EMAIL_REST_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and EMAIL_FROM in
 * `.dev.vars` it goes out for real through Email Sending's REST API, from
 * the developer's own account.
 */
export async function sendEmail({
  env,
  for: explicitTarget,
  message,
}: SendEmailOptions): Promise<SendEmailResult> {
  const target = attributionFor(env, explicitTarget, "sendEmail");
  const values = env as Record<string, unknown>;
  const binding = values["EVERY_APP_GATEWAY"] as
    | GatewayServiceBinding
    | undefined;
  if (binding) {
    if (typeof binding.fetch !== "function") {
      throw new ConfigurationError(
        "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
      );
    }
    return sendThroughGateway(binding, target, message);
  }
  if (!values["EVERYAPP_DEV"]) {
    throw new ConfigurationError(
      "Email is unavailable: deploy with the EVERY_APP_GATEWAY binding (everyapp deploy), or run under everyapp dev.",
    );
  }
  return sendInDev(values, message);
}

async function sendThroughGateway(
  binding: GatewayServiceBinding,
  target: GatewayCallFor | undefined,
  message: SendEmailMessage,
): Promise<SendEmailResult> {
  const headers = new Headers({ "content-type": "application/json" });
  applyAttribution(headers, target);
  const response = await binding.fetch(
    new Request(`${BINDING_ORIGIN}${serviceRoutePath("email", "send")}`, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    }),
  );
  const refusal = await gatewayRefusal(response);
  if (refusal) throw new GatewayRefusalError(refusal);
  if (!response.ok) {
    throw new GatewayRefusalError({
      status: response.status,
      code: "email_send_failed",
      message: `The EveryApp gateway answered ${response.status} to the send.`,
    });
  }
  return (await response.json()) as SendEmailResult;
}

/**
 * What the gateway would do, with no gateway: the same checks and sender
 * rule, then the developer's own Email Sending account or the console.
 */
async function sendInDev(
  values: Record<string, unknown>,
  input: SendEmailMessage,
): Promise<SendEmailResult> {
  const parsed = parseSendEmailMessage(input);
  if (!parsed.ok) {
    throw new GatewayRefusalError({
      status: 400,
      code: "email_invalid_message",
      message: parsed.problem,
    });
  }
  const message = parsed.message;
  if (
    message.from &&
    !senderAllowed(
      message.from.address,
      parseEmailList(values[EMAIL_SENDERS_ENV]),
    )
  ) {
    throw new GatewayRefusalError({
      status: 403,
      code: "email_sender_not_allowed",
      message: emailSenderRefusal(message.from.address, "dev"),
    });
  }

  const token = stringValue(values["EMAIL_REST_API_TOKEN"]);
  const accountId = stringValue(values["CLOUDFLARE_ACCOUNT_ID"]);
  const configuredFrom = stringValue(values["EMAIL_FROM"]);
  // The gateway needs a name for its sender; a developer's address alone will do.
  const sender = configuredFrom
    ? (parseEmailSender(
        configuredFrom,
        stringValue(values["EMAIL_FROM_NAME"]),
      ) ?? { address: configuredFrom })
    : null;
  if (token && accountId && sender) {
    return sendWithRest(message, message.from ?? sender, token, accountId);
  }

  const recipients = message.to.length + message.cc.length + message.bcc.length;
  console.info(
    `[everyapp dev] email to ${recipients} recipient${recipients === 1 ? "" : "s"} subject ${JSON.stringify(message.subject)} (not sent: set EMAIL_REST_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and EMAIL_FROM in .dev.vars to send)`,
  );
  return { status: "logged", messageId: `dev-${crypto.randomUUID()}` };
}

async function sendWithRest(
  message: CheckedEmailMessage,
  from: { address: string; name?: string },
  token: string,
  accountId: string,
): Promise<SendEmailResult> {
  const response = await fetch(emailRestUrl(accountId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(emailRestBody({ ...message, from })),
  });
  const body: unknown = await response.json().catch(() => null);
  const result = readEmailRestResponse(response.status, body);
  if (!result.ok) {
    throw new GatewayRefusalError(
      emailProviderRefusal(result.providerCode, emailDomain(from.address)),
    );
  }
  return {
    status: result.status,
    ...(result.messageId ? { messageId: result.messageId } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
