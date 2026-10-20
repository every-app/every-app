/**
 * The `email` capability's wire contract (docs/capabilities.md "Gateway
 * services"): what an app sends to `POST /api/integrations/email/send`,
 * how the request is checked, which senders and inbound addresses an
 * installation may hold (`everyapp email set`), which provider a gateway
 * sends with (Cloudflare Email Sending or Resend), and how the provider's
 * answers map onto the gateway's refusals.
 *
 * The gateway enforces these, the CLI's `email set` checks the lists with
 * the same validator, and the SDK's local-dev fallback applies the same
 * checks and the same REST body, so a refusal in `everyapp dev` is the one
 * production gives. Pure functions only: no env, no I/O.
 */

/** An address with an optional display name. */
export interface EmailAddressInput {
  address: string;
  name?: string;
}

/** A file attached to the message, its bytes base64-encoded. */
export interface EmailAttachmentInput {
  filename: string;
  /** The MIME type, e.g. `application/pdf`. */
  contentType: string;
  /** The file's bytes, base64. */
  content: string;
  /** `inline` embeds it in the HTML body, referenced as `cid:<contentId>`. */
  disposition?: "attachment" | "inline";
  /** Required for an inline attachment. */
  contentId?: string;
}

/** What an app asks the gateway to send. */
export interface SendEmailMessage {
  /** At least one; with `cc` and `bcc`, at most 50 recipients. */
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  /** At most 998 characters, on one line. */
  subject: string;
  /** At least one of `text` and `html`. */
  text?: string;
  html?: string;
  /**
   * Absent: the gateway's own sender (EMAIL_FROM). Present: it must match
   * one of the installation's senders (`everyapp email set --sender`).
   */
  from?: string | EmailAddressInput;
  replyTo?: string | EmailAddressInput;
  /** e.g. `In-Reply-To`, `References`, `X-…`: at most 20, values on one line. */
  headers?: Record<string, string>;
  attachments?: EmailAttachmentInput[];
}

/** An attachment that passed {@link parseSendEmailMessage}. */
export interface CheckedEmailAttachment {
  filename: string;
  contentType: string;
  content: string;
  disposition: "attachment" | "inline";
  contentId?: string;
}

/** A message that passed {@link parseSendEmailMessage}: lists, trimmed. */
export interface CheckedEmailMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  from?: EmailAddressInput;
  replyTo?: EmailAddressInput;
  headers?: Record<string, string>;
  attachments?: CheckedEmailAttachment[];
}

/** What a send answers. `logged`: local dev only, nothing was sent. */
export interface SendEmailResult {
  messageId?: string;
  status: "delivered" | "queued" | "logged";
}

/** `GET /api/integrations/email`: whether the app can send, and as whom. */
export interface EmailCapabilityStatus {
  capability: "email";
  /** The app's manifest lists `email`. */
  requested: boolean;
  /** The gateway has a sender and a transport. */
  configured: boolean;
  /** Sends would go through. */
  ready: boolean;
  /** The From a message without `from` gets; null unless ready. */
  sender: { address: string; name: string } | null;
  /**
   * The `from` patterns the gateway accepts from this app: its
   * installation's; empty for none, and on a hosted gateway.
   */
  senders: string[];
  /**
   * The provider mail goes out with; null unless configured. In local dev,
   * the one the gateway would pick from `.dev.vars` (only Cloudflare's REST
   * API really sends from dev; otherwise sends are printed).
   */
  provider: EmailProviderId | null;
}

/**
 * The providers a gateway sends mail with, in the order it prefers them
 * (docs/runbooks/email-sending-setup.md, "Choosing a provider"). One serves
 * the whole gateway: its own mail and every app's.
 */
export const EMAIL_PROVIDER_IDS = ["cloudflare", "resend"] as const;
export type EmailProviderId = (typeof EMAIL_PROVIDER_IDS)[number];

