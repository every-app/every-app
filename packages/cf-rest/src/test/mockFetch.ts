import { vi } from "vitest";

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

/** A Cloudflare API envelope. */
export function envelope(
  result: unknown,
  init: {
    status?: number;
    errors?: Array<{ code?: number; message: string }>;
  } = {},
): Response {
  const status = init.status ?? 200;
  return new Response(
    JSON.stringify({
      success: status < 400,
      errors: init.errors ?? [],
      messages: [],
      result,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * A fetch that answers with `responses` in order (the last one repeats) and
 * keeps every request as a Request, so tests read its method, URL, headers
 * and body exactly as they would go on the wire.
 */
export function mockFetch(
  ...responses: Array<Response | (() => Response) | Error>
) {
  const requests: Request[] = [];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const next = responses.length > 1 ? responses.shift()! : responses[0]!;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next.clone();
    },
  );
  return { fetch: fetchMock as unknown as typeof fetch, requests };
}

export const noSleep = async () => {};
