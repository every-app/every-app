import CookieManager from "@react-native-cookies/cookies";
import { authClient, getGatewayUrl } from "@/src/lib/auth-client";

interface ParsedCookie {
  name: string;
  value: string;
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

// Only Better Auth's own cookies may be broadened to Domain=<gateway-host>;
// anything else keeps whatever scope its origin set and never enters the
// WebView store through us.
function isSyncableCookieName(name: string): boolean {
  return (
    name.startsWith("better-auth.") || name.startsWith("__Secure-better-auth.")
  );
}

export function parseCookieHeader(cookieHeader: string): ParsedCookie[] {
  return cookieHeader.split(";").flatMap((part) => {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 1) {
      return [];
    }

    const name = part.slice(0, separatorIndex).trim();
    if (!name || !isSyncableCookieName(name)) {
      return [];
    }

    return [
      {
        name,
        value: part.slice(separatorIndex + 1).trim(),
      },
    ];
  });
}

export async function syncSessionCookieToWebView(): Promise<boolean> {
  const cookieHeader = authClient.getCookie();
  if (!cookieHeader) {
    return false;
  }

  const cookies = parseCookieHeader(cookieHeader);
  if (cookies.length === 0) {
    return false;
  }

  const gatewayUrl = getGatewayUrl();
  const gateway = new URL(gatewayUrl);
  const isLocalHttp =
    gateway.protocol === "http:" && isLocalHost(gateway.hostname);

  await Promise.all(
    cookies.map(({ name, value }) =>
      CookieManager.set(
        gatewayUrl,
        {
          name,
          value,
          path: "/",
          // Match the browser model: the session cookie is HttpOnly there,
          // so embedded app JS must not be able to read it here either.
          httpOnly: true,
          secure: gateway.protocol === "https:",
          ...(isLocalHttp ? {} : { domain: gateway.hostname }),
        },
        true,
      ),
    ),
  );

  return true;
}

export async function clearWebViewCookies(): Promise<void> {
  await Promise.all([
    CookieManager.clearAll(true),
    CookieManager.clearAll(false),
  ]);
}
