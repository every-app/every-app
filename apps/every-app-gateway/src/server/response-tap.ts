/**
 * Pass a provider's response body through unchanged while watching it, so
 * what the body reports (tokens, a cost) can be logged and counted when the
 * reading ends.
 *
 * What this can and cannot see. A TransformStream's flush() runs only when
 * the body is read to the end; pumping the body through a ReadableStream of
 * our own also hears a reader in this isolate cancelling (the tests, an app
 * sharing the isolate) and the provider failing mid-body. It does not hear
 * the common case: in workerd, when the consumer on the other side of the
 * HTTP or service-binding boundary stops reading (a closed tab, an app
 * Worker that dropped the body), neither cancel() nor pull() runs again and
 * the request context is torn down; `end` never fires. Checked against
 * miniflare 5.20261006.1 (workerd), single hop and through a service
 * binding, with and without `request_signal_passthrough`. So the call
 * itself is never counted here: the proxies count it the moment the
 * provider answers, under waitUntil, and this tap only adds what the body
 * reported when somebody read it to the end.
 */

/** How the reading of a body ended. */
export type BodyEnd = "done" | "cancelled" | "failed";

export function watchBody(
  body: ReadableStream<Uint8Array>,
  watcher: {
    /** Each chunk, as it is forwarded. */
    chunk(chunk: Uint8Array): void;
    /** Once, however the reading ended. */
    end(how: BodyEnd): void;
  },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  const end = (how: BodyEnd) => {
    if (ended) return;
    ended = true;
    watcher.end(how);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (ended) return;
        end("failed");
        controller.error(error);
        return;
      }
      // Cancelled while waiting on the provider: the stream is closed.
      if (ended) return;
      if (result.done) {
        end("done");
        controller.close();
        return;
      }
      watcher.chunk(result.value);
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      end("cancelled");
      await reader.cancel(reason);
    },
  });
}
