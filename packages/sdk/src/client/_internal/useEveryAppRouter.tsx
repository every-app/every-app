import { useEffect } from "react";
import { SessionManager } from "../session-manager";
import { useRouter } from "@tanstack/react-router";

interface UseEveryAppRouterParams {
  sessionManager: SessionManager | null;
}
export function useEveryAppRouter({ sessionManager }: UseEveryAppRouterParams) {
  const router = useRouter();
  // Route synchronization effect
  useEffect(() => {
    if (!sessionManager) return;
    // Listen for route sync messages from parent
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== sessionManager.getParentOrigin()) return;

      if (
        event.data.type === "ROUTE_CHANGE" &&
        event.data.direction === "parent-to-child"
      ) {
        const targetRoute = event.data.route;
        const currentRoute = window.location.pathname;

        // Only navigate if the route is different from current location
        if (targetRoute && targetRoute !== currentRoute) {
          router.navigate({ to: targetRoute });
        }
      }
    };

    window.addEventListener("message", handleMessage);

    // Simplified route change detection with 2 reliable methods
    let lastReportedPath = window.location.pathname;

    const handleRouteChange = () => {
      const currentPath = window.location.pathname;

      // Only report if the path actually changed
      if (currentPath === lastReportedPath) {
        return;
      }

      lastReportedPath = currentPath;

      if (window.parent !== window) {
        window.parent.postMessage(
          {
            type: "ROUTE_CHANGE",
            route: currentPath,
            appId: sessionManager.getAppId(),
            direction: "child-to-parent",
          },
          sessionManager.getParentOrigin(),
        );
      }
    };
    // Listen to popstate for browser back/forward
    window.addEventListener("popstate", handleRouteChange);

    // Polling to detect route changes (catches router navigation)
    const pollInterval = setInterval(() => {
      const currentPath = window.location.pathname;
      if (currentPath !== lastReportedPath) {
        handleRouteChange();
      }
    }, 100);

    return () => {
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("popstate", handleRouteChange);
      clearInterval(pollInterval);
    };
  }, [sessionManager]);
}