/** Each provider's name, as messages give it. */
export const EMAIL_PROVIDER_LABELS: Readonly<Record<EmailProviderId, string>> =
  {
    cloudflare: "Cloudflare Email Sending",
    resend: "Resend",
  };

/**
 * How far a provider is set up: by settings the operator gave it (Email
 * Sending's REST pair, RESEND_API_KEY), only by a binding every gateway
 * Worker declares (Cloudflare's EMAIL), or not at all.
 */
export type EmailProviderSetup = "settings" | "binding" | null;

/** The provider {@link chooseEmailProvider} picked, or why there is none. */
export type EmailProviderChoice =
  | { ok: true; provider: EmailProviderId }
  | { ok: false; error: "unknown_provider"; requested: string }
  | { ok: false; error: "not_configured"; requested: EmailProviderId | null };

/**
 * Which provider sends. EMAIL_PROVIDER (trimmed, any case), when set, names
 * it, and it must be set up. Without it: the first provider, in
 * {@link EMAIL_PROVIDER_IDS} order, the operator gave settings to, else one
 * a binding alone sets up. The EMAIL binding is declared on every gateway
 * Worker, so it can't be what makes Cloudflare win over a RESEND_API_KEY
 * the operator set.
 */
export function chooseEmailProvider(
  emailProvider: unknown,
  setup: (provider: EmailProviderId) => EmailProviderSetup,
): EmailProviderChoice {
  const requested =
    typeof emailProvider === "string" ? emailProvider.trim() : "";
  if (requested) {
    const provider = EMAIL_PROVIDER_IDS.find(
      (id) => id === requested.toLowerCase(),
    );
    if (!provider) return { ok: false, error: "unknown_provider", requested };
    return setup(provider)
      ? { ok: true, provider }
      : { ok: false, error: "not_configured", requested: provider };
  }
  const provider =
    EMAIL_PROVIDER_IDS.find((id) => setup(id) === "settings") ??
    EMAIL_PROVIDER_IDS.find((id) => setup(id) !== null);
  return provider
    ? { ok: true, provider }
    : { ok: false, error: "not_configured", requested: null };
}

/** Cloudflare Email Sending's limits the gateway checks before sending, and the lists an installation keeps on the gateway. */
export const EMAIL_LIMITS = {
  /** The request body, read with a counting stream. */
  bodyBytes: 5 * 1024 * 1024,
  recipients: 50,
  subjectChars: 998,
  headers: 20,
  headerValueBytes: 2048,
  headerNameBytes: 100,
  headersTotalBytes: 16 * 1024,
  attachments: 32,
  /** Sender patterns an installation may hold (`everyapp email set --sender`). */
  senders: 20,
  /** Inbound addresses an installation may hold (Email Routing allows 200 rules a domain). */
  inbound: 50,
  /** Email Routing's limit on a rule's address (its matcher's value). */
  inboundAddressChars: 90,
} as const;

/**
 * A sender: `*@<domain>` (any address on exactly that domain) or
 * `<local>@<domain>`, in lowercase. Set per installed app with
 * `everyapp email set --sender`; the gateway reads them from its registry.
 */
export const EMAIL_SENDER_PATTERN =
  /^(\*|[a-z0-9._+-]+)@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * An inbound address Email Routing delivers to the app's Worker: `*@<domain>`,
 * the catch-all of a zone's apex, or one address, in lowercase. The CLI finds
 * the zone; a catch-all on a subdomain is refused there.
 */
export const EMAIL_INBOUND_PATTERN =
  /^(\*|[a-z0-9._+-]+)@([a-z0-9-]+\.)+[a-z]{2,}$/;

/** The command that sets an installation's senders and inbound addresses, for messages. */
export const EMAIL_SET_COMMAND = "everyapp email set";

