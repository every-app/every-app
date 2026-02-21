import { useCallback, useEffect, useRef } from "react";
import type { WebView } from "react-native-webview";
import { createSessionToken } from "@/src/api/gateway";
import type { AppConfig } from "@/src/types/gateway";
import { type NativeToWebViewMessage } from "@/src/types/messages";
import { isTrustedCurrentUrlForTokenPush } from "./urlTrust";

interface UseWebViewBridgeOptions {
  app: AppConfig | null;
  isDevMode: boolean;
  currentUrl: string | null;
}

export function useWebViewBridge({
  app,
  isDevMode,
  currentUrl,
}: UseWebViewBridgeOptions) {
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const loadEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRequestVersionRef = useRef(0);
  const issueAndPushTokenRef = useRef<(() => Promise<void>) | null>(null);

  const clearLoadEndTimeout = useCallback(() => {
    if (loadEndTimeoutRef.current) {
      clearTimeout(loadEndTimeoutRef.current);
      loadEndTimeoutRef.current = null;
    }
  }, []);

  const clearRefreshTimeout = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
      refreshTimeoutRef.current = null;
    }
  }, []);

  const getActiveOrigin = useCallback(() => {
    if (!app) {
      return null;
    }

    const appUrl = isDevMode && app.devUrl ? app.devUrl : app.appUrl;
    try {
      return new URL(appUrl).origin;
    } catch {
      return null;
    }
  }, [app, isDevMode]);

  const isCurrentUrlTrustedForTokenPush = useCallback(() => {
    const activeOrigin = getActiveOrigin();
    if (!activeOrigin) {
      return false;
    }

    return isTrustedCurrentUrlForTokenPush(currentUrl, activeOrigin);
  }, [currentUrl, getActiveOrigin]);

  const scheduleTokenRefresh = useCallback(
    (expiresAt?: string) => {
      clearRefreshTimeout();

      // Refresh 20s before expiry with a minimum retry delay.
      const minDelayMs = 5000;
      const fallbackDelayMs = 30000;
      const refreshBufferMs = 20000;

      const parsedExpiry = expiresAt ? new Date(expiresAt).getTime() : NaN;
      const delayMs = Number.isNaN(parsedExpiry)
        ? fallbackDelayMs
        : Math.max(minDelayMs, parsedExpiry - Date.now() - refreshBufferMs);

      refreshTimeoutRef.current = setTimeout(() => {
        void issueAndPushTokenRef.current?.();
      }, delayMs);
    },
    [clearRefreshTimeout],
  );

  const postMessage = useCallback((message: NativeToWebViewMessage) => {
    if (!webViewRef.current || !readyRef.current) {
      return;
    }

    const js = `
      (function () {
        window.dispatchEvent(new MessageEvent("message", {
          data: ${JSON.stringify(message)},
          origin: "react-native"
        }));
      })();
      true;
    `;

    webViewRef.current.injectJavaScript(js);
  }, []);

  const issueAndPushToken = useCallback(async () => {
    // Guards against async races: if a newer token request starts while this
    // one is in-flight, this request's response/retry path is ignored.
    const requestVersion = ++tokenRequestVersionRef.current;

    if (!readyRef.current) {
      return;
    }

    if (!app) {
      return;
    }

    // Security: only push tokens when the currently loaded document origin
    // matches the active app mode origin exactly.
    if (!isCurrentUrlTrustedForTokenPush()) {
      scheduleTokenRefresh();
      return;
    }

    try {
      const origin = getActiveOrigin();
      if (!origin) {
        scheduleTokenRefresh();
        return;
      }

      // Security: appId and origin are derived from native-selected app config,
      // never from web content.
      const token = await createSessionToken(app.appId, origin);

      // Ignore stale async responses after mode/url/load-state changes.
      if (
        requestVersion !== tokenRequestVersionRef.current ||
        !readyRef.current
      ) {
        return;
      }

      postMessage({
        type: "SESSION_TOKEN_UPDATE",
        token: token.token,
        expiresAt: token.expiresAt,
        audience: token.audience,
        appId: token.appId,
      });

      scheduleTokenRefresh(token.expiresAt);
    } catch (error) {
      if (
        requestVersion !== tokenRequestVersionRef.current ||
        !readyRef.current
      ) {
        return;
      }

      // Keep retrying on transient failures (network, temporary auth issues).
      console.error(
        "[webview-bridge] Failed to issue/push session token:",
        error,
      );
      scheduleTokenRefresh();
    }
  }, [
    app,
    getActiveOrigin,
    isCurrentUrlTrustedForTokenPush,
    postMessage,
    scheduleTokenRefresh,
  ]);

  useEffect(() => {
    issueAndPushTokenRef.current = issueAndPushToken;
  }, [issueAndPushToken]);

  const handleLoadStart = useCallback(() => {
    clearLoadEndTimeout();
    readyRef.current = false;
    clearRefreshTimeout();
  }, [clearLoadEndTimeout, clearRefreshTimeout]);

  const handleLoadEnd = useCallback(() => {
    clearLoadEndTimeout();

    loadEndTimeoutRef.current = setTimeout(() => {
      if (!readyRef.current) {
        readyRef.current = true;
        postMessage({ type: "EMBEDDED_APP_READY" });
        void issueAndPushToken();
      }
      loadEndTimeoutRef.current = null;
    }, 600);
  }, [clearLoadEndTimeout, issueAndPushToken, postMessage]);

  useEffect(() => {
    if (readyRef.current) {
      void issueAndPushToken();
    }

    return () => {
      clearLoadEndTimeout();
      clearRefreshTimeout();
    };
  }, [clearLoadEndTimeout, clearRefreshTimeout, issueAndPushToken]);

  return {
    webViewRef,
    handleLoadStart,
    handleLoadEnd,
  };
}
