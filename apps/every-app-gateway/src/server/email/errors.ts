import type { EmailProviderId } from "@every-app/sdk/internal";

type EmailDeliveryErrorCode =
  /** No provider is selectable (the historic name: the binding was all there was). */
  | "EMAIL_BINDING_UNAVAILABLE"
  | "EMAIL_SENDER_NOT_CONFIGURED"
  | "EMAIL_SEND_FAILED"
  | "EMAIL_BUDGET_EXHAUSTED"
  | "EMAIL_BUDGET_UNAVAILABLE";

/** Why the gateway didn't send a mail; sendEmail() logs it and throws it. */
export class EmailDeliveryError extends Error {
  readonly code: EmailDeliveryErrorCode;
  /**
   * The provider's own code (Email Sending's `E_SENDER_NOT_VERIFIED`,
   * `10004`, ...; the `E_*` code Resend's error maps onto, or Resend's
   * error name), when it gave one.
   */
  readonly providerCode: string | undefined;
  /** The provider that refused, for its wording of the refusal. */
  readonly provider: EmailProviderId | undefined;
  /** When a spent budget refills: the next UTC midnight. */
  readonly retryAt: Date | undefined;

  constructor(
    code: EmailDeliveryErrorCode,
    message: string,
    options?: ErrorOptions & {
      providerCode?: string;
      provider?: EmailProviderId;
      retryAt?: Date;
    },
  ) {
    super(message, options);
    this.name = "EmailDeliveryError";
    this.code = code;
    this.providerCode = options?.providerCode;
    this.provider = options?.provider;
    this.retryAt = options?.retryAt;
  }
}
