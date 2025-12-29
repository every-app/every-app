// Top-level routes that are "siblings" in the navigation hierarchy
const TOP_LEVEL_ROUTES = ["/", "/history"];

// Route depth hierarchy for determining transition direction
function getRouteDepth(pathname: string): number {
  // Home, History are depth 0
  if (TOP_LEVEL_ROUTES.includes(pathname)) return 0;

  // Default to depth 1 for any other nested routes
  return 1;
}

type TransitionType = "fade" | "slide-left" | "slide-right";

interface ViewTransitionOptions {
  from: string;
  to: string;
  isMobile: boolean;
}

/**
 * Determines the appropriate transition type based on navigation context
 *
 * Mobile: Full slide animations for drilling down (native app feel)
 * Desktop: Fade for everything (snappier web-like behavior)
 */
export function getTransitionType({
  from,
  to,
  isMobile,
}: ViewTransitionOptions): TransitionType {
  const fromDepth = getRouteDepth(from);
  const toDepth = getRouteDepth(to);

  // Desktop: Always use fade for cleaner, snappier feel
  if (!isMobile) {
    return "fade";
  }

  // Mobile: Use slides for hierarchical navigation
  // Navigating deeper (e.g., home -> detail)
  if (toDepth > fromDepth) {
    return "slide-left";
  }

  // Navigating back up (e.g., detail -> home)
  if (toDepth < fromDepth) {
    return "slide-right";
  }

  // Same level navigation - use fade
  return "fade";
}
