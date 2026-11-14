/**
 * An app's icon from the Gateway's own address, for the Gateway's pages
 * (the launcher, the sidebar, the consent screens):
 *
 *   GET /app-icon/<app hostname>
 *
 * The app's own host sits behind Cloudflare Access, whose cookie is per
 * host: an `<img>` pointed there loads only in a browser that opened the
 * app recently, and is otherwise sent to Access's login. This address is
 * the Gateway's, so the page that shows the icon already holds what it
 * takes. The file is read from the app's Worker over the one seam
 * (`getAppFetcher`), which goes through neither Access nor the perimeter.
 *
 * The file is the app author's, served from the Gateway's origin, so it is
 * treated as untrusted:
 *
 *  - Only the path the app's manifest names (`icon`), then `/favicon.ico`,
 *    is fetched. Nothing of the request but the hostname chooses anything.
 *  - The app is sent a bare GET: no cookie, no token, no identity, no
 *    public marker, nothing the visitor's browser sent. So the app's static
 *    files answer and its code doesn't (`everyApp()` refuses a request
 *    with neither header), as for `publicAssets`.
 *  - Of the app's answer only the bytes are kept, and only for a 200 with
 *    an image type from a short list, within a size and a time. The
 *    response is written here: no `Set-Cookie`, no header of the app's.
 *  - The response is inert when opened as a page: `nosniff`, and a
 *    `sandbox` policy with `default-src 'none'` (inline styles and `data:`
 *    images stay, which an SVG drawn as an `<img>` needs and neither of
 *    which runs script).
 *  - Whoever may open the app gets its icon, by the perimeter's own check
 *    (`hasAppAccess`), on the browser session alone; anyone else gets the
 *    404 an unknown hostname gets. A page on another origin (an app's
 *    included, which shares the session cookie's site) is refused, so it
 *    can't ask which apps a person opens.
 *
 * Third-party (dispatch) apps get no icon here: their code is kept off the
 * Gateway's origin (docs/security.md, B8), so the page falls back to the
 * app's own address as before.
 */
import {
  getAppFetcher,
  hasBearerCredential,
  isInternalPath,
  logEvent,
  type AppFetcher,
  type RegisteredApp,
  type SessionAuthenticator,
} from "@every-app/perimeter";

export const APP_ICON_PREFIX = "/app-icon/";

/** Launcher icons are a few kilobytes; this is room for a detailed one. */
export const APP_ICON_MAX_BYTES = 512 * 1024;

/** For one file, headers and body: a static file answers in milliseconds. */
export const APP_ICON_TIMEOUT_MS = 3_000;

/**
 * An icon changes when its app redeploys, which nothing here hears about,
 * so a browser keeps one for an hour: a launcher's page loads cost nothing
 * meanwhile, and a new icon shows within the hour (or on a reload). Never
 * a shared cache: the answer depends on who asks.
 */
const FOUND_CACHE = "private, max-age=3600";
/** An app with no icon is asked again sooner: its next deploy may add one. */
const NONE_CACHE = "private, max-age=300";

const INERT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

const IMAGE_TYPES = new Set([
  "image/svg+xml",
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

const FAVICON_PATH = "/favicon.ico";

// What the manifest's `icon` may be (manifest.ts), read again here: the
// row is stored, and this path is fetched with the Gateway's reach.
const MANIFEST_ICON_PATH =
  /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*\.svg$/;

const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface AppIconDeps {
  /** Worker env (carries the apps' service bindings). */
  env: Record<string, unknown>;
  authenticator: Pick<SessionAuthenticator, "authenticate" | "hasAppAccess">;
  /** The registry row a hostname names, or null. */
  resolveApp(hostname: string): Promise<RegisteredApp | null>;
  /** Seam override (tests). Defaults to {@link getAppFetcher}. */
  fetcherFor?(env: Record<string, unknown>, app: RegisteredApp): AppFetcher;
}

function refusal(status: 401 | 404, error: string, cache = "no-store") {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });
}

/** The same answer for a hostname that names no app and one the person can't open. */
const notFound = () => refusal(404, "not_found");

/** The paths the Gateway will ask the app for, in order. */
function iconPaths(app: RegisteredApp): string[] {
  const named = app.manifest.icon;
  return [
    ...(typeof named === "string" &&
    MANIFEST_ICON_PATH.test(named) &&
    !isInternalPath(named.toLowerCase())
      ? [named]
      : []),
    FAVICON_PATH,
  ];
}

