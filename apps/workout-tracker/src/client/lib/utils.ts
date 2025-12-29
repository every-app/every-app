/**
 * Capitalizes the first letter of a string.
 */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Top-level routes that are "siblings" in the navigation hierarchy
const TOP_LEVEL_ROUTES = ["/", "/programs", "/history"];

// Route depth hierarchy for determining transition direction
function getRouteDepth(pathname: string): number {
  // Home, Programs list, History are depth 0
  if (TOP_LEVEL_ROUTES.includes(pathname)) return 0;

  // /workout is depth 1 (drilling into a workout from home)
  if (pathname === "/workout") return 1;

  // /programs/$programId is depth 1
  if (pathname.match(/^\/programs\/[^/]+$/)) return 1;

  // /templates/$templateId is depth 1
  if (pathname.match(/^\/templates\/[^/]+$/)) return 1;

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
  // Navigating deeper (e.g., programs -> programs/$id, or home -> workout)
  if (toDepth > fromDepth) {
    return "slide-left";
  }

  // Navigating back up (e.g., programs/$id -> programs, or workout -> home)
  if (toDepth < fromDepth) {
    return "slide-right";
  }

  // Same level navigation - use fade
  return "fade";
}
