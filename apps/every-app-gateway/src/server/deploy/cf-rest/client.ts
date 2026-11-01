import {
  CloudflareApiError,
  formatDetail,
  type CloudflareErrorDetail,
} from "./errors";

export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: CloudflareErrorDetail[];
  messages?: CloudflareErrorDetail[];
  result: T;
  result_info?: CloudflareResultInfo;
}

export interface CloudflareResultInfo {
  page?: number;
  per_page?: number;
  count?: number;
  total_count?: number;
  total_pages?: number;
  cursor?: string;
}

export interface CloudflareTransportOptions {
  /** A Cloudflare API token scoped to `accountId`. */
  apiToken: string;
  accountId: string;
  /** Defaults to the global fetch; tests pass a mock or the fake Cloudflare. */
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Attempts per request, counting the first. Defaults to 4. */
  maxAttempts?: number;
  retryBaseMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface CloudflareRequestOptions {
  /** Names the operation in errors, e.g. "Upload dispatch script acme-todo". */
  context: string;
  /** Replaces the API token, as the assets upload's session JWT does. */
  authorization?: string;
  /**
   * Accept a successful response that isn't a Cloudflare envelope and
   * return its JSON as is. Cloudflare documents a few endpoints (bulk
   * delete by tag) without one.
   */
  envelopeOptional?: boolean;
}

/**
 * Methods Cloudflare can safely receive twice. A POST that failed with a
 * 5xx or never answered may still have created the database or namespace,
 * or run the SQL, so only these are retried on those; every method is
 * retried on 429, which Cloudflare sends before doing anything.
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "PATCH"]);

/**
 * The HTTP layer of the client: one account, one token, the API's
 * envelope unwrapped and its errors raised as CloudflareApiError.
 */
export class CloudflareTransport {
  readonly accountId: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: CloudflareTransportOptions) {
    if (!options.apiToken)
      throw new Error("A Cloudflare API token is required");
    if (!/^[0-9a-f]{32}$/.test(options.accountId)) {
      throw new Error(`Not a Cloudflare account id: ${options.accountId}`);
    }
    this.accountId = options.accountId;
    this.apiToken = options.apiToken;
    // Bound so a Workers runtime doesn't throw "Illegal invocation".
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.maxAttempts = options.maxAttempts ?? 4;
    this.retryBaseMs = options.retryBaseMs ?? 400;
    this.random = options.random ?? Math.random;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** `/accounts/<id>` followed by `segments`, each URL-encoded. */
  accountPath(...segments: string[]): string {
    return [
      `/accounts/${this.accountId}`,
      ...segments.map(encodeURIComponent),
    ].join("/");
  }

  async request<T>(
    path: string,
    init: RequestInit,
    options: CloudflareRequestOptions,
  ): Promise<T> {
    return (await this.requestWithInfo<T>(path, init, options)).result;
  }

  async requestWithInfo<T>(
    path: string,
    init: RequestInit,
    options: CloudflareRequestOptions,
  ): Promise<{ result: T; resultInfo: CloudflareResultInfo | undefined }> {
    const method = (init.method ?? "GET").toUpperCase();
    const retryFailures = IDEMPOTENT_METHODS.has(method);
    let lastTransportError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const headers = new Headers(init.headers);
      headers.set(
        "Authorization",
        `Bearer ${options.authorization ?? this.apiToken}`,
      );
      headers.set("Accept", "application/json");
      if (typeof init.body === "string" && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          method,
          headers,
        });
      } catch (error) {
        lastTransportError = error;
        if (!retryFailures || attempt === this.maxAttempts) break;
        await this.backoff(attempt);
        continue;
      }

      const retryable =
        response.status === 429 || (retryFailures && response.status >= 500);
      if (retryable && attempt < this.maxAttempts) {
        // Read the body so the connection can be reused.
        await response.text().catch(() => undefined);
        const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
        if (retryAfter !== undefined) await this.sleep(retryAfter);
        else await this.backoff(attempt);
        continue;
      }

      return parseEnvelope<T>(response, options);
    }

    throw new CloudflareApiError({
      status: 0,
      context: options.context,
      message: retryFailures
        ? `no answer from Cloudflare after ${this.maxAttempts} attempts`
        : "no answer from Cloudflare (not retried: the request may have been applied)",
      cause: lastTransportError,
    });
  }

  private async backoff(attempt: number): Promise<void> {
    const exponential = this.retryBaseMs * 2 ** (attempt - 1);
    await this.sleep(Math.round(exponential * (0.5 + this.random())));
  }
}

async function parseEnvelope<T>(
  response: Response,
  options: CloudflareRequestOptions,
): Promise<{ result: T; resultInfo: CloudflareResultInfo | undefined }> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const envelope = isEnvelope<T>(body) ? body : undefined;

  if (!response.ok || envelope?.success === false) {
    const errors = envelope?.errors ?? [];
    const messages = envelope?.messages ?? [];
    throw new CloudflareApiError({
      status: response.status,
      context: options.context,
      errors,
      message:
        [...errors, ...messages].map(formatDetail).join("; ") ||
        text.slice(0, 500) ||
        `HTTP ${response.status} ${response.statusText}`.trim(),
    });
  }
  if (envelope)
    return { result: envelope.result, resultInfo: envelope.result_info };
  if (response.status === 204 && options.envelopeOptional)
    return { result: null as T, resultInfo: undefined };
  if (options.envelopeOptional && body !== undefined) {
    return { result: body as T, resultInfo: undefined };
  }
  throw new CloudflareApiError({
    status: response.status,
    context: options.context,
    message: "the response was not a Cloudflare API envelope",
  });
}

function isEnvelope<T>(body: unknown): body is CloudflareEnvelope<T> {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { success?: unknown }).success === "boolean"
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** A JSON request body for `init`. */
export function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** A JSON part of a multipart body, as Cloudflare wants `metadata` and `settings`. */
export function jsonPart(value: unknown): Blob {
  return new Blob([JSON.stringify(value)], { type: "application/json" });
}
