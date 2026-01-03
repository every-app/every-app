import { useEffect, useRef } from "react";
import { useSession } from "./useSession";

/**
 * Hook to guard components that require authentication.
 *
 * This hook tracks if we've ever had a valid session to prevent
 * unmounting during session refetches. This is important for
 * components like embedded app iframes that should stay mounted
 * even during background session validation.
 *
 * @returns Object with session data and shouldRender flag
 */
export function useSessionGuard() {
  const { data: session, isPending } = useSession();

  // Track if we've ever had a session to prevent unmounting during refetches
  const hasHadSession = useRef(false);

  useEffect(() => {
    if (session) {
      hasHadSession.current = true;
    }
  }, [session]);

  // On initial load, don't render until we know the session state
  // Once we've had a session, keep rendering even during refetches
  const shouldRender = hasHadSession.current || (!isPending && !!session);

  return {
    session,
    shouldRender,
    isPending,
  };
}
