/**
 * Browser caching for an app's fingerprinted assets.
 *
 * Vite, which builds every app the CLI deploys, names a built asset
 * `/assets/<name>-<hash>.<ext>` with an eight-character hash of its
 * content, and the Workers asset server answers it with
 * `Cache-Control: public, max-age=0, must-revalidate` and an ETag. So a
 * browser asks for every chunk again on every page load, and each of those
 * requests is authenticated like any other (the session, the user and the
 * app-access row, three D1 round trips) to answer a 304.
 *
 * A fingerprinted file never changes under its name: a deploy gives a
 * changed file a new one, and the page names the new one. So the perimeter
 * marks such a response `private, max-age=31536000, immutable`: the browser
 * keeps it for a year without asking, and no shared cache stores it (it was
 * served behind the session). Only a 200 or a 304 to a GET or HEAD, on a
 * path of that shape, whose Cache-Control is exactly the asset server's
 * default, is touched: an app that chose its own caching keeps it, a
 * response that names no caching (an app's own route under `/assets/`,
 * say) keeps that too, an HTML document is never an asset, and nothing
 * else about the response changes. The 304 is included so a chunk a
 * browser cached before this rule stops asking too: a browser takes the
 * fresh Cache-Control from a 304.
 */

/** `/assets/<name>-<8 base64url chars>.<ext>` (or its `.map`), as Vite names built files. */
const FINGERPRINTED_ASSET =
  /^\/assets\/[^/]+-([A-Za-z0-9_-]{8})\.(?:m?js|css|json|wasm|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico)(?:\.map)?$/;
/**
 * Eight letters in one case are a word (`sw-register.js`, `icon-maskable.png`,
 * files an app copies unhashed from its `public/`), not a hash: a hash is
 * base64url of a digest and mixes case or carries a digit, `-` or `_` in all
 * but one of a few thousand. Those few lose nothing but this caching.
 */
const ONE_CASE_WORD = /^(?:[a-z]{8}|[A-Z]{8})$/;

/** What the Workers asset server sends when the app chose nothing. */
const ASSET_SERVER_DEFAULT = "public, max-age=0, must-revalidate";

export const IMMUTABLE_ASSET_CACHE_CONTROL =
  "private, max-age=31536000, immutable";

/** Whether a path names a fingerprinted asset. */
export function isFingerprintedAssetPath(pathname: string): boolean {
  const match = FINGERPRINTED_ASSET.exec(pathname);
  return match !== null && !ONE_CASE_WORD.test(match[1]!);
}

function normalizeCacheControl(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

/**
 * The response with `Cache-Control: private, max-age=31536000, immutable`
 * when it is a fingerprinted asset the app left to the asset server's
 * default caching; otherwise the response itself, untouched.
 */
export function cacheFingerprintedAsset(
  method: string,
  pathname: string,
  response: Response,
): Response {
  if (method !== "GET" && method !== "HEAD") return response;
  if (response.status !== 200 && response.status !== 304) return response;
  if (!isFingerprintedAssetPath(pathname)) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) return response;
  const cacheControl = response.headers.get("cache-control");
  if (
    cacheControl === null ||
    normalizeCacheControl(cacheControl) !==
      normalizeCacheControl(ASSET_SERVER_DEFAULT)
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", IMMUTABLE_ASSET_CACHE_CONTROL);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
