import {
  isCpuTimeoutError,
  CPU_TIMEOUT_ERROR_MESSAGE,
} from "@/components/CpuTimeoutWarning";

/**
 * Wraps an auth call to detect Cloudflare CPU timeout errors from the raw response.
 * Returns both the result and whether a CPU timeout was detected.
 */
export async function withCpuTimeoutDetection<T>(
  authCall: (fetchOptions: {
    onError: (ctx: { response?: Response }) => Promise<void>;
  }) => Promise<T>,
): Promise<{ result: T; isCpuTimeout: boolean }> {
  let isCpuTimeout = false;

  const result = await authCall({
    onError: async (ctx) => {
      try {
        if (ctx.response) {
          const text = await ctx.response.text();
          if (isCpuTimeoutError(text)) {
            isCpuTimeout = true;
          }
        }
      } catch {
        // Ignore errors reading response
      }
    },
  });

  return { result, isCpuTimeout };
}

/**
 * Gets the appropriate error message, prioritizing CPU timeout errors.
 */
export function getAuthErrorMessage(
  isCpuTimeout: boolean,
  errorMessage: string | undefined,
  defaultMessage: string,
): string {
  if (isCpuTimeout) {
    return CPU_TIMEOUT_ERROR_MESSAGE;
  }
  return errorMessage || defaultMessage;
}
