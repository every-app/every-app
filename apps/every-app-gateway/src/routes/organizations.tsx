import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { authClient } from "@/client/auth-client";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { useSession } from "@/client/hooks/useSession";

export const Route = createFileRoute("/organizations")({
  component: OrganizationsPage,
});

function slugifyOrganizationName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function OrganizationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const { data: organizations } = authClient.useListOrganizations();
  const { data: activeOrganization } = authClient.useActiveOrganization();

  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasOrganizations = (organizations?.length ?? 0) > 0;

  useEffect(() => {
    if (!session.isPending && !session.data?.user) {
      void navigate({ to: "/sign-in" });
    }
  }, [navigate, session.data?.user, session.isPending]);

  const suggestedSlug = useMemo(() => {
    const baseSlug = slugifyOrganizationName(name);
    if (!baseSlug) return "";
    return `${baseSlug}-${Date.now().toString().slice(-4)}`;
  }, [name]);

  const handleCreateOrganization = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (!suggestedSlug) {
      setError("Please choose a valid organization name.");
      return;
    }

    setError(null);
    setIsSaving(true);
    try {
      const createResult = await authClient.organization.create({
        name: name.trim(),
        slug: suggestedSlug,
      });

      if (createResult.error) {
        setError(
          createResult.error.message ?? "Failed to create organization.",
        );
        return;
      }

      setName("");
      await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
      await refetchCollectionsAfterAuth();
      await navigate({ to: "/" });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create organization.",
      );
    } finally {
      setIsSaving(false);
    }
  };

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
            Create an organization or pick your active workspace.
          </p>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="card bg-base-200">
          <div className="card-body">
            <h2 className="card-title">Create Organization</h2>
            <form className="space-y-3" onSubmit={handleCreateOrganization}>
              <input
                type="text"
                placeholder="Acme"
                className="input input-bordered w-full"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isSaving}
                required
              />
              <button className="btn btn-primary" disabled={isSaving}>
                {isSaving ? "Creating..." : "Create and Continue"}
              </button>
            </form>
          </div>
        </div>

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
