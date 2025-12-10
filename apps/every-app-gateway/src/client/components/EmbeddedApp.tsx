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

interface EmbeddedAppProps {
  appId: string;
  height?: string | number;
  className?: string;
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
}) => {
  const { app, isLoading, isError } = useAppConfig(appId);
  const [isEmbeddedAppReady, setIsEmbeddedAppReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const { postMessage } = useIframeMessaging(
    iframeRef,
    app?.appUrl,
    isEmbeddedAppReady,
  );
  const { embeddedRoute } = useRouteSync(appId, app?.appUrl, postMessage);

  // Build iframe URL with initial route, memoized to prevent hard reloads
  const iframeUrl = useMemo(() => {
    if (!app?.appUrl) return null;
    // Remove trailing slash to prevent double slashes (e.g., "https://example.com//")
    const baseUrl = app.appUrl.endsWith("/")
      ? app.appUrl.slice(0, -1)
      : app.appUrl;
    return `${baseUrl}${embeddedRoute}`;
  }, [app?.appUrl]); // Only recalculate if app.appUrl changes, not on route changes

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
    <div className="w-full h-screen flex flex-col">
      <iframe
        ref={iframeRef}
        src={iframeUrl}
        className={`flex-1 w-full bg-base-100 ${className}`}
        title={app.name}
        onLoad={handleIframeLoad}
        sandbox="allow-scripts allow-same-origin allow-forms allow-top-navigation"
      />
    </div>
  );
};
