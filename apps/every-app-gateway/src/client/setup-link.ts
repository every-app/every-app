/**
 * Read the setup secret from a `/setup#token=est_…` link. The secret rides in
 * the fragment, which browsers never send to a server or put in a Referer.
 */
export function readSetupToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token?.startsWith("est_") ? token : null;
}

type ClaimResult =
  | { ok: true }
  | { ok: false; retry: true }
  | { ok: false; retry: false; message: string };

const CLAIM_ERROR_MESSAGES: Record<string, string> = {
  INVALID_OR_EXPIRED_SETUP_LINK:
    "This setup link is invalid, expired or already used. Run `pnpm everyapp setup` with the Cloudflare login that deployed the gateway for a new one.",
  ALREADY_CLAIMED: "This gateway already has an owner. Sign in instead.",
  USER_ALREADY_EXISTS: "An account with this email already exists.",
};

/** POST the claim; the password only ever travels in this JSON body. */
export async function claimGateway(input: {
  token: string;
  name: string;
  email: string;
  password: string;
}): Promise<ClaimResult> {
  const response = await fetch("/api/setup/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.ok) return { ok: true };

  const text = await response.text();
  let body: { error?: string; message?: string } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // Not JSON: fall back to the generic message.
  }

  // Hashing the password can exceed the Worker's CPU limit, and a claim
  // killed that way holds the setup lock until it goes stale
  // (CLAIM_IN_PROGRESS); the caller retries both (see useCpuTimeoutRetry).
  if (
    (response.status >= 500 && /cpu|exceeded/i.test(text)) ||
    body.error === "CLAIM_IN_PROGRESS"
  ) {
    return { ok: false, retry: true };
  }

  return {
    ok: false,
    retry: false,
    message:
      (body.error && CLAIM_ERROR_MESSAGES[body.error]) ??
      body.message ??
      "Failed to set up the gateway. Please try again.",
  };
}
