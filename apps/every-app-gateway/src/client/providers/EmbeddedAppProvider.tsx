import React, { createContext, useEffect } from "react";
import { useSession } from "../hooks/useSession";
import { userAppsCollection } from "../tanstack-db";
import { useLiveQuery } from "@tanstack/react-db";
import {
  handleSessionTokenRequest,
  sendMessageToWindow,
} from "../utils/session-token-handler";

interface EmbeddedAppContextValue {
  // Empty for now, can be extended if needed
}

const EmbeddedAppContext = createContext<EmbeddedAppContextValue>({});

interface EmbeddedAppProviderProps {
  children: React.ReactNode;
}

export const EmbeddedAppProvider: React.FC<EmbeddedAppProviderProps> = ({
  children,
}) => {
  const { data: session } = useSession();
  const { data: userApps } = useLiveQuery(
    (q) =>
      session?.user ? q.from({ userApp: userAppsCollection }) : undefined,
    [session?.user],
  );

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const response = await handleSessionTokenRequest(event, userApps);
      if (response && event.source) {
        sendMessageToWindow(event.source, response, event.origin);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [userApps]);

  return (
    <EmbeddedAppContext.Provider value={{}}>
      {children}
    </EmbeddedAppContext.Provider>
  );
};
