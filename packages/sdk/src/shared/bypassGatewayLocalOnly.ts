export const BYPASS_GATEWAY_LOCAL_ONLY_TOKEN = "BYPASS_GATEWAY_LOCAL_ONLY";
export const BYPASS_GATEWAY_LOCAL_ONLY_USER_ID = "demo-local-user";
export const BYPASS_GATEWAY_LOCAL_ONLY_EMAIL = "demo-local-user@local";

export function isBypassGatewayLocalOnlyClient(): boolean {
  if (import.meta.env.PROD) {
    return false;
  }

  const metaEnv = (import.meta as { env?: Record<string, string | undefined> })
    .env;

  return (
    metaEnv?.VITE_BYPASS_GATEWAY_LOCAL_ONLY === "true" ||
    metaEnv?.BYPASS_GATEWAY_LOCAL_ONLY === "true"
  );
}

export function isBypassGatewayLocalOnlyServer(): boolean {
  if (import.meta.env.PROD) {
    return false;
  }

  const metaEnv = (import.meta as { env?: Record<string, string | undefined> })
    .env;
  const metaValue =
    metaEnv?.BYPASS_GATEWAY_LOCAL_ONLY ??
    metaEnv?.VITE_BYPASS_GATEWAY_LOCAL_ONLY;
  if (metaValue === "true") {
    return true;
  }

  if (
    typeof process !== "undefined" &&
    process.env?.BYPASS_GATEWAY_LOCAL_ONLY === "true"
  ) {
    return true;
  }

  return false;
}

export function createBypassGatewayLocalOnlySessionPayload(audience: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 60 * 60;

  return {
    sub: BYPASS_GATEWAY_LOCAL_ONLY_USER_ID,
    email: BYPASS_GATEWAY_LOCAL_ONLY_EMAIL,
    iss: "local",
    aud: audience,
    iat: issuedAt,
    exp: expiresAt,
  };
}
