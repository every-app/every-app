/**
 * Token usage for AI proxy responses, read off the response stream as it is
 * forwarded. Nothing is buffered beyond the last few KB: usage is reported at
 * the end of both JSON responses and SSE streams (the final
 * `response.completed` event, or the last chat chunk when the app asked for
 * `stream_options.include_usage`). Prompts and outputs are never logged.
 */

type AiUsage = { input: number; output: number; total: number };

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
 * Pass `body` through unchanged and call `onDone` with the usage found in
 * its tail once it has been fully read.
 */
export function tapUsage(
  body: ReadableStream<Uint8Array>,
  onDone: (usage: AiUsage | null) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let tail = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(
          -TAIL_BYTES,
        );
      },
      flush() {
        onDone(extractUsage(tail + decoder.decode()));
      },
    }),
  );
}
