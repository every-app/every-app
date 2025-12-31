import { createFileRoute } from "@tanstack/react-router";
import { useSession } from "@/client/hooks/useSession";
import { EmbeddedApp } from "@/client/components/EmbeddedApp";
import { useRef, useEffect } from "react";

/**
 * Dev mode layout route for embedded apps.
 *
 * This mirrors $appId.tsx but always renders in dev mode.
 * Route structure:
 * - /apps/$appId/dev - This layout (dev mode)
 * - /apps/$appId/dev/$ - Child catch-all for sub-paths
 *
 * The underscore in $appId_ prevents TanStack Router from nesting this
 * under the $appId layout, making it a sibling route instead.
 */
export const Route = createFileRoute("/apps/$appId_/dev")({
  component: EmbeddedAppDevLayout,
});

function EmbeddedAppDevLayout() {
  const { appId } = Route.useParams();
  const { data: session, isPending } = useSession();

  // Track if we've ever had a session to prevent unmounting during refetches
  const hasHadSession = useRef(false);

  useEffect(() => {
    if (session) {
      hasHadSession.current = true;
    }
  }, [session]);

  // On initial load, wait for session
  if (!hasHadSession.current && isPending) {
    return null;
  }

  // If we've had a session before, keep the component mounted even during refetches
  // This prevents the iframe from being destroyed during navigation
  if (!hasHadSession.current && !session) {
    return null;
  }

  // Always render in dev mode
  return <EmbeddedApp key={`${appId}-dev`} appId={appId} isDevMode={true} />;
}
