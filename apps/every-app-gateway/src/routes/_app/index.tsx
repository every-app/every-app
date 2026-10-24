import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useSession } from "@/client/hooks/useSession";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { LayoutGrid, List, Search, Settings2, X } from "lucide-react";
import { cn } from "cn";
import { PWAInstallModal } from "@/client/components/PWAInstallModal";
import { OnboardingBanner } from "@/client/components/onboarding/OnboardingBanner";
import {
  AppListItem,
  AppListItemSkeleton,
} from "@/client/components/AppListItem";
import { AppSetupDialog } from "@/client/components/AppSetupDialog";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { PageHeader } from "@/client/components/PageHeader";
import {
  SegmentedToggle,
  SegmentedToggleSize,
} from "@/client/components/SegmentedToggle";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/client/components/ui/input-group";
import { Kbd } from "@/client/components/ui/kbd";
import { AppLibraryLayout, useAppLibrary } from "@/client/hooks/useAppLibrary";
import { useSetupParam } from "@/client/hooks/useSetupParam";
import { useShortcutLabel } from "@/client/hooks/useShortcutLabel";
import { authClient } from "@/client/auth-client";
import type { UserAccessApp } from "@/types/app";

// An outline button on the card surface (white in light mode), so it stands
// out from the page and the empty state's background.
const cardButtonClass = "bg-card hover:bg-card/80 dark:bg-card";

const searchSchema = z.object({
  pwa: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((val) => val === true || val === "true")
    .optional()
    .catch(undefined),
  // The app id of a setup dialog to open: where the perimeter sends someone
  // who tried to open an app that needs setup, and the sidebar's pinned
  // apps link.
  setup: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/")({
  validateSearch: searchSchema,
  component: App,
});

