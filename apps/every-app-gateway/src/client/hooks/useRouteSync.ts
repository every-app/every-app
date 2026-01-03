import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  RouteChangeMessageSchema,
  type ParentToChildMessage,
} from "../utils/embedded-app-types";

/**
 * Hook to synchronize routing between parent and embedded app
 * Handles both parent-to-child and child-to-parent route changes
 * @param appId - The ID of the embedded app
 * @param appUrl - The app's configured URL
 * @param postMessage - Function to send messages to the iframe
 * @returns Object containing the current embedded route
 */
export function useRouteSync(
  appId: string,
  appUrl: string | undefined,
  postMessage: (message: ParentToChildMessage) => void,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const isNavigatingFromChild = useRef(false);

  // Detect if we're in dev mode based on URL path
  // /apps/todo-app/dev/... -> dev mode
  // /apps/todo-app/... -> production mode
  const isDevMode = useMemo(() => {
    const devPrefix = `/apps/${appId}/dev`;
    return location.pathname.startsWith(devPrefix);
  }, [location.pathname, appId]);

  // Extract embedded app route from parent route
  // e.g., /apps/todo-app/history -> /history
  // e.g., /apps/todo-app/dev/history -> /history
  const embeddedRoute = useMemo(() => {
    const devPrefix = `/apps/${appId}/dev`;
    const prodPrefix = `/apps/${appId}`;

    if (location.pathname.startsWith(devPrefix)) {
      // Dev mode: strip /apps/{appId}/dev prefix
      const route = location.pathname.slice(devPrefix.length);
      return route || "/";
    } else if (location.pathname.startsWith(prodPrefix)) {
      // Production mode: strip /apps/{appId} prefix
      const route = location.pathname.slice(prodPrefix.length);
      return route || "/";
    }
    return "/";
  }, [location.pathname, appId]);

  // Listen for route changes from embedded app (child-to-parent)
  useEffect(() => {
    if (!appUrl) return;

    const handleMessage = (event: MessageEvent) => {
      // Verify origin matches the embedded app's origin
      if (event.origin !== new URL(appUrl).origin) {
        return;
      }

      // Validate message schema
      const parseResult = RouteChangeMessageSchema.safeParse(event.data);
      if (!parseResult.success) {
        return;
      }

      const { route, direction, appId: messageAppId } = parseResult.data;

      // Only handle child-to-parent messages for this app
      if (direction !== "child-to-parent" || messageAppId !== appId) {
        return;
      }

      // Preserve dev mode in the route
      const newParentRoute = isDevMode
        ? `/apps/${appId}/dev${route}`
        : `/apps/${appId}${route}`;

      // Prevent navigation loops
      if (
        newParentRoute !== location.pathname &&
        !isNavigatingFromChild.current
      ) {
        isNavigatingFromChild.current = true;
        navigate({ to: newParentRoute });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [appId, appUrl, isDevMode, location.pathname, navigate]);

  // Sync parent route changes to embedded app (parent-to-child)
  useEffect(() => {
    // Skip if this navigation came from the child
    if (isNavigatingFromChild.current) {
      isNavigatingFromChild.current = false;
      return;
    }

    // Send route sync message to embedded app
    postMessage({
      type: "ROUTE_CHANGE",
      route: embeddedRoute,
      direction: "parent-to-child",
    });
  }, [embeddedRoute, postMessage]);

  return { embeddedRoute };
}
