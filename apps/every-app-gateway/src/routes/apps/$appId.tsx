import { createFileRoute } from "@tanstack/react-router";
import { useSessionGuard } from "@/client/hooks/useSessionGuard";
import { EmbeddedApp } from "@/client/components/EmbeddedApp";

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
  const { shouldRender } = useSessionGuard();

  if (!shouldRender) {
    return null;
  }

  // The iframe will persist because this layout component doesn't remount
  // when child routes (like /apps/$appId/$) change
  return <EmbeddedApp key={appId} appId={appId} />;
}
