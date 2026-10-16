import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/")({
  component: () => <Navigate to="/admin/users" />,
});
