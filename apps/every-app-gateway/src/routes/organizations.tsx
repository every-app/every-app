import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { authClient } from "@/client/auth-client";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { useActiveOrganization } from "@/client/hooks/useActiveOrganization";
import { useSession } from "@/client/hooks/useSession";

export const Route = createFileRoute("/organizations")({
  component: OrganizationsPage,
});

function OrganizationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const { data: organizations } = authClient.useListOrganizations();
  const { data: activeOrganization } = useActiveOrganization({
    enabled: Boolean(session.data?.user),
  });

  const [error, setError] = useState<string | null>(null);

  const hasOrganizations = (organizations?.length ?? 0) > 0;

  useEffect(() => {
    if (!session.isPending && !session.data?.user) {
      void navigate({ to: "/sign-in" });
    }
  }, [navigate, session.data?.user, session.isPending]);

  const handleSetActiveOrganization = async (organizationId: string) => {
    setError(null);
    try {
      const result = await authClient.organization.setActive({
        organizationId,
      });
      if (result.error) {
        setError(result.error.message ?? "Failed to switch organization.");
        return;
      }
      await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
      await refetchCollectionsAfterAuth();
      await navigate({ to: "/" });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to switch organization.",
      );
    }
  };

  if (session.isPending) {
    return null;
  }

  if (!session.data?.user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-base-100">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold">Organizations</h1>
          <p className="text-base-content/70 mt-2">
            Pick your active workspace.
          </p>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {!hasOrganizations && (
          <div className="alert">
            <span>
              You are not a member of any organization yet. Ask an owner or
              admin to invite you.
            </span>
          </div>
        )}

        {hasOrganizations && (
          <div className="card bg-base-200">
            <div className="card-body">
              <h2 className="card-title">Your Organizations</h2>
              <div className="space-y-2">
                {organizations?.map((organization) => {
                  const isActive = activeOrganization?.id === organization.id;
                  return (
                    <div
                      key={organization.id}
                      className="flex items-center justify-between p-3 rounded-lg bg-base-100"
                    >
                      <div>
                        <p className="font-medium">{organization.name}</p>
                        <p className="text-sm text-base-content/70">
                          {organization.slug}
                        </p>
                      </div>
                      {isActive ? (
                        <span className="badge badge-success">Active</span>
                      ) : (
                        <button
                          className="btn btn-sm btn-outline"
                          onClick={() =>
                            handleSetActiveOrganization(organization.id)
                          }
                        >
                          Use
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
