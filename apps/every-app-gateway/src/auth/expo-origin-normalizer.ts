const EVERYAPP_ORIGIN = "everyapp://";
const EXPO_DEV_TRUSTED_ORIGIN = "exp://**";

// Intentionally simple origin policy:
// - Always trust native app origin: everyapp://
// - Trust Expo origin only in local gateway development mode
// - Do not allow dev tunnels or host-based exceptions
// This keeps maintenance low and avoids future rule creep.

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

export function isDevelopmentGatewayUrl(
  gatewayUrl: string | undefined,
): boolean {
  if (!gatewayUrl) {
    return false;
  }

  const parsed = parseUrl(gatewayUrl);
  if (!parsed) {
    return false;
  }

  const hostname = normalizeHostname(parsed.hostname);
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

export function isExpoDevModeEnabled(options: {
  gatewayUrl: string | undefined;
  viteDev: boolean;
}): boolean {
  return options.viteDev && isDevelopmentGatewayUrl(options.gatewayUrl);
}

export function getExpoDevTrustedOrigins(isDevMode: boolean): string[] {
  if (!isDevMode) {
    return [];
  }

  return [EXPO_DEV_TRUSTED_ORIGIN];
}

function isAllowedExpoOrigin(origin: string, isDevMode: boolean): boolean {
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

  if (origin.toLowerCase() === EVERYAPP_ORIGIN) {
    return true;
  }

  if (isDevMode && parsed.protocol === "exp:") {
    return true;
  }

  return false;
}

export function normalizeExpoOrigin(
  request: Request,
  options: { isDevMode: boolean },
): Request {
  if (request.headers.get("origin")) {
    return request;
  }

  const expoOrigin = request.headers.get("expo-origin");
  if (!expoOrigin || !isAllowedExpoOrigin(expoOrigin, options.isDevMode)) {
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
