import { createFileRoute } from "@tanstack/react-router";

/**
 * Child catch-all route for dev mode sub-paths like /apps/todo-app/dev/history
 *
 * This mirrors $appId.$.tsx but for the dev mode route.
 * When this route changes, TanStack Router only remounts THIS component,
 * while the parent layout ($appId_.dev.tsx) stays mounted, preserving the iframe.
 *
 * See $appId_.dev.tsx for more details on this routing pattern.
 */
export const Route = createFileRoute("/apps/$appId_/dev/$")({
  component: () => null, // Parent layout handles all rendering
});
