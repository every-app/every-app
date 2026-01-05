import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  RouteChangeMessageSchema,
  type ParentToChildMessage,
} from "../utils/embedded-app-types";

/** Extract embedded route from parent pathname */
function extractEmbeddedRoute(pathname: string, appId: string): string {
  const devPrefix = `/apps/${appId}/dev`;
  const prodPrefix = `/apps/${appId}`;

  if (pathname.startsWith(devPrefix)) {
    return pathname.slice(devPrefix.length) || "/";
  }
  if (pathname.startsWith(prodPrefix)) {
    return pathname.slice(prodPrefix.length) || "/";
  }
  return "/";
}

/**
 * Hook to synchronize routing between parent and embedded app
 * Handles both parent-to-child and child-to-parent route changes
 */
export function useRouteSync(
  appId: string,
  appUrl: string | undefined,
  postMessage: (message: ParentToChildMessage) => void,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const isNavigatingFromChild = useRef(false);

  const isDevMode = location.pathname.startsWith(`/apps/${appId}/dev`);
  const embeddedRoute = extractEmbeddedRoute(location.pathname, appId);

  // Listen for route changes from embedded app (child-to-parent)
  useEffect(() => {
    if (!appUrl) return;

    const appOrigin = new URL(appUrl).origin;

    function handleMessageFromIframe(event: MessageEvent) {
      if (event.origin !== appOrigin) return;

      const parseResult = RouteChangeMessageSchema.safeParse(event.data);
      if (!parseResult.success) return;

      const { route, direction, appId: messageAppId } = parseResult.data;
      if (direction !== "child-to-parent" || messageAppId !== appId) return;

      const prefix = isDevMode ? `/apps/${appId}/dev` : `/apps/${appId}`;
      const newParentRoute = prefix + route;

      if (
        newParentRoute !== location.pathname &&
        !isNavigatingFromChild.current
      ) {
        isNavigatingFromChild.current = true;
        navigate({ to: newParentRoute });
      }
    }

    window.addEventListener("message", handleMessageFromIframe);
    return () => window.removeEventListener("message", handleMessageFromIframe);
  }, [appId, appUrl, isDevMode, location.pathname, navigate]);

  // Sync parent route changes to embedded app (parent-to-child)
  useEffect(() => {
    if (isNavigatingFromChild.current) {
      isNavigatingFromChild.current = false;
      return;
    }

    postMessage({
      type: "ROUTE_CHANGE",
      route: embeddedRoute,
      direction: "parent-to-child",
    });
  }, [embeddedRoute, postMessage]);

  return { embeddedRoute };
}
