import { createFileRoute, Navigate } from "@tanstack/react-router";

// Where Connected accounts was before Connections: the address a connect
// link from an earlier CLI returns to.
export const Route = createFileRoute("/_app/settings/accounts")({
  component: () => <Navigate to="/connections/accounts" replace />,
});
