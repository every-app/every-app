import React, { useRef, useMemo, useState, useCallback } from "react";
import { X } from "lucide-react";
import { useAppConfig } from "../hooks/useAppConfig";
import { useIframeMessaging } from "../hooks/useIframeMessaging";
import { useRouteSync } from "../hooks/useRouteSync";

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
  const [showDevModeIndicator, setShowDevModeIndicator] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Determine the base URL to use (dev or production)
  const activeUrl = isDevMode && app?.devUrl ? app.devUrl : app?.appUrl;

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
    <div className="w-full h-screen flex flex-col bg-base-100 relative">
      <iframe
        ref={iframeRef}
        src={iframeUrl}
        // Don't show the iframe content until its ready to prevent a white flash in dark mode while its loading
        className={`flex-1 w-full ${isEmbeddedAppReady ? "opacity-100" : "opacity-0"} ${className}`}
        title={app.name}
        onLoad={handleIframeLoad}
        sandbox="allow-scripts allow-same-origin allow-forms allow-top-navigation"
      />
      {isDevMode && showDevModeIndicator && (
        <div className="absolute top-2 right-2 border border-warning/30 bg-warning/10 text-warning px-3 py-1.5 rounded-lg flex items-center gap-2 z-50">
          <span className="text-sm font-medium">Dev</span>
          <button
            onClick={() => setShowDevModeIndicator(false)}
            className="hover:bg-warning/20 rounded p-0.5"
            aria-label="Dismiss dev mode indicator"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};
