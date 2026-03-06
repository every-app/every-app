import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

/**
 * Helper to check if an error message matches Cloudflare Worker CPU timeout patterns.
 */
function matchesCpuTimeoutMessage(error: string | null | undefined): boolean {
  if (!error) return false;
  const lowerError = error.toLowerCase();
  return (
    lowerError.includes("cpu time limit") ||
    lowerError.includes("exceeded cpu") ||
    lowerError.includes("worker exceeded") ||
    lowerError.includes("exceeded resource limits")
  );
}

/**
 * Check if an error is a Cloudflare Worker CPU timeout error.
 * Works with CpuTimeoutError instances, Error objects, or strings.
 */
export function isCpuTimeoutError(err: unknown): boolean {
  if (err instanceof CpuTimeoutError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return matchesCpuTimeoutMessage(message);
}

/**
 * Custom error class for Cloudflare CPU timeout errors.
 * This allows consumers to easily identify and handle these specific errors.
 */
class CpuTimeoutError extends Error {
  constructor() {
    super(
      "The server is experiencing high load. Please wait a moment and try again.",
    );
    this.name = "CpuTimeoutError";
  }
}

const authClient = createAuthClient({
  // This client should only be used in client-side code which will always have a window.
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
  plugins: [organizationClient()],
  fetchOptions: {
    onResponse: async (ctx) => {
      // Continue unless it's potentially a Cloudflare error
      if (ctx.response.status < 500) {
        return;
      }

      const text = await ctx.response?.clone().text();
      if (matchesCpuTimeoutMessage(text)) {
        throw new CpuTimeoutError();
      }
    },
  },
});

export { authClient };
