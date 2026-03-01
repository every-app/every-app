import * as SecureStore from "expo-secure-store";

const GATEWAY_URL_KEY = "everyapp.gateway_url";

export async function getGatewayUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(GATEWAY_URL_KEY);
}

export async function setGatewayUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(GATEWAY_URL_KEY, url);
}

export async function clearGatewayUrl(): Promise<void> {
  await SecureStore.deleteItemAsync(GATEWAY_URL_KEY);
}
