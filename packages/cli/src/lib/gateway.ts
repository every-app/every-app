export class GatewayUnreachableError extends Error {
  url: string;
  override cause: unknown;

  constructor(url: string, cause: unknown) {
    super(`Could not reach your Gateway at ${url} (${reasonForCause(cause)})`);
    this.name = "GatewayUnreachableError";
    this.url = url;
    this.cause = cause;
  }
}

/**
 * Check if SSL certificate is ready for a given URL.
 * Returns true if the connection succeeds, false if there's an SSL error.
 */
export async function checkSslReady(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    // Any response (even 404) means SSL is working
    return true;
  } catch (error) {
    // Check for SSL-related errors
    const errorMessage =
      error instanceof Error ? error.message.toLowerCase() : "";
    const errorCode =
      error instanceof Error && "cause" in error
        ? (error.cause as { code?: string })?.code?.toLowerCase() || ""
        : "";

    const sslErrorIndicators = [
      "ssl",
      "tls",
      "certificate",
      "cert",
      "cipher",
      "handshake",
      "secure",
    ];

    const isSslError = sslErrorIndicators.some(
      (indicator) =>
        errorMessage.includes(indicator) || errorCode.includes(indicator),
    );

    if (isSslError) {
      return false;
    }

    throw new GatewayUnreachableError(url, error);
  }
}

function reasonForCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
