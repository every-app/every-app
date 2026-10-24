import { Link } from "@tanstack/react-router";
import type { LinkOptions } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { ArrowUpRight, LayoutGrid, Settings, User } from "lucide-react";
import { authClient } from "@/client/auth-client";
import { signOutAndForget } from "@/client/sign-out";
import { useSession } from "@/client/hooks/useSession";
import { useAppLibrary } from "@/client/hooks/useAppLibrary";
import { AppIcon } from "@/client/components/AppIcon";
import { preconnectTo } from "@/client/lib/appLaunchPrefetch";
import { appNeedsSetup, appStatus, mcpAppUsable } from "@/client/lib/appStatus";
import {
  ACCESS_SIGN_OUT_PATH,
  useSignInMethods,
} from "@/client/sign-in-methods";
import { BrandLink } from "@/client/components/BrandLink";
import { BuildStamp } from "@/client/components/BuildStamp";
import { OrganizationSwitcher } from "@/client/components/OrganizationSwitcher";
import { ThemePreferenceRadio } from "@/client/components/ThemePreferenceMenuItems";
import {
  Sidebar as UiSidebar,
  SidebarContent,
  SidebarFooter as UiSidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/client/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/client/components/ui/dropdown-menu";

const DOCS_URL = "https://everyapp.com/docs";

const navButtonClass =
  "h-10 rounded-lg px-3 text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground";

function SidebarNavLink({
  icon: Icon,
  label,
  linkProps,
  count,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  linkProps: LinkOptions;
  count?: number;
}) {
  const { setOpenMobile } = useSidebar();
  const contents = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center">
        <Icon className="size-4" />
      </span>
      <span className="truncate">{label}</span>
      {count !== undefined ? (
        <span className="ml-auto flex w-4 shrink-0 items-center justify-center text-xs font-normal tabular-nums text-sidebar-foreground/50">
          {count}
        </span>
      ) : null}
    </>
  );
  return (
    <SidebarMenuItem>
      <Link
        {...linkProps}
        activeOptions={{
          exact: false,
          includeSearch: false,
          ...linkProps.activeOptions,
        }}
        onClick={() => setOpenMobile(false)}
      >
        {({ isActive }) => (
          <SidebarMenuButton
            render={<span />}
            isActive={isActive}
            className={navButtonClass}
            aria-current={isActive ? "page" : undefined}
          >
            {contents}
          </SidebarMenuButton>
        )}
      </Link>
    </SidebarMenuItem>
  );
}

