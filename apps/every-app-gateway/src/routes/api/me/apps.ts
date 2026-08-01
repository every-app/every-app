import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/auth";
import { AppAccessService } from "@/server/services/AppAccessService";
import { resolveOrgContext } from "@/server/organization/orgContext";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * REST endpoint for the native mobile shell: the apps the current user can
 * launch. The web launcher uses the getMyApps server function instead; this
 * route exists because server functions are an RPC transport, not a stable
 * contract for external clients.
 */
export const Route = createFileRoute("/api/me/apps")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({
          headers: request.headers,
        });

        if (!session?.user?.id) {
          return unauthorized();
        }

        const org = await resolveOrgContext({
          userId: session.user.id,
          activeOrganizationId: session.session.activeOrganizationId ?? null,
        });

        if (!org) {
          return unauthorized();
        }

        const result = await AppAccessService.getAppsForUser(org);
        // Rows without a routing hostname (registered but never deployed)
        // are unusable by any client — don't let one break the whole list.
        const apps = result.apps.filter((app) => app.hostname !== null);
        return new Response(JSON.stringify({ apps }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
