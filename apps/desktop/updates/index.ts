// updates.everyapp.com: the desktop app's public update feed (docs/release.md, "Update feed").
// electron-updater reads <channel>/latest-mac.yml, then downloads the zip for its architecture, with
// Range requests for blockmap differential downloads. Files live in the R2 bucket bound as UPDATES,
// under <channel>/. <channel>/download/arm64 and /x64 redirect to the current DMG: the download links.
// Read-only: uploads are `wrangler r2 object put`, printed by scripts/release-mac.sh.

/** Feeds served. "mac" is baked into every build signed by Ben's personal team; a feed for
 * another signing team gets its own channel, since Squirrel.Mac refuses an update signed by a
 * different team. */
const CHANNELS = new Set(["mac"]);

/** A release version: 1.2.3, or 1.2.3-beta.1. */
const VERSION = String.raw`\d{1,4}\.\d{1,4}\.\d{1,4}`;
/** "-universal", "-mac", "-beta.1", …: letters and digits, dots only between them. */
const PART = String.raw`-[0-9A-Za-z]{1,32}(?:\.[0-9A-Za-z]{1,32})*`;
/** `EveryApp-<version>[-…].zip|dmg` and their blockmaps. No `/`, no `..`, nothing else. */
const RELEASE_FILE = new RegExp(String.raw`^EveryApp-${VERSION}(?:${PART}){0,4}\.(?:zip|dmg)(?:\.blockmap)?$`);
const MANIFEST = "latest-mac.yml";

function isUpdateFile(name: string): boolean {
  return name.length <= 128 && (name === MANIFEST || RELEASE_FILE.test(name));
}

/** The R2 key for a request path, or null for anything that isn't a feed file. */
export function keyFor(pathname: string): string | null {
  const match = /^\/([a-z0-9-]{1,32})\/([^/]+)$/.exec(pathname);
  if (!match || !CHANNELS.has(match[1]!) || !isUpdateFile(match[2]!)) return null;
  return `${match[1]}/${match[2]}`;
}

function contentType(name: string): string {
  if (name.endsWith(".yml")) return "text/yaml; charset=utf-8";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  return "application/octet-stream";
}

/** The manifest changes with every release, so it's always revalidated. A release file never
 * changes once uploaded (its name holds the version), so it caches for a year. */
function cacheControl(name: string): string {
  return name === MANIFEST ? "public, no-cache" : "public, max-age=31536000, immutable";
}

// The slice of the Workers R2 API used here (kept local so tests can fake it).
interface R2Object {
  size: number;
  httpEtag: string;
  uploaded: Date;
}
interface R2ObjectBody extends R2Object {
  body: ReadableStream;
}
export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: { range: { offset: number; length: number } }): Promise<R2ObjectBody | null>;
}
export interface Env {
  UPDATES: R2Bucket;
}

function headersFor(name: string, object: R2Object): Headers {
  return new Headers({
    "content-type": contentType(name),
    "cache-control": cacheControl(name),
    "accept-ranges": "bytes",
    etag: object.httpEtag,
    "last-modified": object.uploaded.toUTCString(),
  });
}

const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });

/** One `bytes=` range as [start, end] inclusive; "unsatisfiable" past the end; null to ignore the
 * header and send the whole file (malformed, or several ranges, which electron-updater doesn't ask for). */
export function parseRange(header: string, size: number): [number, number] | "unsatisfiable" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size) return "unsatisfiable";
  if (end < start) return null;
  return [start, end];
}

/** The current release's DMG for an architecture, from the channel's latest-mac.yml. */
async function latestDmg(channel: string, arch: string, env: Env): Promise<Response> {
  const manifest = await env.UPDATES.get(`${channel}/${MANIFEST}`);
  if (!manifest) return plain(404, "Not found");
  const text = await new Response(manifest.body).text();
  const dmg = [...text.matchAll(/^\s*- url: (\S+)$/gm)].map((m) => m[1]!).find((url) => url.endsWith(`-${arch}.dmg`));
  if (!dmg || !isUpdateFile(dmg)) return plain(404, "Not found");
  return new Response(null, { status: 302, headers: { location: `/${channel}/${dmg}`, "cache-control": "no-store" } });
}

export async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed", { allow: "GET, HEAD" });
  const { pathname } = new URL(request.url);
  if (pathname === "/") return Response.redirect("https://everyapp.com", 302);
  const download = /^\/([a-z0-9-]{1,32})\/download\/(arm64|x64)$/.exec(pathname);
  if (download && CHANNELS.has(download[1]!)) return latestDmg(download[1]!, download[2]!, env);
  const key = keyFor(pathname);
  if (!key) return plain(404, "Not found");
  const name = key.slice(key.indexOf("/") + 1);

  const rangeHeader = request.headers.get("range");
  if (request.method === "HEAD" || rangeHeader) {
    const head = await env.UPDATES.head(key);
    if (!head) return plain(404, "Not found");
    const headers = headersFor(name, head);
    if (request.method === "HEAD") {
      headers.set("content-length", String(head.size));
      return new Response(null, { headers });
    }
    const range = parseRange(rangeHeader!, head.size);
    if (range === "unsatisfiable") return plain(416, "Range not satisfiable", { "content-range": `bytes */${head.size}` });
    if (range) {
      const [start, end] = range;
      const object = await env.UPDATES.get(key, { range: { offset: start, length: end - start + 1 } });
      if (!object) return plain(404, "Not found");
      headers.set("content-range", `bytes ${start}-${end}/${head.size}`);
      headers.set("content-length", String(end - start + 1));
      return new Response(object.body, { status: 206, headers });
    }
  }

  const object = await env.UPDATES.get(key);
  if (!object) return plain(404, "Not found");
  const headers = headersFor(name, object);
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

export default { fetch: handle };
