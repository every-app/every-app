import { createFileRoute } from "@tanstack/react-router";
import { useSessionGuard } from "@/client/hooks/useSessionGuard";
import { EmbeddedApp } from "@/client/components/EmbeddedApp";

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
  const { shouldRender } = useSessionGuard();

  if (!shouldRender) {
    return null;
  }

  // Always render in dev mode
  return <EmbeddedApp key={`${appId}-dev`} appId={appId} isDevMode={true} />;
}
