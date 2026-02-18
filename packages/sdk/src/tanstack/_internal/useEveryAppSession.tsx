import { useEffect, useRef, useState } from "react";
import { SessionManager } from "../../core/sessionManager.js";

interface SessionManagerConfig {
  appId: string;
}

interface UseEveryAppSessionParams {
  sessionManagerConfig: SessionManagerConfig;
}

export function useEveryAppSession({
  sessionManagerConfig,
}: UseEveryAppSessionParams) {
  const sessionManagerRef = useRef<SessionManager>(null);
  const [sessionTokenState, setSessionTokenState] = useState<
    ReturnType<SessionManager["getTokenState"]>
  >({
    status: "NO_TOKEN",
    token: null,
  });

  if (!sessionManagerRef.current && typeof document !== "undefined") {
    sessionManagerRef.current = new SessionManager(sessionManagerConfig);
  }

  const sessionManager = sessionManagerRef.current;

  useEffect(() => {
    if (!sessionManager) return;
    // Skip token requests when not in iframe (unless in demo mode) - the app will show GatewayRequiredError instead
    if (!sessionManager.isInIframe && !sessionManager.isBypassGatewayLocalOnly)
      return;

    const interval = setInterval(() => {
      setSessionTokenState(sessionManager.getTokenState());
    }, 5000);

    sessionManager
      .getToken()
      .then(() => {
        setSessionTokenState(sessionManager.getTokenState());
      })
      .catch((err) => {
        console.error("[EmbeddedProvider] Initial token request failed:", err);
      });

    return () => {
      clearInterval(interval);
    };
  }, [sessionManager]);

  useEffect(() => {
    if (!sessionManager) return;

    // Make sessionManager globally accessible for middleware
    (window as any).__embeddedSessionManager = sessionManager;
  }, [sessionManager]);

  return { sessionManager, sessionTokenState };
}
