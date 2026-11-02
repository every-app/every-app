import { EVENT_RESPONSE_KEEP_CHARS } from "@every-app/sdk/internal";

/**
 * What one attempt at one sink reports back to the delivery loop
 * (deliver.ts): delivered with the receiver's status (or, for the email
 * sink, how many recipients were mailed), or failed with the code the
 * delivery row keeps in `last_error` and whether retrying can help. The
 * helpers below read and describe an HTTP answer for the webhook and app
 * sinks alike.
 */
export type SinkResult =
  | { ok: true; statusCode: number | null }
  | {
      ok: false;
      statusCode: number | null;
      /** `timeout`, `redirect`, `status_500`, `email_budget_exhausted`, … and up to 200 characters of the answer. */
      error: string;
      /** No retry will help (a 410, an unconfigured sender): dead at once. */
      dead: boolean;
    };

/** Up to `maxBytes` of a response body, as text; cancels the rest. */
export async function readHead(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(Math.min(bytes, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const room = joined.length - offset;
    if (room <= 0) break;
    joined.set(chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  return new TextDecoder().decode(joined);
}

/** `<code>: <the start of the answer>`, on one line, bounded. */
export function describeAnswer(code: string, answer: string): string {
  const excerpt = answer
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EVENT_RESPONSE_KEEP_CHARS);
  return excerpt ? `${code}: ${excerpt}` : code;
}
