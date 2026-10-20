/**
 * The `email` capability (docs/capabilities.md "Gateway services"): apps
 * send mail through the gateway's own sender and provider, Cloudflare Email
 * Sending or Resend (server/email/sendEmail.ts, server/email/providers),
 * within the gateway's daily `app` budgets. One sending domain set up per
 * gateway serves every app, and every message is attributed and logged
 * (never its subject or body).
 *
 *   POST /api/integrations/email/send   SendEmailMessage -> { messageId?, status }
 *   GET  /api/integrations/email        EmailCapabilityStatus
 *
 * Without `from` a message goes out as the gateway's sender. With one, the
 * address must match one of the installation's senders
 * (`apps.email_senders`, set with `everyapp email set --sender`), and its
 * domain must be onboarded to Email Sending in the gateway's account (or
 * verified in its Resend account). A hosted gateway sends app mail from its
 * own sender only, for now.
 */
import {
  CAPABILITIES,
  EMAIL_LIMITS,
  MCP_WRITE_SCOPE,
  distinctRecipients,
  emailDomain,
  emailProviderRefusal,
  emailSenderRefusal,
  parseSendEmailMessage,
  senderAllowed,
  type EmailCapabilityStatus,
  type EmailProviderId,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";
import type {
  SendEmailOptions,
  SendEmailResult,
} from "@/server/email/sendEmail";
import { EMAIL_TRANSPORTS_TEXT } from "@/server/email/providers";
import type { IntegrationCallAdmission } from "@/server/integration-proxy";
import { capabilityRefusal } from "./refusal";

const EMAIL = CAPABILITIES.email;
const RUNBOOK = "docs/runbooks/email-sending-setup.md";

/** The gateway's mail, as the capability uses it. */
export interface GatewayMail {
  /** A sender is set and a provider is selectable. */
  isConfigured(): boolean;
  /** EMAIL_FROM and its name, or null. */
  sender(): { address: string; name: string } | null;
  /** The provider mail goes out with, or null when the gateway can't send. */
  provider(): EmailProviderId | null;
  /**
   * Send within the `app` budgets. Throws an error with the gateway's
   * `code` (`EMAIL_BUDGET_EXHAUSTED`, `EMAIL_SEND_FAILED`, ...), the
   * `provider` that refused and its `providerCode` and, for a spent
   * budget, `retryAt`.
   */
  send(options: SendEmailOptions): Promise<SendEmailResult>;
  /** An HMAC of an address: what logs name a recipient by. */
  recipientHash(address: string): Promise<string>;
}

/**
 * The gateway's own mail module, loaded on first use: it reads the
 * Worker's env and D1, which nothing else on this path needs.
 */
export async function loadGatewayMail(): Promise<GatewayMail> {
  const mail = await import("@/server/email/sendEmail");
  return {
    isConfigured: mail.isEmailConfigured,
    sender: mail.configuredSender,
    provider: mail.configuredEmailProvider,
    send: mail.sendEmail,
    recipientHash: mail.recipientKey,
  };
}

interface EmailCapabilityOptions {
  /** The calling app's manifest entry for `email`, if it lists one. */
  entry: CapabilityRequest | undefined;
  /** The senders stored for the app's installation (its registry row), the allowlist for `from`. */
  senders: readonly string[];
  /** A hosted gateway: app senders are refused. */
  hosted: boolean;
  mail: () => Promise<GatewayMail>;
}

/** Whether the app may send: its manifest lists email for writing. */
function requested(entry: CapabilityRequest | undefined): boolean {
  return entry?.access === "write";
}

/** The `from` patterns the gateway accepts from the app: none on hosted, none without the grant. */
function effectiveSenders(
  entry: CapabilityRequest | undefined,
  senders: readonly string[],
  hosted: boolean,
): string[] {
  return hosted || !requested(entry) ? [] : [...senders];
}

/**
 * `GET /api/integrations/email`: whether a send would go through, as whom,
 * and which senders the app may name, without sending anything. Only an
 * app that lists email learns whether the gateway can send.
 */
export async function emailCapabilityStatus({
  entry,
  senders,
  hosted,
  mail,
}: EmailCapabilityOptions): Promise<Response> {
  const isRequested = requested(entry);
  const gatewayMail = isRequested ? await mail() : null;
  const configured = Boolean(gatewayMail?.isConfigured());
  const status: EmailCapabilityStatus = {
    capability: "email",
    requested: isRequested,
    configured,
    ready: isRequested && configured,
    sender: configured ? (gatewayMail?.sender() ?? null) : null,
    senders: effectiveSenders(entry, senders, hosted),
    provider: configured ? (gatewayMail?.provider() ?? null) : null,
  };
  return Response.json(status);
}

/** `POST /api/integrations/email/send`, checked in the order below. */
export async function handleEmailSend({
  request,
  entry,
  senders,
  hosted,
  admit,
  mail,
}: EmailCapabilityOptions & {
  request: Request;
  admit: () => Promise<IntegrationCallAdmission>;
}): Promise<Response> {
  const method = request.method.toUpperCase();
  if (!(EMAIL.routes.send as readonly string[]).includes(method)) {
    return capabilityRefusal(
      405,
      "integration_method_not_allowed",
      "Email is sent with POST /api/integrations/email/send (sendEmail() in @every-app/sdk/server).",
    );
  }
  // 1. The deployed manifest listing email for writing is the grant.
  if (!requested(entry)) {
    return capabilityRefusal(
      403,
      "capability_not_requested",
      'This app doesn\'t list email in its capabilities. Add capabilities: { email: { access: "write" } } to everyapp.config.ts and deploy again.',
    );
  }
  // 2. Whom the mail is for (throws the entrypoint's caller_* refusals).
  const { caller, user } = await admit();
  // 3. An agent sends mail only on a connection that may write.
  if (
    user?.channel === "mcp" &&
    !user.scopes.some((scope) => scope === MCP_WRITE_SCOPE || scope === "*")
  ) {
    return capabilityRefusal(
      403,
      "integration_read_only",
      "This agent connection is read-only, and sending email writes. Reconnect the agent with write access.",
    );
  }

  // 4. The message.
  const body = await readCapped(request);
  if (body === null) {
    return capabilityRefusal(
      413,
      "email_message_too_large",
      `A message, attachments included, is at most ${EMAIL_LIMITS.bodyBytes / 1024 / 1024} MiB as sent to the gateway.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return capabilityRefusal(
      400,
      "email_invalid_message",
      "The body is a JSON message: { to, subject, text or html, ... }.",
    );
  }
  const parsed = parseSendEmailMessage(json);
  if (!parsed.ok) {
    return capabilityRefusal(400, "email_invalid_message", parsed.problem);
  }
  const message = parsed.message;
  const recipients = distinctRecipients(message);

  const gatewayMail = await mail();
  const logged = {
    ...caller,
    recipients: recipients.length,
    recipientHash: await gatewayMail.recipientHash(message.to[0]!),
    sender: message.from ? "app" : "gateway",
    attribution: user ? "user" : "app",
    ...(user ? { userId: user.id } : {}),
  };
  const refuse = (
    status: number,
    code: string,
    text: string,
    headers?: Record<string, string>,
  ) => {
    logEvent("email.app.send", { ...logged, status: "refused", reason: code });
    return capabilityRefusal(status, code, text, headers);
  };

  // 5. The sender: the gateway's, or one the installation allows.
  if (message.from) {
    if (hosted) {
      return refuse(
        403,
        "email_sender_not_allowed",
        "This gateway sends app mail from its own sender only for now: leave from out, or ask the platform about sending from your own domain.",
      );
    }
    if (
      !senderAllowed(
        message.from.address,
        effectiveSenders(entry, senders, hosted),
      )
    ) {
      return refuse(
        403,
        "email_sender_not_allowed",
        emailSenderRefusal(message.from.address, "gateway"),
      );
    }
  }

  // 6. A sender and a provider on the gateway.
  if (!gatewayMail.isConfigured()) {
    return refuse(
      503,
      "integration_not_configured",
      `Email isn't set up on this gateway. Its operator sets up a sending domain, then sets EMAIL_FROM and EMAIL_FROM_NAME and ${EMAIL_TRANSPORTS_TEXT}, with everyapp secret set <NAME> (${RUNBOOK}).`,
    );
  }

  // 7-8. The daily budgets, then the send.
  let result: SendEmailResult;
  try {
    result = await gatewayMail.send({
      kind: "app",
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      ...(message.text ? { text: message.text } : {}),
      ...(message.html ? { html: message.html } : {}),
      ...(message.from ? { from: message.from } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.headers ? { headers: message.headers } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
    });
  } catch (error) {
    const failure = deliveryFailure(error);
    switch (failure.code) {
      case "EMAIL_BUDGET_EXHAUSTED":
        return refuse(429, "email_budget_exhausted", failure.message, {
          "retry-after": String(secondsUntil(failure.retryAt)),
        });
      case "EMAIL_BUDGET_UNAVAILABLE":
        return refuse(503, "email_budget_unavailable", failure.message);
      case "EMAIL_SENDER_NOT_CONFIGURED":
      case "EMAIL_BINDING_UNAVAILABLE":
        return refuse(503, "integration_not_configured", failure.message);
      default: {
        const sender = message.from?.address ?? gatewayMail.sender()?.address;
        const refusal = emailProviderRefusal(
          failure.providerCode,
          sender ? emailDomain(sender) : "<your domain>",
          failure.provider ?? gatewayMail.provider() ?? "cloudflare",
        );
        return refuse(refusal.status, refusal.code, refusal.message);
      }
    }
  }

  logEvent("email.app.send", { ...logged, status: result.status });
  return Response.json({
    ...(result.messageId ? { messageId: result.messageId } : {}),
    status: result.status,
  });
}

/** What a failed send threw: the gateway's code, the provider and its code, the refill time. */
function deliveryFailure(error: unknown): {
  code: string | undefined;
  provider: EmailProviderId | undefined;
  providerCode: string | undefined;
  retryAt: Date | undefined;
  message: string;
} {
  const fields = (
    typeof error === "object" && error !== null ? error : {}
  ) as Record<string, unknown>;
  return {
    code: typeof fields["code"] === "string" ? fields["code"] : undefined,
    provider:
      fields["provider"] === "cloudflare" || fields["provider"] === "resend"
        ? fields["provider"]
        : undefined,
    providerCode:
      typeof fields["providerCode"] === "string"
        ? fields["providerCode"]
        : undefined,
    retryAt: fields["retryAt"] instanceof Date ? fields["retryAt"] : undefined,
    message:
      error instanceof Error ? error.message : "The email couldn't be sent.",
  };
}

/** Seconds until `at` (the budget's refill), at least one. */
function secondsUntil(at: Date | undefined): number {
  if (!at) return 60;
  return Math.max(1, Math.ceil((at.getTime() - Date.now()) / 1000));
}

/**
 * The request body as text, or null once it passes the cap: counted as it
 * streams, so a body that lies about (or omits) its length still stops at
 * the cap.
 */
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > EMAIL_LIMITS.bodyBytes) {
    return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > EMAIL_LIMITS.bodyBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
