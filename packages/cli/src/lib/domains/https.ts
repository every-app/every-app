/**
 * One plain HTTPS request to a hostname the gateway serves, to learn whether
 * it answers at all: its certificate is there and DNS resolves it. Never
 * proof that an app is live by itself (the registry in D1 says that); the
 * request is what makes the gateway activate a newly bound app.
 */

const PROBE_TIMEOUT_MS = 10_000;

type HttpsAnswer =
  /** No answer: no certificate yet, a name that doesn't resolve yet, refused. */
  | { answered: false; reason: string }
  | {
      answered: true;
      status: number;
      /**
       * Cloudflare Access answered with its login page, in front of the
       * gateway: the gateway itself never saw the request.
       */
      access: boolean;
    };

/** Whether a redirect goes to Cloudflare Access's login. */
function isAccessLogin(location: string | null): boolean {
  return /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(location ?? "");
}

function reasonFor(error: unknown): string {
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause
      : error;
  return cause instanceof Error ? cause.message : String(cause);
}

/** GET `url` once, without following redirects. */
export async function probeHttps(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HttpsAnswer> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "everyapp-cli" },
    });
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    return {
      answered: true,
      status: response.status,
      access:
        response.status >= 300 && response.status < 400 && isAccessLogin(location),
    };
  } catch (error) {
    return { answered: false, reason: reasonFor(error) };
  }
}