function App() {
  const session = useSession();
  const { pwa: pwaParam, setup: setupParam } = Route.useSearch();
  const [showPWAInstallModal, setShowPWAInstallModal] = useState(false);
  const [setupApp, setSetupApp] = useState<UserAccessApp | null>(null);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searchShortcut = useShortcutLabel("K");
  const navigate = useNavigate();
  const hasStrippedPwaParam = useRef(false);
  const { data: activeMemberRole, isPending: isMemberRolePending } =
    authClient.useActiveMemberRole();
  const userCanManageApps =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  const { apps, isLoading, isError, pinnedIds, layout, togglePin, setLayout } =
    useAppLibrary();

  useEffect(() => {
    if (
      !session.isPending &&
      session.data?.user &&
      !session.data.session.activeOrganizationId
    ) {
      void navigate({ to: "/organizations" });
    }
  }, [
    navigate,
    session.data?.session.activeOrganizationId,
    session.data?.user,
    session.isPending,
  ]);

  // One-shot params are stripped, so the launcher's home is "/".
  useEffect(() => {
    if (pwaParam && !hasStrippedPwaParam.current) {
      setShowPWAInstallModal(true);
      hasStrippedPwaParam.current = true;
      void navigate({ to: "/", search: {}, replace: true });
    }
  }, [pwaParam, navigate]);

  // `?setup=<appId>`: once the list is in, open that app's setup dialog if
  // it still needs setup, and strip the param either way.
  useSetupParam({
    setupParam,
    apps,
    loaded: !isLoading && !isError,
    open: setSetupApp,
    strip: () => void navigate({ to: "/", search: {}, replace: true }),
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (
    !session.isPending &&
    session.data?.user &&
    !session.data.session.activeOrganizationId
  )
    return null;

  const query = search.trim().toLocaleLowerCase();
  // Already pinned first, then by name.
  const visibleApps = apps.filter((app) =>
    `${app.name} ${app.description}`.toLocaleLowerCase().includes(query),
  );
  const gridClassName = cn(
    "grid gap-4",
    layout === AppLibraryLayout.Grid && "md:grid-cols-2 xl:grid-cols-3",
  );
  const manageAppsButton = (
    <Button
      variant="outline"
      className={cardButtonClass}
      nativeButton={false}
      render={<Link to="/admin/apps" />}
    >
      <Settings2 data-icon="inline-start" />
      Manage apps
    </Button>
  );

  return (
    // The page starts 20px down, like the sidebar's brand row, so the title
    // and the brand share a center line.
    <div className="px-5 py-5 pb-safe md:px-10 lg:px-12">
      <div className="mx-auto max-w-7xl space-y-4">
        <PageHeader
          title={
            <>
              All apps
              {!isLoading && !isError && apps.length > 0 ? (
                // Everything this person can open, the sidebar's number too;
                // a search narrows the grid, not the count.
                <Badge
                  variant="outline"
                  className="rounded-md px-1.5 text-xs font-medium text-muted-foreground"
                >
                  {apps.length}
                  <span className="sr-only"> apps</span>
                </Badge>
              ) : null}
            </>
          }
          actions={
            userCanManageApps ? (
              <div className="hidden md:block">{manageAppsButton}</div>
            ) : null
          }
        />
        {isError ? (
          <ErrorState title="Failed to load apps" message="Please try again." />
        ) : null}

        {apps.length > 0 || (isLoading && !isError) ? (
          <>
            <div className="flex items-center gap-3">
              <InputGroup className="border-border bg-card shadow-xs md:max-w-sm">
                <InputGroupAddon>
                  <Search aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  ref={searchRef}
                  type="search"
                  aria-label="Search your apps"
                  placeholder="Search your apps…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setSearch("");
                      searchRef.current?.blur();
                    }
                  }}
                />
                {!search && searchShortcut ? (
                  <InputGroupAddon
                    align="inline-end"
                    className="hidden md:flex"
                  >
                    <Kbd>{searchShortcut}</Kbd>
                  </InputGroupAddon>
                ) : null}
                {search ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Clear search"
                      onClick={() => {
                        setSearch("");
                        searchRef.current?.focus();
                      }}
                    >
                      <X aria-hidden />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
              <div className="ml-auto hidden items-center gap-3 md:flex">
                <SegmentedToggle
                  size={SegmentedToggleSize.Toolbar}
                  value={layout}
                  onChange={setLayout}
                  items={[
                    {
                      value: AppLibraryLayout.Grid,
                      icon: <LayoutGrid className="size-4" />,
                      label: "Grid view",
                    },
                    {
                      value: AppLibraryLayout.List,
                      icon: <List className="size-4" />,
                      label: "List view",
                    },
                  ]}
                />
              </div>
            </div>
            {/* The count a screen reader hears as a search narrows the grid. */}
            <p role="status" className="sr-only">
              {query
                ? `${visibleApps.length} ${visibleApps.length === 1 ? "app" : "apps"} found`
                : ""}
            </p>
            <section
              aria-label={query ? "Search results" : "All apps"}
              aria-busy={isLoading}
            >
              {isLoading ? (
                <ul className={gridClassName} aria-label="Loading apps">
                  {Array.from({ length: 3 }, (_, index) => (
                    <AppListItemSkeleton key={index} layout={layout} />
                  ))}
                </ul>
              ) : visibleApps.length > 0 ? (
                <ul className={gridClassName}>
                  {visibleApps.map((app) => (
                    <AppListItem
                      key={app.id}
                      app={app}
                      pinned={pinnedIds.has(app.id)}
                      onTogglePin={() => togglePin(app.id)}
                      onOpenSetup={() => setSetupApp(app)}
                      layout={layout}
                    />
                  ))}
                </ul>
              ) : (
                <EmptyState
                  kind="filtered"
                  title="No apps found"
                  description="Try another app name or description."
                  action={
                    <Button
                      variant="outline"
                      className={cardButtonClass}
                      onClick={() => setSearch("")}
                    >
                      Clear search
                    </Button>
                  }
                />
              )}
            </section>
          </>
        ) : null}

        {!isLoading && !isError && !isMemberRolePending && apps.length === 0 ? (
          activeMemberRole?.role === "owner" ? (
            <OnboardingBanner />
          ) : userCanManageApps ? (
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
      {setupApp?.setup ? (
        <AppSetupDialog
          name={setupApp.name}
          setup={setupApp.setup}
          // An owner or admin runs the command for their own organization's
          // app; a shared app of another organization is the platform's to
          // set, optional settings included.
          canRun={
            userCanManageApps &&
            setupApp.organizationId ===
              session.data?.session.activeOrganizationId
          }
          onClose={() => setSetupApp(null)}
        />
      ) : null}
    </div>
  );
}
