import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { InstallAppForm } from "@/client/components/admin/InstallAppForm";
import { AuthPageShell } from "@/client/components/auth/AuthPageShell";

/** External handoff: root session handling preserves the full URL through sign-in. */
export const Route = createFileRoute("/install")({
  validateSearch: z.object({ source: z.string().max(2048).optional() }),
  component: InstallPage,
});

function InstallPage() {
  const { source } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <AuthPageShell>
      <InstallAppForm
        sourceUrl={source}
        onBack={() => navigate({ to: "/admin/apps" })}
      />
    </AuthPageShell>
  );
}
