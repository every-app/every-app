import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import { GATEWAY_API_URL } from "@/src/config";

export const authClient = createAuthClient({
  baseURL: GATEWAY_API_URL,
  plugins: [
    expoClient({
      scheme: "everyapp",
      storagePrefix: "everyapp",
      storage: SecureStore,
    }),
  ],
});
