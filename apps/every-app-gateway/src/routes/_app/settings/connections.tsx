import { createFileRoute, redirect } from "@tanstack/react-router";

// Where AI connections was before Your connections: the address in the emails
// already sent for connection events.
export const Route = createFileRoute("/_app/settings/connections")({
  beforeLoad: () => {
    throw redirect({ to: "/connections", replace: true });
  },
});
