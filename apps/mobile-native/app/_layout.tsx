import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useMemo, useState } from "react";
import "react-native-reanimated";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { queryClient } from "@/src/lib/query-client";
import { useSessionQuery } from "@/src/hooks/useSessionQuery";
import { getGatewayUrl } from "@/src/lib/gateway-store";
import { hasGatewayConfigured, initAuthClient } from "@/src/lib/auth-client";

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from "expo-router";

export const unstable_settings = {
  initialRouteName: "(main)",
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <RootLayoutNav />
    </QueryClientProvider>
  );
}

function RootLayoutNav() {
  const router = useRouter();
  const segments = useSegments();
  const colorScheme = useColorScheme() ?? "light";
  const colors = Colors[colorScheme];

  const [gatewayLoaded, setGatewayLoaded] = useState(false);

  // Load gateway URL from SecureStore on mount
  useEffect(() => {
    getGatewayUrl().then((url) => {
      if (url) {
        initAuthClient(url);
      }
      setGatewayLoaded(true);
    });
  }, []);

  const hasGateway = gatewayLoaded && hasGatewayConfigured();

  // Only query the session if we have a gateway configured
  const { data: session, isLoading: sessionLoading } =
    useSessionQuery(hasGateway);

  const isLoading = !gatewayLoaded || (hasGateway && sessionLoading);
  const inAuthGroup = useMemo(() => segments[0] === "(auth)", [segments]);
  const onConnectScreen = useMemo(() => segments[0] === "connect", [segments]);

  const navigationTheme = useMemo(() => {
    const baseTheme = colorScheme === "dark" ? DarkTheme : DefaultTheme;

    return {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        primary: colors.primary,
        background: colors.background,
        card: colors.surface,
        text: colors.text,
        border: colors.border,
        notification: colors.primary,
      },
    };
  }, [colorScheme, colors]);

  // Three-way navigation gate
  useEffect(() => {
    if (isLoading) return;

    // No gateway URL configured — must connect first
    if (!hasGateway && !onConnectScreen) {
      router.replace("/connect");
      return;
    }

    // Gateway set but no session — go to sign-in
    if (hasGateway && !session && !inAuthGroup && !onConnectScreen) {
      router.replace("/(auth)/sign-in");
      return;
    }

    // Gateway set and session exists — go to main
    if (hasGateway && session && (inAuthGroup || onConnectScreen)) {
      router.replace("/(main)");
      return;
    }
  }, [isLoading, hasGateway, session, inAuthGroup, onConnectScreen, router]);

  useEffect(() => {
    if (!isLoading) {
      void SplashScreen.hideAsync();
    }
  }, [isLoading]);

  if (isLoading) {
    return (
      <View
        style={[
          styles.loadingContainer,
          { backgroundColor: colors.background },
        ]}
      >
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ThemeProvider value={navigationTheme}>
      <Stack>
        <Stack.Screen name="connect" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(main)" options={{ headerShown: false }} />
        <Stack.Screen name="apps/[appId]" options={{ headerShown: false }} />
        <Stack.Screen name="+not-found" options={{ title: "Not Found" }} />
      </Stack>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
});
