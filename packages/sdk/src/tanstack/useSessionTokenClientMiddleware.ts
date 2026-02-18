import { createMiddleware } from "@tanstack/react-start";
import type { SessionManager } from "../core/sessionManager.js";
import {
  BYPASS_GATEWAY_LOCAL_ONLY_TOKEN,
  isBypassGatewayLocalOnlyClient,
} from "../shared/bypassGatewayLocalOnly.js";

export const useSessionTokenClientMiddleware = createMiddleware({
  type: "function",
}).client(async ({ next }) => {
  if (isBypassGatewayLocalOnlyClient()) {
    return next({
      headers: {
        Authorization: `Bearer ${BYPASS_GATEWAY_LOCAL_ONLY_TOKEN}`,
      },
    });
  }

  // Get the global sessionManager - this MUST be available for embedded apps
  const sessionManager = (window as any)
    .__embeddedSessionManager as SessionManager;

  if (!sessionManager) {
    throw new Error(
      "[AuthMiddleware] SessionManager not available - embedded provider not initialized",
    );
  }

  // INVARIANT: This is just an extra check and should never be the case if the sessionManager exists.
  if (typeof sessionManager.getToken !== "function") {
    throw new Error(
      "[AuthMiddleware] SessionManager.getToken is not a function",
    );
  }

  const token = await sessionManager.getToken();

  return next({
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
});
