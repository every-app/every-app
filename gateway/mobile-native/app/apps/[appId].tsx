import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { useUserAppsQuery } from "@/src/hooks/useUserAppsQuery";
import { useSessionQuery } from "@/src/hooks/useSessionQuery";
import { resolveAppById } from "@/src/types/messages";
import { useWebViewBridge } from "@/src/hooks/useWebViewBridge";

function toOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isLocalDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function toTrustedEmbeddedOrigin(
  url: string,
  isDevMode: boolean,
): string | null {
  try {
    const parsed = new URL(url);

    if (parsed.protocol === "https:") {
      return parsed.origin;
    }

    if (
      isDevMode &&
      parsed.protocol === "http:" &&
      isLocalDevHost(parsed.hostname)
    ) {
      return parsed.origin;
    }

    return null;
  } catch {
    return null;
  }
}

function toEmbeddedRoute(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "/";
  }
}

function toSafeLogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function isTopFrameNavigationRequest(request: {
  url: string;
  isTopFrame?: boolean;
  mainDocumentURL?: string;
}): boolean {
  if (typeof request.isTopFrame === "boolean") {
    return request.isTopFrame;
  }

  if (
    typeof request.mainDocumentURL === "string" &&
    request.mainDocumentURL.length > 0
  ) {
    return request.url === request.mainDocumentURL;
  }

  return true;
}

const INJECTED_JS = `
  (function () {
    window.isReactNativeWebView = true;
  })();
  true;
`;