function mediaType(header: string | null): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * The body, or null once it is longer than {@link APP_ICON_MAX_BYTES} or
 * the wait is over (`signal`), which also stops the read.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return null;
      if (done) break;
      size += value.byteLength;
      if (size > APP_ICON_MAX_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", stop);
    // Stops an app still sending; nothing to do when it had finished.
    stop();
  }
  const bytes = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type Loaded =
  | { ok: true; type: string; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: "absent" | "too_large" };

async function load(
  fetcher: AppFetcher,
  url: string,
  signal: AbortSignal,
): Promise<Loaded> {
  // Built from nothing: no header of the visitor's request is copied.
  const response = await fetcher.fetch(
    new Request(url, {
      method: "GET",
      headers: { accept: "image/svg+xml, image/*" },
      redirect: "manual",
      signal,
    }),
  );
  const type = mediaType(response.headers.get("content-type"));
  // Anything but the file itself: a 401 from the app's code, a redirect,
  // a single-page app's HTML for a path it doesn't have.
  if (response.status !== 200 || !IMAGE_TYPES.has(type) || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "absent" };
  }
  if (Number(response.headers.get("content-length")) > APP_ICON_MAX_BYTES) {
    void response.body.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }
  const bytes = await readCapped(response.body, signal);
  if (!bytes) return { ok: false, reason: "too_large" };
  if (bytes.byteLength === 0) return { ok: false, reason: "absent" };
  return { ok: true, type, bytes };
}

/** One of the app's files as an icon, or null: absent, not an image, too large, too slow. */
async function fetchIcon(
  fetcher: AppFetcher,
  app: RegisteredApp,
  path: string,
): Promise<{ type: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason: string;
  try {
    // Raced as well as aborted: the wait ends on time whether or not the
    // app's end of the binding hears the signal.
    const loaded = await Promise.race([
      load(fetcher, `https://${app.hostname}${path}`, abort.signal),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), APP_ICON_TIMEOUT_MS);
      }),
    ]);
    if (loaded !== "timeout" && loaded.ok) return loaded;
    if (loaded !== "timeout" && loaded.reason === "absent") return null;
    reason = loaded === "timeout" ? "timeout" : loaded.reason;
  } catch {
    // No binding yet, or the app threw: no icon, as for a missing file.
    reason = "unreachable";
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  logEvent("app.icon_refused", { app: app.appId, path, reason }, "warn");
  return null;
}

/** Answer a request under {@link APP_ICON_PREFIX}. */
export async function serveAppIcon(
  request: Request,
  deps: AppIconDeps,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(APP_ICON_PREFIX)) return notFound();
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const hostname = pathname.slice(APP_ICON_PREFIX.length).toLowerCase();
  if (hostname.length > 253 || !HOSTNAME.test(hostname)) return notFound();
  // The Gateway's own pages ask from its own origin (or a person types the
  // address). A page anywhere else doesn't get to learn, by whether an
  // image loads, which apps the person opens.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return notFound();
  // The browser session only: a token is for the tools and the apps.
  if (hasBearerCredential(request.headers)) {
    return refusal(401, "unauthenticated");
  }
  const session = await deps.authenticator.authenticate(request);
  if (!session) return refusal(401, "unauthenticated");

  let app: RegisteredApp | null;
  try {
    app = await deps.resolveApp(hostname);
  } catch {
    // A row the Gateway can't route, or no registry to read.
    app = null;
  }
  if (!app || app.status !== "active" || app.tier !== "service_binding") {
    return notFound();
  }
  if ((await deps.authenticator.hasAppAccess(session, app)) === false) {
    return notFound();
  }

  let fetcher: AppFetcher;
  try {
    fetcher = (deps.fetcherFor ?? getAppFetcher)(deps.env, app);
  } catch {
    return refusal(404, "no_icon", NONE_CACHE);
  }
  for (const path of iconPaths(app)) {
    const icon = await fetchIcon(fetcher, app, path);
    if (!icon) continue;
    return new Response(method === "HEAD" ? null : icon.bytes, {
      status: 200,
      headers: {
        "content-type": icon.type,
        "cache-control": FOUND_CACHE,
        "content-security-policy": INERT_CSP,
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  }
  return refusal(404, "no_icon", NONE_CACHE);
}
