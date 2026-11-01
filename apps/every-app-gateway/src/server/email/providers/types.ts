import type {
  CheckedEmailAttachment,
  EmailAddressInput,
  EmailProviderId,
  EmailProviderSetup,
} from "@every-app/sdk/internal";

/**
 * The settings email providers read: a plain object in tests, the Worker's
 * env in the gateway.
 */
export interface EmailProviderEnv {
  /** Cloudflare's `send_email` binding; a config may omit it. */
  EMAIL?: unknown;
  /** With CLOUDFLARE_ACCOUNT_ID: Email Sending's REST API instead of the binding. */
  EMAIL_REST_API_TOKEN?: string | undefined;
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  /** `cloudflare` or `resend`: which one sends when both are set up. */
  EMAIL_PROVIDER?: string | undefined;
}

/** A message ready for a provider: the sender resolved, recipients as lists. */
export interface OutboundEmail {
  from: EmailAddressInput;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  /** At least one of `text` and `html`. */
  text?: string;
  html?: string;
  /** Absent: replies go to the sender. */
  replyTo?: EmailAddressInput;
  headers?: Record<string, string>;
  /** Base64 content, which every provider takes as is. */
  attachments?: readonly CheckedEmailAttachment[];
}

/** What the provider said: accepted (and delivered), or queued for some recipients. */
export type SendEmailResult = {
  messageId?: string;
  status: "delivered" | "queued";
};

/** A transport the gateway sends mail with (providers/index.ts lists them). */
export interface EmailProvider {
  id: EmailProviderId;
  /** "Cloudflare Email Sending", "Resend". */
  label: string;
  /** Settings this provider needs beyond EMAIL_FROM/EMAIL_FROM_NAME, for messages. */
  settings: readonly string[];
  /** Whether it can send at all. */
  configured(env: EmailProviderEnv): boolean;
  /**
   * How it is set up (chooseEmailProvider): by its own settings, by a
   * binding alone, or not at all.
   */
  setup(env: EmailProviderEnv): EmailProviderSetup;
  /** Send one message. Throws an EmailDeliveryError. */
  send(env: EmailProviderEnv, message: OutboundEmail): Promise<SendEmailResult>;
}
