import React, { createContext, useEffect } from "react";
import { SessionManager, SessionManagerConfig } from "./session-manager";
import { useEveryAppSession } from "./_internal/useEveryAppSession";
import { useEveryAppRouter } from "./_internal/useEveryAppRouter";

interface EmbeddedProviderConfig extends SessionManagerConfig {
  children: React.ReactNode;
}

interface EmbeddedAppContextValue {
  sessionManager: SessionManager;
  isAuthenticated: boolean;
  sessionTokenState: ReturnType<SessionManager["getTokenState"]>;
}

const EmbeddedAppContext = createContext<EmbeddedAppContextValue | null>(null);

export function EmbeddedAppProvider({
  children,
  ...config
}: EmbeddedProviderConfig) {
  const { sessionManager, sessionTokenState } = useEveryAppSession({
    sessionManagerConfig: config,
  });
  useEveryAppRouter({ sessionManager });

  if (!sessionManager) return null;

  const value: EmbeddedAppContextValue = {
    sessionManager,
    isAuthenticated: sessionTokenState.status === "VALID",
    sessionTokenState,
  };

  return (
    <EmbeddedAppContext.Provider value={value}>
      {children}
    </EmbeddedAppContext.Provider>
  );
}
