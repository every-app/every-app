/**
 * Request bodies the OAuth routes read, capped while they are read: a
 * chunked upload has no Content-Length to refuse it by, and reading one
 * whole could take the isolate, which also serves every app host, past its
 * memory limit. (The library reads `/oauth/token` with `formData()`, uncapped,
 * so that body is read here first.)
 */

/** The body's bytes, or undefined once they pass `maxBytes`. */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The request again with `body` (already read) as its body, so whatever
 * reads it next can't read more.
 */
export function withBody(
  request: Request,
  body: BodyInit,
  headers = new Headers(request.headers),
): Request {
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request.url, { method: request.method, headers, body });
}

/** RFC 6749's error shape, for a body too large to read. */
export function payloadTooLarge(limit: string): Response {
  return Response.json(
    {
      error: "invalid_request",
      error_description: `Request payload too large, must be under ${limit}`,
    },
    { status: 413, headers: { "cache-control": "no-store" } },
  );
}