export function Sidebar() {
  const { data: session } = useSession();
  const { setOpenMobile } = useSidebar();
  const signedIn = Boolean(session?.user);
  const { apps, pinnedApps, isLoading, isError } = useAppLibrary();
  // Same check as the admin layout's gate.
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const canManageOrganizationApps =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  return (
    <UiSidebar collapsible="offcanvas">
      {/* The top inset keeps the header clear of the status bar in the
          installed app, where the page runs under it. The brand row matches
          the page title row (20px down, 40px tall), so the workspace switcher
          lines up with the page's toolbar. */}
      <SidebarHeader className="gap-4 px-3 pb-4 pt-[calc(env(safe-area-inset-top,0px)+1.25rem)]">
        <BrandLink
          onClick={() => setOpenMobile(false)}
          className="h-10 px-3 text-sidebar-foreground"
        />
        <OrganizationSwitcher
          signedIn={signedIn}
          onCloseDrawer={() => setOpenMobile(false)}
        />
      </SidebarHeader>

      <SidebarContent className="gap-5">
        <nav aria-label="Main navigation">
          <SidebarGroup className="px-3 py-0">
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarNavLink
                  icon={LayoutGrid}
                  label="All apps"
                  count={!isLoading && !isError ? apps.length : undefined}
                  linkProps={{
                    to: "/",
                    activeOptions: { exact: true },
                  }}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {/* The pinned apps: one click from any page. Pinning also puts
              them first in the library. */}
          {pinnedApps.length > 0 ? (
            <SidebarGroup className="mt-3 px-3 py-0">
              <SidebarGroupLabel className="h-6 px-3 text-xs font-medium text-sidebar-foreground/50">
                Pinned
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {pinnedApps.map((app) => {
                    const status = appStatus(app);
                    // An app that needs setup leads to its setup dialog on
                    // the home page, where the launcher opens it; an MCP
                    // app likewise leads to its "Use it from your agent"
                    // dialog there.
                    const needsSetup = appNeedsSetup(app);
                    const mcp = mcpAppUsable(app);
                    // Open the connection to the app on hover, focus or
                    // touch (lib/appLaunchPrefetch).
                    const { hostname } = app;
                    const warm = hostname
                      ? () => preconnectTo(hostname)
                      : undefined;
                    return (
                      <SidebarMenuItem key={app.id}>
                        <SidebarMenuButton
                          className={navButtonClass}
                          disabled={!status.opens && !needsSetup && !mcp}
                          render={
                            status.opens ? (
                              <a
                                href={`//${app.hostname}`}
                                onClick={() => setOpenMobile(false)}
                                onPointerEnter={warm}
                                onFocus={warm}
                                onTouchStart={warm}
                              />
                            ) : needsSetup ? (
                              <Link
                                to="/"
                                search={{ setup: app.appId }}
                                onClick={() => setOpenMobile(false)}
                              />
                            ) : mcp ? (
                              <Link
                                to="/"
                                search={{ mcp: app.appId }}
                                onClick={() => setOpenMobile(false)}
                              />
                            ) : undefined
                          }
                        >
                          <AppIcon
                            app={app}
                            className="size-6 rounded-md text-xs"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {app.name}
                          </span>
                          {status.opens ? (
                            <ArrowUpRight
                              className="size-4 text-sidebar-foreground/50"
                              aria-hidden
                            />
                          ) : null}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </nav>
      </SidebarContent>
      <AccountFooter canManageApps={canManageOrganizationApps} />
    </UiSidebar>
  );
}

/**
 * The foot of the rail: Manage workspace for owners and admins, then the
 * account block, whose menu holds what is the person's own (their AI
 * connections, the docs, the theme, sign out), and the build stamp under it.
 */
function AccountFooter({ canManageApps }: { canManageApps: boolean }) {
  const { data: session } = useSession();
  const { setOpenMobile } = useSidebar();
  const email = session?.user.email;
  const { data: methods } = useSignInMethods();
  const accessProvider = methods?.providers[0];
  // Whether this account can already sign in with Cloudflare Access.
  const { data: accessLinked } = useQuery({
    queryKey: ["auth", "access-linked"],
    enabled: Boolean(email && accessProvider),
    queryFn: async () => {
      const { data } = await authClient.listAccounts();
      return (data ?? []).some(
        (account) => account.providerId === accessProvider?.id,
      );
    },
  });

  const handleSignOut = async () => {
    await signOutAndForget();
    // Behind the outer ring, sign out of Access too: signing out of the
    // gateway alone would be undone by the next page load.
    window.location.href = methods?.accessEmail
      ? ACCESS_SIGN_OUT_PATH
      : "/sign-in";
  };

  const connectAccess = async () => {
    if (!accessProvider) return;
    await authClient.linkSocial({
      provider: accessProvider.id,
      callbackURL: window.location.pathname,
      errorCallbackURL: "/sign-in",
    });
  };

  return (
    <UiSidebarFooter className="gap-0 p-0 pb-safe">
      {canManageApps ? (
        <div className="px-3 pb-3">
          <SidebarMenu>
            <SidebarNavLink
              icon={Settings}
              label="Manage workspace"
              linkProps={{ to: "/admin" }}
            />
          </SidebarMenu>
        </div>
      ) : null}
      <div className="border-t border-sidebar-border px-3 pt-3">
        <SidebarMenu>
          {email ? (
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      className={`${navButtonClass} h-14`}
                      aria-label="Open account menu"
                    />
                  }
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-accent">
                    <User className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {session?.user.name || email}
                    </span>
                    <span className="block truncate text-xs text-sidebar-foreground/50">
                      {email}
                    </span>
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" className="w-56">
                  {accessProvider && accessLinked === false && (
                    <DropdownMenuItem onClick={() => void connectAccess()}>
                      Connect {accessProvider.label}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    render={
                      <Link
                        to="/settings/connections"
                        onClick={() => setOpenMobile(false)}
                      />
                    }
                  >
                    AI connections
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    render={
                      <a
                        href={DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setOpenMobile(false)}
                      />
                    }
                  >
                    Documentation
                    <span className="sr-only"> (opens in a new tab)</span>
                    <ArrowUpRight className="ml-auto size-3.5" aria-hidden />
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Theme</DropdownMenuLabel>
                    <div className="px-1 pb-1">
                      <ThemePreferenceRadio />
                    </div>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  {/* Routine, not destructive: nothing is lost. */}
                  <DropdownMenuItem onClick={() => void handleSignOut()}>
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          ) : (
            // The account row's slot while the session loads.
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
          )}
        </SidebarMenu>
        <BuildStamp className="mt-1 px-3 text-sidebar-foreground/50" />
      </div>
    </UiSidebarFooter>
  );
}
