/** Small, bounded I/O helpers for talking to apps. */

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Run `work` with an abort signal that fires after `ms`, and stop waiting at
 * that point even if the work ignores the signal.
 */
export async function withTimeout<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

type CappedText =
  { ok: true; text: string; bytes: number } | { ok: false; bytes: number };

/**
 * Read a body as UTF-8 text, giving up (and cancelling) past `maxBytes`, or
 * when `signal` aborts: a deadline covers the body, not just the headers.
 */
export async function readTextCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<CappedText> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, bytes: declared };
  }
  if (!response.body) return { ok: true, text: "", bytes: 0 };

  const reader = response.body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, bytes };
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  return { ok: true, text: text + decoder.decode(), bytes };
}