/** An installed app's email configuration, as the gateway's `apps` row holds it (`[]` for a null column). */
export interface AppEmailConfig {
  /** The `from` patterns the gateway accepts from the app; empty: the gateway's sender only. */
  senders: string[];
  /** The addresses Email Routing delivers to the app's Worker; empty: none. */
  inbound: string[];
}

/**
 * Why `values` can't be an installation's senders or inbound addresses
 * (`everyapp email set`), one sentence each; empty when they can. The
 * rules the manifest's `capabilities.email.senders` and `email.inbound`
 * had: the patterns above, no duplicates, at most EMAIL_LIMITS.senders or
 * EMAIL_LIMITS.inbound entries, an inbound address at most
 * EMAIL_LIMITS.inboundAddressChars long.
 */
export function emailListProblems(
  kind: "senders" | "inbound",
  values: readonly string[],
): string[] {
  const problems: string[] = [];
  const limit =
    kind === "senders" ? EMAIL_LIMITS.senders : EMAIL_LIMITS.inbound;
  if (values.length > limit) {
    problems.push(
      `At most ${limit} ${kind === "senders" ? "senders" : "inbound addresses"}, not ${values.length}.`,
    );
  }
  for (const value of values) {
    if (kind === "inbound" && value.length > EMAIL_LIMITS.inboundAddressChars) {
      problems.push(
        `${value} is longer than Email Routing's ${EMAIL_LIMITS.inboundAddressChars} characters.`,
      );
    } else if (
      !(kind === "senders" ? EMAIL_SENDER_PATTERN : EMAIL_INBOUND_PATTERN).test(
        value,
      )
    ) {
      problems.push(
        kind === "senders"
          ? `"${value}" isn't a sender: a sender is "*@<domain>" or "<local>@<domain>", in lowercase.`
          : `"${value}" isn't an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.`,
      );
    }
  }
  for (const twice of new Set(
    values.filter((value, index) => values.indexOf(value) !== index),
  )) {
    problems.push(`${twice} is listed twice.`);
  }
  return problems;
}

/** A list as the row stores it: JSON, or null for none. */
export function storedEmailList(values: readonly string[]): string | null {
  return values.length === 0 ? null : JSON.stringify(values);
}

/**
 * The 403 `email_sender_not_allowed` sentence. `where` says what sets the
 * senders: the gateway's registry row, or `.dev.vars` in local dev.
 */
export function emailSenderRefusal(
  address: string,
  where: "gateway" | "dev",
): string {
  const domain = `*@${emailDomain(address)}`;
  return where === "gateway"
    ? `This app may not send as ${address}: list it, or ${domain}, among the app's senders with \`${EMAIL_SET_COMMAND} --sender\` in the app's directory.`
    : `This app may not send as ${address}: in dev, list it, or ${domain}, in EVERYAPP_EMAIL_SENDERS in .dev.vars; deployed, \`${EMAIL_SET_COMMAND} --sender\` sets the app's senders.`;
}

/** An address the provider will take: printable ASCII, one `@`, a dotted domain. */
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const MAX_ADDRESS_LENGTH = 254;
const MAX_NAME_LENGTH = 256;
const MAX_FILENAME_LENGTH = 255;
const LINE_BREAK = /[\r\n]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/**
 * Headers the message's own fields set, or the transport does: an app may
 * not set them as headers (`From` would get past the sender rule).
 */
const RESERVED_HEADERS = new Set([
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "return-path",
  "date",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "dkim-signature",
]);
const MESSAGE_FIELDS = new Set([
  "to",
  "cc",
  "bcc",
  "subject",
  "text",
  "html",
  "from",
  "replyTo",
  "headers",
  "attachments",
]);

export type ParsedEmailMessage =
  | { ok: true; message: CheckedEmailMessage }
  | { ok: false; problem: string };

/**
 * Check a send request's JSON body against what Email Sending takes, so an
 * app hears "bcc has 51 recipients" from the gateway rather than a bare
 * provider error. Unknown fields are refused (a `reply_to` typo would
 * otherwise vanish).
 */
