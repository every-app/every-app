import { useEffect, useRef, useState } from "react";
import { SessionManager, SessionManagerConfig } from "../session-manager";

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
    const interval = setInterval(() => {
      setSessionTokenState(sessionManager.getTokenState());
    }, 1000);

    const unsubscribe = sessionManager.onDebugEvent(() => {
      setSessionTokenState(sessionManager.getTokenState());
    });

    sessionManager.getToken().catch((err) => {
      console.error("[EmbeddedProvider] Initial token request failed:", err);
    });

    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, [sessionManager]);

  useEffect(() => {
    if (!sessionManager) return;

    // Make sessionManager globally accessible for middleware
    (window as any).__embeddedSessionManager = sessionManager;
  }, [sessionManager]);

  return { sessionManager, sessionTokenState };
}
