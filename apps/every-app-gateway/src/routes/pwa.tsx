import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/pwa")({
  beforeLoad: () => {
    // Redirect to homepage with ?pwa=true to show the PWA install modal
    // This ensures users bookmark the homepage instead of /pwa
    throw redirect({ to: "/", search: { pwa: true } });
  },
  component: () => null,
});
