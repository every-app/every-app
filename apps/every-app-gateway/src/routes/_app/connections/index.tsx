import { createFileRoute, redirect } from "@tanstack/react-router";

// Your connections opens on Accounts.
export const Route = createFileRoute("/_app/connections/")({
  beforeLoad: () => {
    throw redirect({ to: "/connections/accounts", replace: true });
  },
});
