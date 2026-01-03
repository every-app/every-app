import { useEffect } from "react";
import { useSession } from "./useSession";
import { userAppsCollection } from "../tanstack-db";
import { useLiveQuery } from "@tanstack/react-db";
import {
  handleSessionTokenRequest,
  sendMessageToWindow,
} from "../utils/session-token-handler";

/**
 * Hook that sets up the session token request handler for embedded apps.
 *
 * This listens for SESSION_TOKEN_REQUEST messages from embedded iframes
 * and responds with signed JWT tokens for authentication.
 *
 * Should be called once at the app root level.
 */
export function useSessionTokenHandler() {
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
}
