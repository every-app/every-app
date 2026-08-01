const EVERYAPP_ORIGIN = "everyapp://";

// Intentionally simple origin policy: the only native origin we ever trust is
// the production app scheme everyapp://. No exp:// dev origins, no tunnels,
// no host-based exceptions — the mobile shell requires a dev-client build
// (native modules), and dev-client builds use the everyapp:// scheme too.

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isAllowedExpoOrigin(origin: string): boolean {
  if (/[\u0000-\u0020]/.test(origin)) {
    return false;
  }

  const parsed = parseUrl(origin);
  if (!parsed || parsed.username || parsed.password) {
    return false;
  }

  if (parsed.search || parsed.hash) {
    return false;
  }

  return origin.toLowerCase() === EVERYAPP_ORIGIN;
}

function isHttpUrl(value: string): boolean {
  const parsed = parseUrl(value);
  return (
    parsed !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "https:")
  );
}

/**
 * Better Auth matches non-HTTP trusted origins by prefix, so a trusted
 * `everyapp://` would also accept `everyapp://evil` — and its Expo plugin
 * quietly trusts `exp://` under NODE_ENV=development. Enforce our exact
 * policy before Better Auth sees the request: any custom-scheme origin (or
 * referer, which Better Auth falls back to) must be exactly `everyapp://`.
 */
export function hasDisallowedNativeOrigin(request: Request): boolean {
  for (const header of ["origin", "expo-origin", "referer"]) {
    const value = request.headers.get(header);
    if (!value || value === "null") {
      continue;
    }
    if (!isHttpUrl(value) && value.toLowerCase() !== EVERYAPP_ORIGIN) {
      return true;
    }
  }
  return false;
}

/**
 * The Better Auth Expo client sends the native origin as `expo-origin`
 * instead of `origin`. Promote it so Better Auth's trusted-origin CSRF check
 * sees it, but only for the exact production scheme.
 */
export function normalizeExpoOrigin(request: Request): Request {
  if (request.headers.get("origin")) {
    return request;
  }

  const expoOrigin = request.headers.get("expo-origin");
  if (!expoOrigin || !isAllowedExpoOrigin(expoOrigin)) {
    return request;
  }

  // TODO: Delete this once Better Auth fixes Expo origin override on Workers.
  // Context:
  // - https://github.com/better-auth/better-auth/issues/5568
  // - https://github.com/better-auth/better-auth/issues/7014
  const headers = new Headers(request.headers);
  headers.set("origin", expoOrigin);
  return new Request(request, { headers });
}