export function parseSendEmailMessage(input: unknown): ParsedEmailMessage {
  try {
    return { ok: true, message: checkMessage(input) };
  } catch (error) {
    if (error instanceof EmailMessageProblem) {
      return { ok: false, problem: error.message };
    }
    throw error;
  }
}

class EmailMessageProblem extends Error {}

function problem(message: string): never {
  throw new EmailMessageProblem(message);
}

function checkMessage(input: unknown): CheckedEmailMessage {
  if (!isRecord(input)) problem("The body is a JSON object.");
  for (const field of Object.keys(input)) {
    if (!MESSAGE_FIELDS.has(field)) {
      problem(
        `Unknown field "${field}"; a message takes ${[...MESSAGE_FIELDS].join(", ")}.`,
      );
    }
  }
  const to = recipients(input["to"], "to");
  const cc = recipients(input["cc"] ?? [], "cc");
  const bcc = recipients(input["bcc"] ?? [], "bcc");
  if (to.length === 0) problem("to names at least one recipient.");
  const count = to.length + cc.length + bcc.length;
  if (count > EMAIL_LIMITS.recipients) {
    problem(
      `A message goes to at most ${EMAIL_LIMITS.recipients} recipients across to, cc and bcc (this one: ${count}).`,
    );
  }

  const subject = input["subject"];
  if (typeof subject !== "string") problem("subject is a string.");
  if (LINE_BREAK.test(subject)) problem("subject is one line.");
  if (subject.length > EMAIL_LIMITS.subjectChars) {
    problem(`subject is at most ${EMAIL_LIMITS.subjectChars} characters.`);
  }

  const text = optionalString(input["text"], "text");
  const html = optionalString(input["html"], "html");
  if (!text && !html) problem("A message has a text or an html body.");

  const message: CheckedEmailMessage = { to, cc, bcc, subject };
  if (text) message.text = text;
  if (html) message.html = html;
  if (input["from"] !== undefined) {
    message.from = addressInput(input["from"], "from");
  }
  if (input["replyTo"] !== undefined) {
    message.replyTo = addressInput(input["replyTo"], "replyTo");
  }
  if (input["headers"] !== undefined) {
    message.headers = headers(input["headers"]);
  }
  if (input["attachments"] !== undefined) {
    message.attachments = attachments(input["attachments"]);
  }
  return message;
}

function recipients(value: unknown, field: string): string[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) {
    problem(`${field} is an address or a list of addresses.`);
  }
  return list.map((entry, index) => {
    if (typeof entry !== "string") {
      problem(`${field}[${index}] is an address string.`);
    }
    return address(entry, `${field}[${index}]`);
  });
}

function address(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length > MAX_ADDRESS_LENGTH || !ADDRESS.test(trimmed)) {
    problem(`${field} isn't an email address: "${value.slice(0, 80)}".`);
  }
  return trimmed;
}

function addressInput(value: unknown, field: string): EmailAddressInput {
  if (typeof value === "string") return { address: address(value, field) };
  if (!isRecord(value)) {
    problem(`${field} is an address, or { address, name }.`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "address" && key !== "name") {
      problem(`${field} takes address and name, not "${key}".`);
    }
  }
  if (typeof value["address"] !== "string") {
    problem(`${field}.address is an address string.`);
  }
  const result: EmailAddressInput = {
    address: address(value["address"], `${field}.address`),
  };
  const name = value["name"];
  if (name !== undefined && name !== null) {
    if (typeof name !== "string") problem(`${field}.name is a string.`);
    if (CONTROL.test(name) || name.length > MAX_NAME_LENGTH) {
      problem(
        `${field}.name is one line of at most ${MAX_NAME_LENGTH} characters.`,
      );
    }
    if (name.trim()) result.name = name.trim();
  }
  return result;
}

