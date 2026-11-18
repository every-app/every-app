import { createFileRoute, redirect } from "@tanstack/react-router";

// Where Connected accounts was before Your connections: the address a
// connect link from an earlier CLI returns to.
export const Route = createFileRoute("/_app/settings/accounts")({
  beforeLoad: () => {
    throw redirect({ to: "/connections/accounts", replace: true });
  },
});
