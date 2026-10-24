import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useSession } from "@/client/hooks/useSession";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { LayoutGrid, List, Search, Settings2, X } from "lucide-react";
import { cn } from "cn";
import { PWAInstallModal } from "@/client/components/PWAInstallModal";
import { AppGallery } from "@/client/components/onboarding/AppGallery";
import { BuildYourOwnDialog } from "@/client/components/onboarding/BuildYourOwnDialog";
import { FeaturedAppDialog } from "@/client/components/onboarding/FeaturedAppDialog";
import {
  AppListItem,
  AppListItemSkeleton,
} from "@/client/components/AppListItem";
import { AppSetupDialog } from "@/client/components/AppSetupDialog";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { McpAppDialog } from "@/client/components/McpAppDialog";
import { PageHeader, SectionHeader } from "@/client/components/PageHeader";
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
import { useMcpParam, useSetupParam } from "@/client/hooks/useSetupParam";
import { useShortcutLabel } from "@/client/hooks/useShortcutLabel";
import type { FeaturedApp } from "@/client/lib/featuredApps";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";
import { authClient } from "@/client/auth-client";
import { isMcpApp } from "@/client/lib/appStatus";
import type { UserAccessApp } from "@/types/app";

/** What the "MCP apps" section says once, so its cards need only a chip. */
const MCP_APPS_HINT =
  "Your agent uses these through this Gateway's MCP address. Nothing to open.";

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
  // The app id of an MCP app whose "Use it from your agent" dialog to
  // open: where a pinned MCP app in the sidebar leads.
  mcp: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/")({
  validateSearch: searchSchema,
  component: App,
});

function App() {
  const session = useSession();
  const { pwa: pwaParam, setup: setupParam, mcp: mcpParam } = Route.useSearch();
  const [showPWAInstallModal, setShowPWAInstallModal] = useState(false);
  const [setupApp, setSetupApp] = useState<UserAccessApp | null>(null);
  // The gallery's dialogs: one of the four apps, or Build your own.
  const [pickedApp, setPickedApp] = useState<FeaturedApp | null>(null);
  const [buildOpen, setBuildOpen] = useState(false);
  const [mcpApp, setMcpApp] = useState<UserAccessApp | null>(null);
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

  // `?mcp=<appId>`: the same, for an MCP app's dialog.
  useMcpParam({
    mcpParam,
    apps,
    loaded: !isLoading && !isError,
    open: setMcpApp,
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
  // Already pinned first, then by name. Apps with a page fill the grid;
  // MCP apps (no page; their tools are on /mcp) have a section of their
  // own below it, so a search narrows both and an empty section goes.
  const visibleApps = apps.filter((app) =>
    `${app.name} ${app.description}`.toLocaleLowerCase().includes(query),
  );
  const pageApps = visibleApps.filter((app) => !isMcpApp(app));
  const mcpApps = visibleApps.filter((app) => isMcpApp(app));
  // The grid, its toolbar and the search are for apps with a page; a
  // workspace whose only app is an MCP app still gets the gallery (there
  // is nothing to open yet) with the MCP apps section under it.
  const hasPageApps = apps.some((app) => !isMcpApp(app));
  const renderApp = (app: UserAccessApp) => (
    <AppListItem
      key={app.id}
      app={app}
      pinned={pinnedIds.has(app.id)}
      onTogglePin={() => togglePin(app.id)}
      onOpenSetup={() => setSetupApp(app)}
      onUseMcp={() => setMcpApp(app)}
      layout={layout}
    />
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

        {hasPageApps || (isLoading && !isError) ? (
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
            {/* A search that matches only MCP apps leaves nothing for this
                region: the matches are in the one below, so it isn't drawn
                empty under a "Search results" name. */}
            {isLoading || pageApps.length > 0 || visibleApps.length === 0 ? (
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
                ) : pageApps.length > 0 ? (
                  <ul className={gridClassName}>{pageApps.map(renderApp)}</ul>
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
            ) : null}
          </>
        ) : null}

        {!isLoading && !isError && !isMemberRolePending && !hasPageApps ? (
          // An owner or admin can install an app: the four apps and Build
          // your own. A member waits for one of them, unless an MCP app
          // (below) is already theirs.
          userCanManageApps ? (
            <AppGallery
              // With an MCP app already on, it is not the first app.
              heading={
                apps.length > 0 ? FIRST_SCREEN.addApp.dialogTitle : undefined
              }
              onPickApp={setPickedApp}
              onBuild={() => setBuildOpen(true)}
            />
          ) : apps.length === 0 ? (
            <EmptyState
              icon={LayoutGrid}
              title={FIRST_SCREEN.empty.memberTitle}
              description={FIRST_SCREEN.empty.memberDescription}
            />
          ) : null
        ) : null}

        {!isLoading && !isError && mcpApps.length > 0 ? (
          // Apps with no page, under the grid (or the gallery): the heading
          // says once how they are used, so each card needs only a chip.
          <section aria-label="MCP apps" className="space-y-3 pt-4">
            <SectionHeader title="MCP apps" hint={MCP_APPS_HINT} />
            <ul className={gridClassName}>{mcpApps.map(renderApp)}</ul>
          </section>
        ) : null}
      </div>
      <PWAInstallModal
        open={showPWAInstallModal}
        onClose={() => setShowPWAInstallModal(false)}
      />
      {pickedApp ? (
        <FeaturedAppDialog
          app={pickedApp}
          canRun={userCanManageApps}
          onClose={() => setPickedApp(null)}
        />
      ) : null}
      {buildOpen ? (
        <BuildYourOwnDialog onClose={() => setBuildOpen(false)} />
      ) : null}
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
      {mcpApp ? (
        <McpAppDialog
          name={mcpApp.name}
          appId={mcpApp.appId}
          onClose={() => setMcpApp(null)}
        />
      ) : null}
    </div>
  );
}