function headers(value: unknown): Record<string, string> {
  if (!isRecord(value)) problem("headers is an object of names to values.");
  const entries = Object.entries(value);
  if (entries.length > EMAIL_LIMITS.headers) {
    problem(`A message sets at most ${EMAIL_LIMITS.headers} headers.`);
  }
  let total = 0;
  const result: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (
      !HEADER_NAME.test(name) ||
      byteLength(name) > EMAIL_LIMITS.headerNameBytes
    ) {
      problem(`"${name.slice(0, 80)}" isn't a header name.`);
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      problem(
        `The ${name} header comes from the message's own fields or the transport; it can't be set as a header.`,
      );
    }
    if (typeof headerValue !== "string") {
      problem(`The ${name} header's value is a string.`);
    }
    if (CONTROL.test(headerValue)) {
      problem(`The ${name} header's value is one line.`);
    }
    const bytes = byteLength(headerValue);
    if (bytes > EMAIL_LIMITS.headerValueBytes) {
      problem(
        `The ${name} header's value is at most ${EMAIL_LIMITS.headerValueBytes} bytes.`,
      );
    }
    total += byteLength(name) + bytes;
    result[name] = headerValue;
  }
  if (total > EMAIL_LIMITS.headersTotalBytes) {
    problem(
      `A message's headers are at most ${EMAIL_LIMITS.headersTotalBytes / 1024} KB together.`,
    );
  }
  return result;
}

function attachments(value: unknown): CheckedEmailAttachment[] {
  if (!Array.isArray(value)) problem("attachments is a list.");
  if (value.length > EMAIL_LIMITS.attachments) {
    problem(`A message has at most ${EMAIL_LIMITS.attachments} attachments.`);
  }
  return value.map((entry: unknown, index) => {
    const field = `attachments[${index}]`;
    if (!isRecord(entry)) problem(`${field} is an object.`);
    const { filename, contentType, content, disposition, contentId } = entry;
    for (const key of Object.keys(entry)) {
      if (
        ![
          "filename",
          "contentType",
          "content",
          "disposition",
          "contentId",
        ].includes(key)
      ) {
        problem(`${field} has an unknown field "${key}".`);
      }
    }
    if (
      typeof filename !== "string" ||
      !filename.trim() ||
      CONTROL.test(filename) ||
      filename.length > MAX_FILENAME_LENGTH
    ) {
      problem(`${field}.filename is a file name on one line.`);
    }
    if (typeof contentType !== "string" || !MIME_TYPE.test(contentType)) {
      problem(`${field}.contentType is a MIME type such as application/pdf.`);
    }
    if (typeof content !== "string" || !BASE64.test(content)) {
      problem(`${field}.content is the file's bytes in base64.`);
    }
    if (
      disposition !== undefined &&
      disposition !== "attachment" &&
      disposition !== "inline"
    ) {
      problem(`${field}.disposition is "attachment" or "inline".`);
    }
    const checked: CheckedEmailAttachment = {
      filename: filename.trim(),
      contentType,
      content,
      disposition: disposition ?? "attachment",
    };
    if (checked.disposition === "inline") {
      if (
        typeof contentId !== "string" ||
        !contentId.trim() ||
        CONTROL.test(contentId)
      ) {
        problem(`${field} is inline, so it needs a contentId.`);
      }
      checked.contentId = contentId.trim();
    } else if (contentId !== undefined) {
      problem(`${field}.contentId is for inline attachments only.`);
    }
    return checked;
  });
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") problem(`${field} is a string.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Whether `address` may be a message's From under `patterns` (the
 * installation's senders, `apps.email_senders`): `*@example.com` takes any
 * address on exactly example.com (not its subdomains), anything else that
 * address alone. Case never matters.
 */
export function senderAllowed(
  address: string,
  patterns: readonly string[],
): boolean {
  const candidate = address.trim().toLowerCase();
  const at = candidate.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = candidate.slice(at + 1);
  return patterns.some((pattern) => {
    const wanted = pattern.trim().toLowerCase();
    return wanted.startsWith("*@")
      ? wanted.slice(2) === domain
      : wanted === candidate;
  });
}

/** The domain of an address, lowercased. */
export function emailDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** The distinct recipients of a message, lowercased: what budgets count. */
export function distinctRecipients(
  message: Pick<CheckedEmailMessage, "to" | "cc" | "bcc">,
): string[] {
  return [
    ...new Set(
      [...message.to, ...message.cc, ...message.bcc].map((recipient) =>
        recipient.toLowerCase(),
      ),
    ),
  ];
}

/** A gateway refusal: status, `x-everyapp-error` code, message. */
export interface EmailRefusal {
  status: number;
  code: string;
  message: string;
}

/**
 * Codes for a message the provider found malformed: the binding's `E_*`
 * (Resend's validation errors map onto `E_VALIDATION_ERROR`).
 */
const INVALID_MESSAGE_CODES = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
  // REST: invalid request, too big, invalid email.
  "10001",
  "10200",
  "10202",
]);

