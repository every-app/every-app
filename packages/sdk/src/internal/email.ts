/**
 * The `email` capability's wire contract (docs/capabilities.md "Gateway
 * services"): what an app sends to `POST /api/integrations/email/send`,
 * how the request is checked, which senders a manifest may name, and how
 * Cloudflare Email Sending's answers map onto the gateway's refusals.
 *
 * The gateway enforces these, the manifest validator reads the sender
 * pattern, and the SDK's local-dev fallback applies the same checks and
 * the same REST body, so a refusal in `everyapp dev` is the one production
 * gives. Pure functions only: no env, no I/O.
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
   * one of the manifest's `capabilities.email.senders`.
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
  /** The `from` patterns the gateway accepts from this app; empty for none. */
  senders: string[];
}

/** Cloudflare Email Sending's limits the gateway checks before sending. */
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
  /** Patterns in a manifest's `capabilities.email.senders`. */
  senders: 20,
} as const;

/**
 * A manifest `senders` entry: `*@<domain>` (any address on exactly that
 * domain) or `<local>@<domain>`, in lowercase.
 */
export const EMAIL_SENDER_PATTERN =
  /^(\*|[a-z0-9._+-]+)@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;

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
 * Whether `address` may be a message's From under `patterns` (a manifest's
 * `capabilities.email.senders`): `*@example.com` takes any address on
 * exactly example.com (not its subdomains), anything else that address
 * alone. Case never matters.
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

/** Binding codes (`E_*`) for a message the provider found malformed. */
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
 * The refusal for an error Cloudflare Email Sending answered with, by its
 * code: the binding's `E_*` or the REST API's numeric one. `senderDomain`
 * is the From's domain, for the onboarding command.
 */
export function emailProviderRefusal(
  providerCode: string | undefined,
  senderDomain: string,
): EmailRefusal {
  const suffix = providerCode ? ` (${providerCode})` : "";
  switch (providerCode) {
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return {
        status: 422,
        code: "email_sender_not_verified",
        message: `Cloudflare Email Sending won't send from ${senderDomain}${suffix}: the domain must be onboarded in the gateway's Cloudflare account. Its operator runs: cf email-sending subdomains create -z ${senderDomain} --name ${senderDomain} (or Compute > Email Service > Email Sending > Onboard Domain in the dashboard).`,
      };
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
    case "10004":
      return {
        status: 429,
        code: "email_provider_limited",
        message: `Cloudflare Email Sending refused the message: the gateway's account has reached its sending limit${suffix}. Try again later.`,
      };
    default:
      if (providerCode && INVALID_MESSAGE_CODES.has(providerCode)) {
        return {
          status: 400,
          code: "email_invalid_message",
          message: `Cloudflare Email Sending refused the message as invalid${suffix}.`,
        };
      }
      return {
        status: 502,
        code: "email_send_failed",
        message: `Cloudflare Email Sending failed to send the message${suffix}.`,
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
 * The text binding `everyAppWorker()` gives an app's Workers in local dev
 * when the manifest lists `email`: its `senders`, as JSON. Deployed, the
 * gateway reads them from the registry instead.
 */
export const EMAIL_SENDERS_ENV = "EVERYAPP_EMAIL_SENDERS";

/** The senders in {@link EMAIL_SENDERS_ENV}; none when unset or unreadable. */
export function parseEmailSendersEnv(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
