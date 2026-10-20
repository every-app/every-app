import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useSession } from "@/client/hooks/useSession";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import {
  ArrowDownAZ,
  LayoutGrid,
  List,
  Pin,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { cn } from "cn";
import { PWAInstallModal } from "@/client/components/PWAInstallModal";
import { OnboardingBanner } from "@/client/components/onboarding/OnboardingBanner";
import {
  AppListItem,
  AppListItemSkeleton,
} from "@/client/components/AppListItem";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { PageHeader } from "@/client/components/PageHeader";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/client/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/client/components/ui/input-group";
import {
  AppLibraryFilter,
  AppLibraryLayout,
  AppLibrarySort,
  useAppLibrary,
} from "@/client/hooks/useAppLibrary";
import { authClient } from "@/client/auth-client";

const searchSchema = z.object({
  pwa: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((val) => val === true || val === "true")
    .optional()
    .catch(undefined),
  filter: z.nativeEnum(AppLibraryFilter).optional(),
});

export const Route = createFileRoute("/_app/")({
  validateSearch: searchSchema,
  component: App,
});

function App() {
  const session = useSession();
  const { pwa: pwaParam, filter = AppLibraryFilter.All } = Route.useSearch();
  const [showPWAInstallModal, setShowPWAInstallModal] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const hasStrippedPwaParam = useRef(false);
  const { data: activeMemberRole, isPending: isMemberRolePending } =
    authClient.useActiveMemberRole();
  const userCanManageApps =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  const {
    apps,
    isLoading,
    isError,
    pinnedIds,
    layout,
    sort,
    togglePin,
    setLayout,
    setSort,
  } = useAppLibrary();

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

  useEffect(() => {
    if (pwaParam && !hasStrippedPwaParam.current) {
      setShowPWAInstallModal(true);
      hasStrippedPwaParam.current = true;
      void navigate({ to: "/", search: { filter }, replace: true });
    }
  }, [pwaParam, navigate, filter]);

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
  const visibleApps = apps.filter(
    (app) =>
      (filter !== AppLibraryFilter.Pinned || pinnedIds.has(app.id)) &&
      `${app.name} ${app.description}`.toLocaleLowerCase().includes(query),
  );
  if (sort === AppLibrarySort.Pinned) {
    visibleApps.sort(
      (a, b) =>
        Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id)) ||
        a.name.localeCompare(b.name),
    );
  }
  const gridClassName = cn(
    "grid gap-4",
    layout === AppLibraryLayout.Grid && "md:grid-cols-2 xl:grid-cols-3",
  );
  const manageAppsButton = (
    <Button
      variant="outline"
      className="bg-card hover:bg-card/80 dark:bg-card"
      nativeButton={false}
      render={<Link to="/admin/apps" />}
    >
      <Settings2 data-icon="inline-start" />
      Manage apps
    </Button>
  );

  return (
    <div className="px-5 py-5 pb-safe md:px-10 md:py-6 lg:px-12">
      <div className="mx-auto max-w-7xl space-y-4">
        <PageHeader
          title="Your apps"
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
              <InputGroup className="h-11 border-border bg-card shadow-xs md:max-w-sm">
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
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-muted-foreground"
                        aria-label="Sort apps"
                      />
                    }
                  >
                    <ArrowDownAZ className="size-3.5" aria-hidden />
                    {sort === AppLibrarySort.Name ? "Name A–Z" : "Pinned first"}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup
                      value={sort}
                      onValueChange={(value) =>
                        setSort(z.nativeEnum(AppLibrarySort).parse(value))
                      }
                    >
                      <DropdownMenuRadioItem value={AppLibrarySort.Name}>
                        Name A–Z
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value={AppLibrarySort.Pinned}>
                        Pinned first
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <SegmentedToggle
                  value={layout}
                  onChange={setLayout}
                  items={[
                    {
                      value: AppLibraryLayout.Grid,
                      icon: <LayoutGrid className="size-3.5" />,
                      label: "Grid view",
                    },
                    {
                      value: AppLibraryLayout.List,
                      icon: <List className="size-3.5" />,
                      label: "List view",
                    },
                  ]}
                />
              </div>
            </div>
            <section
              className="space-y-3"
              aria-labelledby="app-library-heading"
              aria-busy={isLoading}
            >
              <div className="flex items-center gap-2">
                <h2 id="app-library-heading" className="text-sm font-medium">
                  {query
                    ? "Search results"
                    : filter === AppLibraryFilter.Pinned
                      ? "Pinned apps"
                      : "All apps"}
                </h2>
                {!isLoading ? (
                  <Badge
                    variant="outline"
                    className="rounded-md px-1.5 text-xs text-muted-foreground"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    {visibleApps.length}
                    <span className="sr-only"> apps</span>
                  </Badge>
                ) : null}
              </div>
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
                      layout={layout}
                    />
                  ))}
                </ul>
              ) : (
                <EmptyState
                  kind="filtered"
                  icon={
                    filter === AppLibraryFilter.Pinned && !query
                      ? Pin
                      : undefined
                  }
                  title={query ? "No apps found" : "No pinned apps yet"}
                  description={
                    query
                      ? "Try another app name or description."
                      : "Pin an app from All apps to keep it in your sidebar."
                  }
                  action={
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearch("");
                        void navigate({ to: "/", search: {} });
                      }}
                    >
                      Show all apps
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
    </div>
  );
}