/**
 * The refusal for an error the provider answered with, by its code:
 * Cloudflare's binding `E_*` or REST numeric one, or the `E_*` code the
 * gateway's Resend provider maps Resend's errors onto. `senderDomain` is
 * the From's domain, for the step that verifies it with `provider`.
 */
export function emailProviderRefusal(
  providerCode: string | undefined,
  senderDomain: string,
  provider: EmailProviderId = "cloudflare",
): EmailRefusal {
  const label = EMAIL_PROVIDER_LABELS[provider];
  const suffix = providerCode ? ` (${providerCode})` : "";
  switch (providerCode) {
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return {
        status: 422,
        code: "email_sender_not_verified",
        message:
          provider === "resend"
            ? `Resend won't send from ${senderDomain}${suffix}: the domain must be verified in the gateway's Resend account. Its operator adds ${senderDomain} at https://resend.com/domains and publishes the DNS records Resend lists.`
            : `Cloudflare Email Sending won't send from ${senderDomain}${suffix}: the domain must be onboarded in the gateway's Cloudflare account. Its operator runs: cf email-sending subdomains create -z ${senderDomain} --name ${senderDomain} (or Compute > Email Service > Email Sending > Onboard Domain in the dashboard).`,
      };
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
    case "10004":
      return {
        status: 429,
        code: "email_provider_limited",
        message: `${label} refused the message: the gateway's account has reached its sending limit${suffix}. Try again later.`,
      };
    default:
      if (providerCode && INVALID_MESSAGE_CODES.has(providerCode)) {
        return {
          status: 400,
          code: "email_invalid_message",
          message: `${label} refused the message as invalid${suffix}.`,
        };
      }
      return {
        status: 502,
        code: "email_send_failed",
        message: `${label} failed to send the message${suffix}.`,
      };
  }
}

