import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";

// Placeholder URL used before the user configures their gateway.
// The app must call initAuthClient() with a real URL before making any requests.
const PLACEHOLDER_URL = "https://unconfigured.invalid";

let gatewayUrl = PLACEHOLDER_URL;

export let authClient = createClient(PLACEHOLDER_URL);

function createClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    plugins: [
      expoClient({
        scheme: "everyapp",
        storagePrefix: "everyapp",
        storage: SecureStore,
      }),
    ],
  });
}

/**
 * (Re-)initialize the auth client with the user's gateway URL.
 * Must be called before any auth or API operations.
 */
export function initAuthClient(url: string) {
  gatewayUrl = url;
  authClient = createClient(url);
}

/**
 * Returns the currently configured gateway URL.
 * Used by API functions to build request URLs.
 */
export function getGatewayUrl(): string {
  return gatewayUrl;
}

export function hasGatewayConfigured(): boolean {
  return gatewayUrl !== PLACEHOLDER_URL;
}
