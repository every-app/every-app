import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, CircleAlert } from "lucide-react";
import { authClient } from "@/client/auth-client";
import { useActiveOrganization } from "@/client/hooks/useActiveOrganization";
import { useSession } from "@/client/hooks/useSession";
import { useSetActiveOrganization } from "@/client/hooks/useSetActiveOrganization";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { Page, PageHeader } from "@/client/components/PageHeader";
import {
  SkeletonCard,
  SkeletonPage,
} from "@/client/components/SkeletonPresets";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";

export const Route = createFileRoute("/_app/organizations")({
  component: OrganizationsPage,
});

function OrganizationsPage() {
  const navigate = useNavigate();
  const session = useSession();
  const {
    data: organizations,
    isPending: isListPending,
    error: listError,
    refetch: refetchList,
  } = authClient.useListOrganizations();
  const { data: activeOrganization } = useActiveOrganization({
    enabled: Boolean(session.data?.user),
  });
  const setActiveOrganization = useSetActiveOrganization();

  const [error, setError] = useState<string | null>(null);
  // The organization being switched to, for its button's spinner.
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const hasOrganizations = (organizations?.length ?? 0) > 0;

  useEffect(() => {
    if (!session.isPending && !session.data?.user) {
      void navigate({ to: "/sign-in" });
    }
  }, [navigate, session.data?.user, session.isPending]);

  const handleSetActiveOrganization = async (organizationId: string) => {
    setError(null);
    setSwitchingId(organizationId);
    const switchError = await setActiveOrganization(organizationId);
    setSwitchingId(null);
    if (switchError) setError(switchError);
  };

  if (session.isPending) {
    return <SkeletonPage />;
  }

  if (!session.data?.user) {
    return null;
  }

  return (
    <Page>
      <PageHeader title="Organizations" />

      {error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {isListPending && !organizations ? (
        <SkeletonCard />
      ) : listError ? (
        <ErrorState
          message="Couldn't load your organizations."
          onRetry={() => void refetchList()}
          isRetrying={isListPending}
        />
      ) : !hasOrganizations ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Ask an admin to invite you."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {organizations?.map((organization) => {
            const isActive = activeOrganization?.id === organization.id;
            return (
              <li
                key={organization.id}
                className="flex items-center justify-between gap-3 p-3"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-card text-muted-foreground shadow-sm">
                    <Building2 className="size-4" />
                  </span>
                  <span className="truncate font-medium">
                    {organization.name}
                  </span>
                </span>
                {/* The usual state is plain text; the chips are for exceptions. */}
                {isActive ? (
                  <span className="text-sm text-muted-foreground">Current</span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Switch to ${organization.name}`}
                    pending={switchingId === organization.id}
                    disabled={switchingId !== null}
                    onClick={() =>
                      void handleSetActiveOrganization(organization.id)
                    }
                  >
                    Switch
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
