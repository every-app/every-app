import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useSession } from "@/client/hooks/useSession";
import { useActiveOrganization } from "@/client/hooks/useActiveOrganization";
import { userAppsCollection } from "@/client/tanstack-db";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { LayoutGrid, Settings } from "lucide-react";
import { PWAInstallModal } from "@/client/components/PWAInstallModal";
import { OnboardingBanner } from "@/client/components/onboarding/OnboardingBanner";
import {
  AppListItem,
  AppListItemSkeleton,
} from "@/client/components/AppListItem";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { authClient } from "@/client/auth-client";

const searchSchema = z.object({
  // Handle both boolean (from programmatic navigation) and string (from URL)
  // Falls back to undefined for any invalid values to prevent hard crashes
  pwa: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((val) => val === true || val === "true")
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/_app/")({
  validateSearch: searchSchema,
  component: App,
});

const APP_GRID_CLASS_NAME = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3";

function App() {
  const session = useSession();
  const { pwa: pwaParam } = Route.useSearch();
  const [showPWAInstallModal, setShowPWAInstallModal] = useState(false);
  const navigate = useNavigate();
  const hasStrippedPwaParam = useRef(false);
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const userCanManageApps =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  // Shared with the sidebar's organization switcher, so it is usually cached.
  const { data: activeOrganization } = useActiveOrganization({
    enabled: Boolean(session.data?.user),
  });

  useEffect(() => {
    if (session.isPending || !session.data?.user) {
      return;
    }

    if (!session.data.session.activeOrganizationId) {
      navigate({ to: "/organizations" });
    }
  }, [
    navigate,
    session.data?.session.activeOrganizationId,
    session.data?.user,
    session.isPending,
  ]);

  // Open PWA modal when ?pwa=true is present, then strip the param
  useEffect(() => {
    if (pwaParam && !hasStrippedPwaParam.current) {
      setShowPWAInstallModal(true);
      hasStrippedPwaParam.current = true;
      // Strip the ?pwa param from the URL without closing the modal
      navigate({ to: "/", search: {}, replace: true });
    }
  }, [pwaParam, navigate]);

  // Use TanStack DB live query - always subscribe to the collection
  // This ensures mutations work immediately without needing to refresh
  const {
    data: userApps,
    isLoading,
    isError,
  } = useLiveQuery((q) => q.from({ userApp: userAppsCollection }));

  if (
    !session.isPending &&
    session.data?.user &&
    !session.data.session.activeOrganizationId
  ) {
    return null;
  }

  const manageAppsButton = (
    <Button
      variant="outline"
      nativeButton={false}
      render={<Link to="/admin/apps" />}
    >
      <Settings data-icon="inline-start" />
      Manage apps
    </Button>
  );

  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader
          title="Apps"
          description={
            activeOrganization
              ? `The apps you can open in ${activeOrganization.name}.`
              : "The apps you can open."
          }
          actions={userCanManageApps ? manageAppsButton : null}
        />

        <OnboardingBanner />

        {isError ? (
          <ErrorState title="Failed to load apps" message="Please try again." />
        ) : null}

        {isLoading && !isError ? (
          <ul className={APP_GRID_CLASS_NAME} aria-busy>
            {Array.from({ length: 3 }, (_, index) => (
              <AppListItemSkeleton key={index} />
            ))}
          </ul>
        ) : null}

        {!isLoading && userApps && userApps.length > 0 ? (
          <ul className={APP_GRID_CLASS_NAME}>
            {userApps.map((app) => (
              <AppListItem key={app.id} app={app} />
            ))}
          </ul>
        ) : null}

        {!isLoading && !isError && userApps && userApps.length === 0 ? (
          userCanManageApps ? (
            <EmptyState
              icon={LayoutGrid}
              title="No apps yet"
              description="Deploy your first app with the everyapp CLI to get started."
              action={manageAppsButton}
            />
          ) : (
            <EmptyState
              icon={LayoutGrid}
              title="No apps available"
              description="Contact your administrator to get access."
            />
          )
        ) : null}
      </div>

      <PWAInstallModal
        open={showPWAInstallModal}
        onClose={() => setShowPWAInstallModal(false)}
      />
    </div>
  );
}
