import { useEffect, useRef, useState } from "react";
import { SessionManager } from "../../core/sessionManager.js";

interface SessionManagerConfig {
  appId: string;
}

interface UseEveryAppSessionParams {
  sessionManagerConfig: SessionManagerConfig;
}

type SessionBootstrapGate = Pick<
  SessionManager,
  "isEmbedded" | "isBypassGatewayLocalOnly"
>;

export function shouldBootstrapSession(
  sessionManager: SessionBootstrapGate,
): boolean {
  // Bootstrapping should happen whenever the app is hosted by a trusted container.
  // This intentionally keys off embedded environment semantics (iframe OR RN WebView),
  // not iframe-only detection, so RN can initialize auth from pushed tokens.
  return sessionManager.isEmbedded() || sessionManager.isBypassGatewayLocalOnly;
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
    // Skip token bootstrap when not embedded (unless in demo mode) - the app will show GatewayRequiredError instead
    if (!shouldBootstrapSession(sessionManager)) return;

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
