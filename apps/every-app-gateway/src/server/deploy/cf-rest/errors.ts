/** One entry of a Cloudflare API envelope's `errors` or `messages`. */
export interface CloudflareErrorDetail {
  code?: number;
  message: string;
}

/**
 * Codes the hosted deployer branches on. Cloudflare answers a missing
 * Worker (account or namespaced) with 10007, a path it has no route for
 * with 7000, and a malformed identifier in the path (a wrong account id,
 * say) with 7003.
 */
export const CLOUDFLARE_ERROR_CODES = {
  NO_ROUTE: 7000,
  INVALID_OBJECT_IDENTIFIER: 7003,
  AUTHENTICATION: 10000,
  WORKER_NOT_FOUND: 10007,
} as const;

/**
 * A request the Cloudflare API refused, or one that never got an answer
 * (status 0). `code` is the first error code in the envelope, if any;
 * `context` names the operation, e.g. "Upload dispatch script acme-todo".
 */
export class CloudflareApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly context: string;
  readonly errors: CloudflareErrorDetail[];

  constructor(options: {
    status: number;
    context: string;
    errors?: CloudflareErrorDetail[];
    message?: string;
    cause?: unknown;
  }) {
    const errors = options.errors ?? [];
    const detail =
      options.message ||
      errors.map(formatDetail).join("; ") ||
      "Unknown Cloudflare API error";
    super(`${options.context}: ${detail}`, { cause: options.cause });
    this.name = "CloudflareApiError";
    this.status = options.status;
    this.code = errors.find((error) => error.code !== undefined)?.code;
    this.context = options.context;
    this.errors = errors;
  }
}

export function formatDetail(detail: CloudflareErrorDetail): string {
  return detail.code === undefined
    ? detail.message
    : `[${detail.code}] ${detail.message}`;
}

/**
 * Whether the API answered that the object (Worker, namespace, database)
 * does not exist. A 404 for a route Cloudflare doesn't have, or for an
 * identifier it can't parse, is a bug in the caller, not an absent object,
 * so it doesn't count.
 */
export function isCloudflareNotFound(error: unknown): boolean {
  if (!(error instanceof CloudflareApiError)) return false;
  if (error.code === CLOUDFLARE_ERROR_CODES.WORKER_NOT_FOUND) return true;
  return (
    error.status === 404 &&
    error.code !== CLOUDFLARE_ERROR_CODES.NO_ROUTE &&
    error.code !== CLOUDFLARE_ERROR_CODES.INVALID_OBJECT_IDENTIFIER
  );
}
