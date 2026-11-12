import { createFileRoute, Navigate } from "@tanstack/react-router";

// Where AI connections was before Your connections: the address in the emails
// already sent for connection events.
export const Route = createFileRoute("/_app/settings/connections")({
  component: () => <Navigate to="/connections" replace />,
});
