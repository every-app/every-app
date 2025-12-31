import { createFileRoute } from "@tanstack/react-router";
import { useSession } from "@/client/hooks/useSession";
import { EmbeddedApp } from "@/client/components/EmbeddedApp";
import { useRef, useEffect } from "react";

/**
 * IMPORTANT: This is a LAYOUT ROUTE that persists across child route changes.
 *
 * This route structure prevents the embedded app iframe from hard-reloading
 * during client-side navigation:
 *
 * - Parent route: /apps/$appId (THIS FILE) - Renders the iframe, stays mounted
 * - Child route:  /apps/$appId/$ ($appId.$.tsx) - Handles sub-paths, can change freely
 *
 * When navigating from /apps/todo-app/history to /apps/todo-app/settings,
 * only the CHILD route component remounts - this PARENT layout stays mounted,
 * keeping the iframe alive. Route changes are communicated via postMessage.
 *
 * For dev mode, use the /apps/$appId/dev route instead (see $appId_.dev.tsx).
 *
 * DO NOT combine these into a single catch-all route or the iframe will reload!
 */
export const Route = createFileRoute("/apps/$appId")({
  component: EmbeddedAppLayout,
});

function EmbeddedAppLayout() {
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

  // The iframe will persist because this layout component doesn't remount
  // when child routes (like /apps/$appId/$) change
  return <EmbeddedApp key={appId} appId={appId} />;
}
