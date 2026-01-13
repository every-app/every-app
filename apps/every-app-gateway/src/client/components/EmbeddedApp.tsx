import React, {
  useRef,
  useMemo,
  useState,
  useCallback,
  useEffect,
} from "react";
import { useAppConfig } from "../hooks/useAppConfig";
import { useIframeMessaging } from "../hooks/useIframeMessaging";
import { useRouteSync } from "../hooks/useRouteSync";
import { SafariDevModeWarningModal } from "./SafariDevModeWarningModal";

/**
 * Detects if the current browser is Safari.
 * Safari is the only major browser that blocks http:// iframes from https:// pages.
 */
function isSafari(): boolean {
  const ua = navigator.userAgent;
  // Safari includes "Safari" but not "Chrome" or "Chromium" in its user agent
  return (
    ua.includes("Safari") && !ua.includes("Chrome") && !ua.includes("Chromium")
  );
}

/**
 * Checks if a URL is using http:// (insecure) protocol.
 */
function isHttpUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

interface EmbeddedAppProps {
  appId: string;
  className?: string;
  isDevMode?: boolean;
}

const StatusMessage: React.FC<{ message: string; isError?: boolean }> = ({
  message,
  isError = false,
}) => (
  <div className="flex items-center justify-center p-8">
    <p className={isError ? "text-destructive" : "text-muted-foreground"}>
      {message}
    </p>
  </div>
);

export const EmbeddedApp: React.FC<EmbeddedAppProps> = ({
  appId,
  className = "",
  isDevMode = false,
}) => {
  const { app, isLoading, isError } = useAppConfig(appId);
  const [isEmbeddedAppReady, setIsEmbeddedAppReady] = useState(false);
  const [showSafariWarning, setShowSafariWarning] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Determine the base URL to use (dev or production)
  const activeUrl = isDevMode && app?.devUrl ? app.devUrl : app?.appUrl;

  // Show Safari warning when in dev mode with an http:// URL
  useEffect(() => {
    if (isDevMode && activeUrl && isHttpUrl(activeUrl) && isSafari()) {
      setShowSafariWarning(true);
    }
  }, [isDevMode, activeUrl]);

  const { postMessage } = useIframeMessaging(
    iframeRef,
    activeUrl,
    isEmbeddedAppReady,
  );
  const { embeddedRoute } = useRouteSync(appId, activeUrl, postMessage);

  // Build iframe URL with initial route, memoized to prevent hard reloads
  const iframeUrl = useMemo(() => {
    if (!activeUrl) return null;
    // Remove trailing slash to prevent double slashes (e.g., "https://example.com//")
    const baseUrl = activeUrl.endsWith("/")
      ? activeUrl.slice(0, -1)
      : activeUrl;
    return `${baseUrl}${embeddedRoute}`;
  }, [activeUrl]); // Only recalculate if activeUrl changes, not on route changes

  const handleIframeLoad = useCallback(() => {
    setIsEmbeddedAppReady(true);
    postMessage({ type: "EMBEDDED_APP_READY" });
  }, [postMessage]);

  if (isLoading) return null;
  if (isError)
    return <StatusMessage message="Failed to load app configuration" isError />;
  if (!app)
    return <StatusMessage message={`App "${appId}" not found`} isError />;
  if (!iframeUrl)
    return (
      <StatusMessage message={`No URL configured for app "${appId}"`} isError />
    );

  return (
    <div className="w-full h-full flex flex-col bg-base-100 relative">
      <SafariDevModeWarningModal
        open={showSafariWarning}
        onOpenChange={setShowSafariWarning}
      />
      <iframe
        ref={iframeRef}
        src={iframeUrl}
        // Don't show the iframe content until its ready to prevent a white flash in dark mode while its loading
        className={`flex-1 w-full ${isEmbeddedAppReady ? "opacity-100" : "opacity-0"} ${className}`}
        title={app.name}
        onLoad={handleIframeLoad}
        // allow-top-navigation: Required for embedded apps to navigate back to the gateway
        // (e.g., logout redirects) and to support third-party integrations like OAuth flows
        sandbox="allow-scripts allow-same-origin allow-forms allow-top-navigation allow-popups"
      />
    </div>
  );
};
