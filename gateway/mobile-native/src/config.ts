const runtimeEnv =
  (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env ?? {};

const isDevRuntime =
  (globalThis as { __DEV__?: boolean }).__DEV__ === true ||
  runtimeEnv.NODE_ENV === "development";

function isLocalDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

export const GATEWAY_API_URL =
  runtimeEnv.EXPO_PUBLIC_GATEWAY_URL ?? "https://your-gateway.example.com";

let parsedGatewayUrl: URL;
try {
  parsedGatewayUrl = new URL(GATEWAY_API_URL);
} catch {
  throw new Error(
    "[gateway-mobile-native] EXPO_PUBLIC_GATEWAY_URL is invalid.",
  );
}

const isHttps = parsedGatewayUrl.protocol === "https:";
const isAllowedHttpLocal =
  isDevRuntime &&
  parsedGatewayUrl.protocol === "http:" &&
  isLocalDevHost(parsedGatewayUrl.hostname);

if (!isHttps && !isAllowedHttpLocal) {
  throw new Error(
    "[gateway-mobile-native] EXPO_PUBLIC_GATEWAY_URL must use https:// (or http://localhost in development).",
  );
}

if (GATEWAY_API_URL === "https://your-gateway.example.com") {
  console.warn(
    "[gateway-mobile-native] EXPO_PUBLIC_GATEWAY_URL is not configured. " +
      "Set it in .env to connect to your gateway.",
  );
}
