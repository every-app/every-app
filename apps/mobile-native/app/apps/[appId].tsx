import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useQueryClient } from "@tanstack/react-query";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { useUserAppsQuery } from "@/src/hooks/useUserAppsQuery";
import { useSessionQuery } from "@/src/hooks/useSessionQuery";
import {
  isAllowedWebViewUrl,
  isExternalHttpUrl,
  shouldAllowWebViewNavigation,
} from "@/src/hooks/urlTrust";
import { resolveAppById } from "@/src/lib/apps";
import { syncSessionCookieToWebView } from "@/src/lib/webview-cookies";

function toSafeLogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

export default function EmbeddedAppScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ appId?: string }>();
  const appId = params.appId ?? "";
  const colorScheme = useColorScheme() ?? "light";
  const colors = Colors[colorScheme];

  const { data: session } = useSessionQuery();
  const appsQuery = useUserAppsQuery(Boolean(session));

  const webViewRef = useRef<WebView>(null);
  const [webViewKey, setWebViewKey] = useState(0);
  const [cookieSyncAttempt, setCookieSyncAttempt] = useState(0);
  const [cookieState, setCookieState] = useState<"syncing" | "ready" | "error">(
    "syncing",
  );

  const app = useMemo(() => {
    return resolveAppById(appsQuery.data ?? [], appId);
  }, [appId, appsQuery.data]);

  const finalUrl = useMemo(() => {
    if (!app) {
      return null;
    }

    try {
      return new URL(`https://${app.hostname}`).origin;
    } catch {
      return null;
    }
  }, [app]);

  const redirectToSignIn = useCallback(() => {
    queryClient.setQueryData(["auth", "session"], null);
    router.replace("/(auth)/sign-in");
  }, [queryClient, router]);

  const appIsActive = Boolean(app && app.status === "active");

  useEffect(() => {
    if (!appIsActive) {
      return;
    }

    let cancelled = false;
    setCookieState("syncing");

    void syncSessionCookieToWebView()
      .then((didSync) => {
        if (cancelled) {
          return;
        }

        if (!didSync) {
          redirectToSignIn();
          return;
        }

        setCookieState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        console.error("[webview] Failed to sync session cookie:", error);
        setCookieState("error");
      });

    return () => {
      cancelled = true;
    };
    // Keyed on stability, not object identity: an apps-list refetch must not
    // restart the sync and unmount a live WebView.
  }, [appIsActive, appId, cookieSyncAttempt, redirectToSignIn]);

  useEffect(() => {
    if (!appIsActive) {
      return;
    }

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        return;
      }

      void syncSessionCookieToWebView()
        .then((didSync) => {
          if (!didSync) {
            redirectToSignIn();
          }
        })
        .catch((error: unknown) => {
          console.error(
            "[webview] Failed to refresh the session cookie:",
            error,
          );
        });
    });

    return () => subscription.remove();
  }, [appIsActive, redirectToSignIn]);

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

  if (app.status !== "active") {
    return (
      <SafeAreaView
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={styles.centered}>
          <Text style={[styles.errorTitle, { color: colors.text }]}>
            App unavailable
          </Text>
          <Text style={[styles.errorBody, { color: colors.textSecondary }]}>
            This app is currently {app.status}.
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
            Invalid app hostname
          </Text>
          <Text style={[styles.errorBody, { color: colors.textSecondary }]}>
            This app does not have a valid HTTPS hostname.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (cookieState === "syncing") {
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

  if (cookieState === "error") {
    return (
      <SafeAreaView
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={styles.centered}>
          <Text style={[styles.errorTitle, { color: colors.text }]}>
            Unable to open app
          </Text>
          <Text style={[styles.errorBody, { color: colors.textSecondary }]}>
            The session cookie could not be prepared for the WebView.
          </Text>
          <Pressable
            onPress={() => {
              setCookieState("syncing");
              setCookieSyncAttempt((attempt) => attempt + 1);
            }}
            style={styles.retryButton}
          >
            <Text style={{ color: colors.link }}>Try again</Text>
          </Pressable>
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
          <Pressable
            onPress={() => setWebViewKey((key) => key + 1)}
            hitSlop={8}
            style={({ pressed }) => [
              styles.reloadButton,
              pressed && styles.buttonPressed,
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
        onShouldStartLoadWithRequest={(request) => {
          if (shouldAllowWebViewNavigation(request, finalUrl)) {
            return true;
          }

          console.warn(
            `[webview] Blocked navigation to untrusted URL: ${toSafeLogUrl(request.url)}`,
          );

          if (isExternalHttpUrl(request.url)) {
            void WebBrowser.openBrowserAsync(request.url).catch(
              (error: unknown) => {
                console.error("[webview] Failed to open external URL:", error);
              },
            );
          }

          return false;
        }}
        onOpenWindow={(event) => {
          // target="_blank" / window.open does not pass through
          // onShouldStartLoadWithRequest — apply the same policy here.
          const { targetUrl } = event.nativeEvent;

          if (isAllowedWebViewUrl(targetUrl, finalUrl)) {
            webViewRef.current?.injectJavaScript(
              `window.location.href = ${JSON.stringify(targetUrl)}; true;`,
            );
            return;
          }

          console.warn(
            `[webview] Blocked new-window navigation to untrusted URL: ${toSafeLogUrl(targetUrl)}`,
          );

          if (isExternalHttpUrl(targetUrl)) {
            void WebBrowser.openBrowserAsync(targetUrl).catch(
              (error: unknown) => {
                console.error("[webview] Failed to open external URL:", error);
              },
            );
          }
        }}
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
  retryButton: {
    marginTop: 16,
    padding: 8,
  },
  webView: {
    flex: 1,
  },
  reloadButton: {
    padding: 6,
  },
  buttonPressed: {
    opacity: 0.8,
  },
});
