import React, { createContext, useContext, useMemo } from "react";
import {
  SessionManager,
  SessionManagerConfig,
} from "../core/sessionManager.js";
import { useEveryAppSession } from "./_internal/useEveryAppSession.js";
import { useEveryAppRouter } from "./useEveryAppRouter.js";
import { GatewayRequiredError } from "./GatewayRequiredError.js";

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

  // Check if the app is running outside of the Gateway iframe
  if (!sessionManager.isInIframe) {
    return (
      <GatewayRequiredError
        gatewayOrigin={sessionManager.parentOrigin}
        appId={config.appId}
      />
    );
  }

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

/**
 * Hook to get the current authenticated user.
 * Returns the user's ID and email extracted from the JWT token,
 * or null if not authenticated.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const user = useCurrentUser();
 *
 *   if (!user) {
 *     return <div>Not authenticated</div>;
 *   }
 *
 *   return <div>Welcome, {user.email}</div>;
 * }
 * ```
 */
export function useCurrentUser(): { userId: string; email: string } | null {
  const context = useContext(EmbeddedAppContext);

  if (!context) {
    throw new Error(
      "useCurrentUser must be used within an EmbeddedAppProvider",
    );
  }

  const { sessionManager, sessionTokenState } = context;

  return useMemo(() => {
    // Only return user if we have a valid token
    if (sessionTokenState.status !== "VALID") {
      return null;
    }

    return sessionManager.getUser();
  }, [sessionManager, sessionTokenState]);
}
