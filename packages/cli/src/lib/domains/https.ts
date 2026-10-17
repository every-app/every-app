/**
 * One plain HTTPS request to a hostname the gateway serves, to learn whether
 * it answers at all: its certificate is there and DNS resolves it. Never
 * proof that an app is live by itself (the registry in D1 says that); the
 * request is what makes the gateway activate a newly bound app.
 *
 * The hostname resolves at its zone's nameservers (authoritativeDns.ts), so
 * a resolver on the way that still remembers it as missing can't hold the
 * probe back from a hostname that already works.
 */
import { Agent, fetch as undiciFetch } from "undici";
import { lookup } from "./authoritativeDns";

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Why a request got no answer: the name doesn't resolve (`dns`), the TLS
 * handshake fails, as it does until the certificate comes (`tls`), or
 * anything else (`other`: refused, timed out).
 */
export type NoAnswerKind = "dns" | "tls" | "other";

export type HttpsAnswer =
  /** No answer: no certificate yet, a name that doesn't resolve yet, refused. */
  | { answered: false; reason: string; kind: NoAnswerKind }
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

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA"]);
const TLS_CODES = new Set(["EPROTO", "ECONNRESET"]);

/** The error and its causes, outermost first. */
function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let at = error; at !== undefined && chain.length < 5; ) {
    chain.push(at);
    at = at instanceof Error ? at.cause : undefined;
  }
  return chain;
}

function kindOf(error: unknown): NoAnswerKind {
  const chain = causes(error);
  const codes = chain.map((at) => String((at as { code?: unknown } | null)?.code ?? ""));
  const text = chain.map((at) => (at instanceof Error ? at.message : String(at))).join("\n");
  if (codes.some((code) => DNS_CODES.has(code)) || /\b(ENOTFOUND|EAI_AGAIN|ENODATA)\b/.test(text)) {
    return "dns";
  }
  if (
    codes.some(
      (code) => code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_") || TLS_CODES.has(code),
    ) ||
    /handshake|alert|certificate/i.test(text)
  ) {
    return "tls";
  }
  return "other";
}

let probeAgent: Agent | undefined;

/** undici's fetch over connections that resolve at the zone's nameservers. */
const zoneFetch = ((input: string, init: RequestInit) => {
  probeAgent ??= new Agent({ connect: { lookup } });
  return undiciFetch(input, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: probeAgent,
  });
}) as unknown as typeof fetch;

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
  fetchImpl: typeof fetch = zoneFetch,
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
    return { answered: false, reason: reasonFor(error), kind: kindOf(error) };
  }
}
