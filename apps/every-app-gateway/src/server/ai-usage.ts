/**
 * Token usage for AI proxy responses, read off the response stream as it is
 * forwarded. Nothing is buffered beyond the last few KB: usage is reported at
 * the end of both JSON responses and SSE streams (the final
 * `response.completed` event, or the last chat chunk when the app asked for
 * `stream_options.include_usage`). Prompts and outputs are never logged.
 */

import { watchBody, type BodyEnd } from "./response-tap";

export type AiUsage = { input: number; output: number; total: number };

const TAIL_BYTES = 16 * 1024;

const USAGE_FIELDS: Record<string, keyof AiUsage> = {
  input_tokens: "input",
  prompt_tokens: "input",
  output_tokens: "output",
  completion_tokens: "output",
  total_tokens: "total",
};

/** The last usage numbers reported in a response body (or its tail). */
export function extractUsage(text: string): AiUsage | null {
  const found: Partial<AiUsage> = {};
  const pattern =
    /"(input_tokens|prompt_tokens|output_tokens|completion_tokens|total_tokens)"\s*:\s*(\d+)/g;
  for (const match of text.matchAll(pattern)) {
    const field = USAGE_FIELDS[match[1]!];
    if (field) found[field] = Number(match[2]);
  }
  if (found.input === undefined && found.output === undefined) return null;
  const input = found.input ?? 0;
  const output = found.output ?? 0;
  return { input, output, total: found.total ?? input + output };
}

/**
 * Pass `body` through unchanged and call `onDone` once with the usage found
 * in its tail, when the body has been read to the end, or with what the
 * tail held when a reader in this isolate gave up or the provider failed
 * mid-body. A browser or app Worker that stops reading on the other side
 * of the boundary is not heard at all (see response-tap.ts), which is why
 * the call is counted when the provider answers, and the tap only adds the
 * tokens.
 */
export function tapUsage(
  body: ReadableStream<Uint8Array>,
  onDone: (usage: AiUsage | null, ended: BodyEnd) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let tail = "";
  return watchBody(body, {
    chunk(chunk) {
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(
        -TAIL_BYTES,
      );
    },
    end(how) {
      onDone(extractUsage(tail + decoder.decode()), how);
    },
  });
}
