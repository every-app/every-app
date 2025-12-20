import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";

/**
 * Helper to check if an error is a Cloudflare Worker CPU timeout error.
 * Cloudflare returns error 1102 "Worker exceeded resource limits" when
 * CPU time limits are exceeded on the free plan.
 */
function isCpuTimeoutError(error: string | null | undefined): boolean {
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
 * Custom error class for Cloudflare CPU timeout errors.
 * This allows consumers to easily identify and handle these specific errors.
 */
export class CpuTimeoutError extends Error {
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
  plugins: [adminClient()],
  fetchOptions: {
    onError: async (ctx) => {
      // Check for Cloudflare CPU timeout (503 with specific error content)
      if (ctx.response?.status === 503) {
        try {
          const text = await ctx.response.clone().text();
          if (isCpuTimeoutError(text)) {
            throw new CpuTimeoutError();
          }
        } catch (e) {
          // If it's already a CpuTimeoutError, re-throw it
          if (e instanceof CpuTimeoutError) {
            throw e;
          }
          // Otherwise ignore errors reading response body
        }
      }
    },
  },
});

export { authClient };