/** The URL of Email Sending's REST `send` for an account. */
export function emailRestUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`;
}

/** A message as Email Sending's REST `send` takes it (snake_case fields). */
export function emailRestBody(
  message: Omit<CheckedEmailMessage, "from"> & {
    from: EmailAddressInput;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    to: message.to.length === 1 ? message.to[0] : message.to,
    from: restAddress(message.from),
    // A reply goes to the sender unless the message says otherwise.
    reply_to: restAddress(message.replyTo ?? message.from),
    subject: message.subject,
  };
  if (message.cc.length > 0) body["cc"] = message.cc;
  if (message.bcc.length > 0) body["bcc"] = message.bcc;
  if (message.text) body["text"] = message.text;
  if (message.html) body["html"] = message.html;
  if (message.headers && Object.keys(message.headers).length > 0) {
    body["headers"] = message.headers;
  }
  if (message.attachments && message.attachments.length > 0) {
    body["attachments"] = message.attachments.map((attachment) => ({
      content: attachment.content,
      filename: attachment.filename,
      type: attachment.contentType,
      disposition: attachment.disposition,
      ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
    }));
  }
  return body;
}

function restAddress(address: EmailAddressInput): string | EmailAddressInput {
  return address.name
    ? { address: address.address, name: address.name }
    : address.address;
}

/** What Email Sending's REST `send` answers. */
interface RestSendResponse {
  success?: boolean;
  errors?: { code?: string | number; message?: string }[];
  result?: {
    message_id?: string;
    delivered?: string[];
    queued?: string[];
    permanent_bounces?: string[];
  } | null;
}

/**
 * Read Email Sending's REST answer: the message id and whether delivery is
 * queued, or the provider's error code. A message whose every recipient
 * bounced permanently failed; one that reached some of them did not.
 */
export function readEmailRestResponse(
  httpStatus: number,
  body: unknown,
):
  | { ok: true; messageId?: string; status: "delivered" | "queued" }
  | { ok: false; providerCode?: string; message: string } {
  const parsed = (isRecord(body) ? body : {}) as RestSendResponse;
  const error = parsed.errors?.[0];
  if (httpStatus < 200 || httpStatus >= 300 || parsed.success === false) {
    const code =
      error?.code !== undefined
        ? String(error.code)
        : httpStatus === 429
          ? "10004"
          : undefined;
    return {
      ok: false,
      ...(code ? { providerCode: code } : {}),
      message: error?.message ?? `Email API returned ${httpStatus}.`,
    };
  }
  const result = parsed.result;
  if (!result) {
    return { ok: false, message: "Email API returned no delivery result." };
  }
  const delivered = result.delivered ?? [];
  const queued = result.queued ?? [];
  if (
    delivered.length === 0 &&
    queued.length === 0 &&
    (result.permanent_bounces ?? []).length > 0
  ) {
    return {
      ok: false,
      message: "Email API permanently bounced every recipient.",
    };
  }
  return {
    ok: true,
    ...(result.message_id ? { messageId: result.message_id } : {}),
    status: queued.length > 0 ? "queued" : "delivered",
  };
}

/**
 * The sender EMAIL_FROM and EMAIL_FROM_NAME configure: EMAIL_FROM is an
 * address, or `Name <address>` with the name in it. Null unless both an
 * address and a name are set.
 */
export function parseEmailSender(
  from: string | undefined,
  name: string | undefined,
): { address: string; name: string } | null {
  const configuredFrom = from?.trim();
  if (!configuredFrom) return null;
  const combined = /^(.*?)\s*<([^<>]+)>$/.exec(configuredFrom);
  const address = (combined?.[2] ?? configuredFrom).trim();
  const combinedName = combined?.[1]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  const resolvedName = name?.trim() || combinedName;
  return address && resolvedName ? { address, name: resolvedName } : null;
}

/**
 * The binding an app's Workers get in local dev when `.dev.vars` sets it
 * (`everyAppWorker()` declares it like the other dev keys): the senders a
 * gateway would hold for this installation, a comma- or whitespace-
 * separated list or a JSON array. Deployed, the gateway reads them from the
 * app's registry row (`apps.email_senders`, `everyapp email set --sender`).
 */
export const EMAIL_SENDERS_ENV = "EVERYAPP_EMAIL_SENDERS";

/**
 * A list of addresses or patterns: an `apps` row's `email_senders` or
 * `email_inbound` (JSON), or {@link EMAIL_SENDERS_ENV} (JSON, or separated
 * by commas or whitespace). None when unset, or when JSON that isn't an
 * array; other text is read as a comma or whitespace list, so a word no
 * address matches allows no sender. Only `everyapp email set` writes the
 * columns, as JSON; the admin page reads them as JSON only.
 */
export function parseEmailList(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const text = value.trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  }
  return text.split(/[\s,]+/).filter(Boolean);
}