export default function EmbeddedAppScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ appId?: string; dev?: string }>();
  const appId = params.appId ?? "";
  // Intentional: production builds also honor ?dev=1 so testers can deep-link
  // directly into embedded dev apps from distributed test/release binaries.
  const startsInDevMode = params.dev === "1";
  const colorScheme = useColorScheme() ?? "light";
  const colors = Colors[colorScheme];

  const { data: session } = useSessionQuery();
  const appsQuery = useUserAppsQuery(Boolean(session));

  const [currentRoute, setCurrentRoute] = useState("/");
  const [isDevMode, setIsDevMode] = useState(startsInDevMode);
  const [webViewKey, setWebViewKey] = useState(0);
  const [currentWebViewUrl, setCurrentWebViewUrl] = useState<string | null>(
    null,
  );

  const app = useMemo(() => {
    return resolveAppById(appsQuery.data ?? [], appId);
  }, [appId, appsQuery.data]);

  useEffect(() => {
    setIsDevMode(startsInDevMode);
  }, [startsInDevMode]);

  const allowedOrigins = useMemo(() => {
    if (!app) {
      return [] as string[];
    }

    // Security: allow only the currently active mode origin. This prevents
    // prod mode from navigating into dev origin (and vice versa) while tokens
    // are being pushed for the selected app context.
    const activeBaseUrl = isDevMode && app.devUrl ? app.devUrl : app.appUrl;
    const activeOrigin = toTrustedEmbeddedOrigin(activeBaseUrl, isDevMode);

    return activeOrigin ? [activeOrigin] : [];
  }, [app, isDevMode]);

  const isAllowedWebViewUrl = useCallback(
    (url: string) => {
      if (!url) {
        return false;
      }

      if (url === "about:blank") {
        return true;
      }

      const origin = toOrigin(url);
      return Boolean(origin && allowedOrigins.includes(origin));
    },
    [allowedOrigins],
  );

  const { webViewRef, handleLoadStart, handleLoadEnd } = useWebViewBridge({
    app: app ?? null,
    isDevMode,
    currentUrl: currentWebViewUrl,
  });

  const finalUrl = useMemo(() => {
    if (!app) {
      return null;
    }

    const activeBaseUrl = isDevMode && app.devUrl ? app.devUrl : app.appUrl;
    const trustedOrigin = toTrustedEmbeddedOrigin(activeBaseUrl, isDevMode);
    if (!trustedOrigin) {
      return null;
    }

    const normalizedBase = activeBaseUrl.endsWith("/")
      ? activeBaseUrl.slice(0, -1)
      : activeBaseUrl;
    const route = currentRoute.startsWith("/")
      ? currentRoute
      : `/${currentRoute}`;
    return `${normalizedBase}${route}`;
  }, [app, currentRoute, isDevMode]);

  useEffect(() => {
    setCurrentWebViewUrl(finalUrl);
  }, [finalUrl]);

  if (!app && appsQuery.isLoading) {
    return (
      <SafeAreaView
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!app) {
    return (
      <SafeAreaView
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={styles.centered}>
          <Text style={[styles.errorTitle, { color: colors.text }]}>
            App not found
          </Text>
          <Text style={[styles.errorBody, { color: colors.textSecondary }]}>
            Could not find app ID: {appId}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!finalUrl) {
    return (
      <SafeAreaView
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={styles.centered}>
          <Text style={[styles.errorTitle, { color: colors.text }]}>
            Invalid app URL
          </Text>
          <Text style={[styles.errorBody, { color: colors.textSecondary }]}>
            This app must use HTTPS, or HTTP localhost in dev mode.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const reportWebViewFailure = (title: string, detail: string) => {
    console.error(`[webview] ${title}: ${detail}`);
    Alert.alert(title, detail, [
      {
        text: "Reload",
        onPress: () => setWebViewKey((key) => key + 1),
      },
      {
        text: "Back",
        style: "cancel",
        onPress: () => router.back(),
      },
    ]);
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: colors.background }]}
      edges={["top"]}
    >
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerSide}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.backButton}
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
            <Text style={[styles.backText, { color: colors.text }]}>Back</Text>
          </Pressable>
        </View>

        <Text
          style={[styles.headerTitle, { color: colors.text }]}
          numberOfLines={1}
        >
          {app.name}
        </Text>

        <View style={[styles.headerSide, styles.headerSideRight]}>
          {app.devUrl ? (
            <Pressable
              onPress={() => {
                setIsDevMode((v) => !v);
                setWebViewKey((key) => key + 1);
              }}
              style={({ pressed }) => [
                styles.headerButton,
                {
                  backgroundColor: colors.surfaceAlt,
                  borderColor: colors.border,
                },
                pressed && styles.headerButtonPressed,
              ]}
            >
              <Text style={[styles.headerButtonText, { color: colors.text }]}>
                {isDevMode ? "Prod" : "Dev"}
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            onPress={() => {
              setWebViewKey((key) => key + 1);
            }}
            hitSlop={8}
            style={({ pressed }) => [
              styles.reloadButton,
              pressed && styles.headerButtonPressed,
            ]}
          >
            <Ionicons name="reload" size={18} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <WebView
        key={webViewKey}
        ref={webViewRef}
        source={{ uri: finalUrl }}
        style={[styles.webView, { backgroundColor: colors.background }]}
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
        onNavigationStateChange={(navigation) => {
          // Security: only trust route updates from allowlisted app origins.
          if (!isAllowedWebViewUrl(navigation.url)) {
            return;
          }

          setCurrentWebViewUrl(navigation.url);
          setCurrentRoute(toEmbeddedRoute(navigation.url));
        }}
        onShouldStartLoadWithRequest={(request) => {
          // Security: block only top-level navigation to non-allowlisted
          // origins so subresources can load normally.
          const maybeTopFrameRequest = request as {
            url: string;
            isTopFrame?: boolean;
            mainDocumentURL?: string;
          };

          if (!isTopFrameNavigationRequest(maybeTopFrameRequest)) {
            return true;
          }

          if (isAllowedWebViewUrl(request.url)) {
            return true;
          }

          console.warn(
            `[webview] Blocked navigation to untrusted URL: ${toSafeLogUrl(request.url)}`,
          );
          return false;
        }}
        injectedJavaScriptBeforeContentLoaded={INJECTED_JS}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        allowsBackForwardNavigationGestures
        mixedContentMode="never"
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        cacheEnabled
        cacheMode="LOAD_CACHE_ELSE_NETWORK"
        startInLoadingState={false}
        onError={(event) => {
          const { description } = event.nativeEvent;
          reportWebViewFailure("Failed to load app", description || finalUrl);
        }}
        onHttpError={(event) => {
          const { statusCode, description, url } = event.nativeEvent;
          const mainDocumentURL = (
            event.nativeEvent as { mainDocumentURL?: unknown }
          ).mainDocumentURL;

          if (
            typeof mainDocumentURL === "string" &&
            mainDocumentURL.length > 0 &&
            url !== mainDocumentURL
          ) {
            return;
          }

          reportWebViewFailure(
            "App returned an HTTP error",
            `${statusCode}: ${description || finalUrl}`,
          );
        }}
        onContentProcessDidTerminate={() => {
          reportWebViewFailure(
            "Web content process terminated",
            "iOS ended the WebView process. Try reloading the app.",
          );
        }}
      />

      {isDevMode ? (
        <View
          style={[
            styles.devTag,
            { backgroundColor: colors.surfaceAlt, borderColor: colors.primary },
          ]}
        >
          <Text style={[styles.devTagText, { color: colors.text }]}>DEV</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  headerSideRight: {
    justifyContent: "flex-end",
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
  },
  backText: {
    fontSize: 17,
    marginLeft: 2,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  errorBody: {
    marginTop: 8,
    textAlign: "center",
    fontSize: 15,
  },
  webView: {
    flex: 1,
  },

  headerButton: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
  },
  reloadButton: {
    padding: 6,
  },
  headerButtonPressed: {
    opacity: 0.8,
  },
  headerButtonText: {
    fontWeight: "600",
    fontSize: 12,
  },
  devTag: {
    position: "absolute",
    right: 14,
    bottom: 18,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  devTagText: {
    fontWeight: "800",
    fontSize: 12,
  },
});
