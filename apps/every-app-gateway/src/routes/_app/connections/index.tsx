import { createFileRoute, Navigate } from "@tanstack/react-router";

// Your connections opens on Accounts.
export const Route = createFileRoute("/_app/connections/")({
  component: () => <Navigate to="/connections/accounts" replace />,
});
