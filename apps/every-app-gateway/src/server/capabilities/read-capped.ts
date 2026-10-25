/**
 * The request body as text, or null once it passes `maxBytes`: a declared
 * Content-Length past the cap is refused unread, and the body is counted
 * as it streams, so one that lies about (or omits) its length still stops
 * at the cap. The email capability and the app emit route read bodies
 * with it before parsing, so an app can't make the gateway parse
 * megabytes to answer 413.
 */
export async function readCapped(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
