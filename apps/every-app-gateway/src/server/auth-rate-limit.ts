/**
 * Brute-force limits on the gateway's credential endpoints: sign-in, sign-up,
 * password reset, the owner setup claim, and OAuth client registration and
 * tokens.
 *
 * Better Auth's own limiter keeps its counters in each isolate's memory, so
 * on Workers it limits little. These use the Workers Rate Limiting bindings
 * cloudflare.config.ts declares, which count per Cloudflare location. Every
 * attempt counts against the client's address (generously, so an office
 * behind one is fine) and, when the body names an account, against that
 * address and email together, and against the email alone: a generous cap
 * that holds however many addresses an attacker spreads guesses over.
 *
 * An IPv6 client usually holds a whole /64 and can pick a new address in it
 * for every request, so IPv6 addresses count by their /64.
 */
import { isMcpOauthEnabled } from "./oauth-flag";

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface RateLimitEnv {
  AUTH_RATE_LIMIT_IP?: RateLimiter;
  AUTH_RATE_LIMIT_EMAIL?: RateLimiter;
  AUTH_RATE_LIMIT_ACCOUNT?: RateLimiter;
  MCP_OAUTH_ENABLED?: string;
}

const CREDENTIAL_PATHS = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "/api/auth/request-password-reset",
  "/api/auth/forget-password",
  "/api/auth/reset-password",
  "/api/setup/claim",
  // Starting a single sign-on (Cloudflare Access) writes a verification
  // row; Better Auth's own limiter counts them per isolate only.
  "/api/auth/sign-in/social",
]);

// Only while the OAuth server is on; otherwise these paths answer 404.
const OAUTH_CREDENTIAL_PATHS = new Set(["/oauth/register", "/oauth/token"]);

const RETRY_AFTER_SECONDS = 60;

function isCredentialPath(pathname: string, env: RateLimitEnv): boolean {
  return (
    CREDENTIAL_PATHS.has(pathname) ||
    (OAUTH_CREDENTIAL_PATHS.has(pathname) && isMcpOauthEnabled(env))
  );
}

// better-call (Better Auth's router) parses a body as JSON when its type
// matches this, whatever else the header says.
const JSON_CONTENT_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * The lowercased `email` the body carries, read the way better-call reads
 * it for Better Auth: JSON for any type it takes as JSON (including
 * `application/x-www-form-urlencoded+json`), form fields (the last of a
 * repeated one) for a type that merely contains a form type. Anything else
 * never reaches an email endpoint as an object, so only the address counts.
 */
async function emailFromBody(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  let email: unknown;
  try {
    if (JSON_CONTENT_TYPE.test(contentType)) {
      const body: unknown = await request.clone().json();
      email =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)["email"]
          : undefined;
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      // better-call keeps a repeated field's last value.
      email = (await request.clone().formData()).getAll("email").at(-1);
    }
  } catch {
    // An unreadable body is the endpoint's to reject; only the address counts.
    return null;
  }
  return typeof email === "string" && email.trim()
    ? email.trim().toLowerCase()
    : null;
}

/**
 * The address a client is counted under: an IPv4 address as is (also when
 * mapped into IPv6), an IPv6 address by its /64, in one canonical form.
 */
export function clientAddressKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const groups = ipv6Groups(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip.toLowerCase();
}

/** The eight 16-bit groups of an IPv6 address, without leading zeros. */
function ipv6Groups(ip: string): string[] | null {
  let address = ip.toLowerCase().replace(/%.*$/, "");
  // A dotted IPv4 tail is the last two groups.
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    address = `${address.slice(0, -tail[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [
          ...head,
          ...Array<string>(8 - head.length - rest.length).fill("0"),
          ...rest,
        ]
      : head;
  if (
    groups.length !== 8 ||
    !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.map((group) => Number.parseInt(group, 16).toString(16));
}

function tooManyRequests(): Response {
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      message: "Too many attempts. Wait a minute and try again.",
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(RETRY_AFTER_SECONDS),
      },
    },
  );
}

/**
 * Count a credential request against its limits: a 429 once one is spent,
 * or null to let it through (and for every other request).
 */
export async function rateLimitCredentialRequest(
  request: Request,
  env: RateLimitEnv,
): Promise<Response | null> {
  if (request.method.toUpperCase() !== "POST") return null;
  const { pathname } = new URL(request.url);
  if (!isCredentialPath(pathname, env)) return null;

  // Cloudflare sets CF-Connecting-IP and clients can't override it.
  const address = clientAddressKey(
    request.headers.get("cf-connecting-ip")?.trim() || "unknown",
  );
  if (env.AUTH_RATE_LIMIT_IP) {
    const { success } = await env.AUTH_RATE_LIMIT_IP.limit({
      key: `ip:${address}`,
    });
    if (!success) return tooManyRequests();
  }

  // OAuth requests carry no email, and their routes cap the body before
  // reading it (mcp-auth/body.ts); reading it here would undo the cap.
  const email =
    !OAUTH_CREDENTIAL_PATHS.has(pathname) &&
    (env.AUTH_RATE_LIMIT_EMAIL || env.AUTH_RATE_LIMIT_ACCOUNT)
      ? await emailFromBody(request)
      : null;
  if (!email) return null;
  if (env.AUTH_RATE_LIMIT_EMAIL) {
    const { success } = await env.AUTH_RATE_LIMIT_EMAIL.limit({
      key: `email:${address}:${email}`,
    });
    if (!success) return tooManyRequests();
  }
  if (env.AUTH_RATE_LIMIT_ACCOUNT) {
    const { success } = await env.AUTH_RATE_LIMIT_ACCOUNT.limit({
      key: `account:${email}`,
    });
    if (!success) return tooManyRequests();
  }
  return null;
}
