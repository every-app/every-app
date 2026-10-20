import { Link, useLocation } from "@tanstack/react-router";
import type { LinkOptions } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import {
  ArrowUpRight,
  BookOpen,
  ExternalLink,
  LayoutGrid,
  Link2,
  LogOut,
  Pin,
  Settings,
  User,
} from "lucide-react";
import { authClient } from "@/client/auth-client";
import { useSession } from "@/client/hooks/useSession";
import { AppLibraryFilter, useAppLibrary } from "@/client/hooks/useAppLibrary";
import { AppIcon } from "@/client/components/AppIcon";
import {
  ACCESS_SIGN_OUT_PATH,
  useSignInMethods,
} from "@/client/sign-in-methods";
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

const navButtonClass =
  "h-10 rounded-lg px-3 text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground";

function SidebarNavLink({
  icon: Icon,
  label,
  linkProps,
  count,
  active,
  disabled = false,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  linkProps: LinkOptions;
  count?: number;
  active?: boolean;
  disabled?: boolean;
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
  if (disabled)
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          disabled
          aria-disabled="true"
          className={navButtonClass}
        >
          {contents}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  return (
    <SidebarMenuItem>
      <Link
        {...linkProps}
        aria-current={active ? "page" : undefined}
        activeOptions={{
          exact: false,
          includeSearch: false,
          ...linkProps.activeOptions,
        }}
        onClick={() => setOpenMobile(false)}
      >
        {({ isActive: linkIsActive }) => (
          <SidebarMenuButton
            render={<span />}
            isActive={active ?? linkIsActive}
            className={navButtonClass}
            aria-current={(active ?? linkIsActive) ? "page" : undefined}
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
  const location = useLocation();
  const { apps, pinnedApps, isLoading, isError } = useAppLibrary();
  // Same check as the admin layout's gate.
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const canManageOrganizationApps =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  return (
    <UiSidebar collapsible="offcanvas">
      {/* The top inset keeps the header clear of the status bar in the
          installed app, where the page runs under it. */}
      <SidebarHeader className="gap-4 px-3 pb-4 pt-[calc(env(safe-area-inset-top,0px)+1.25rem)]">
        <Link
          to="/"
          onClick={() => setOpenMobile(false)}
          className="flex items-center gap-2 px-3 text-lg font-semibold tracking-tight text-sidebar-foreground"
        >
          <img
            src="/android-chrome-192x192.png"
            alt=""
            className="size-7 rounded-md"
          />
          Every App
        </Link>
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
                  active={
                    location.pathname === "/" &&
                    location.search.filter !== AppLibraryFilter.Pinned
                  }
                  count={!isLoading && !isError ? apps.length : undefined}
                  linkProps={{
                    to: "/",
                    search: { filter: undefined },
                    activeOptions: { exact: true, includeSearch: true },
                  }}
                />
                <SidebarNavLink
                  icon={Pin}
                  label="Pinned"
                  disabled={pinnedApps.length === 0}
                  active={
                    location.pathname === "/" &&
                    location.search.filter === AppLibraryFilter.Pinned
                  }
                  count={
                    !isLoading && !isError && pinnedApps.length > 0
                      ? pinnedApps.length
                      : undefined
                  }
                  linkProps={{
                    to: "/",
                    search: { filter: AppLibraryFilter.Pinned },
                    activeOptions: { exact: true, includeSearch: true },
                  }}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {pinnedApps.length > 0 ? (
            <SidebarGroup className="mt-3 px-3 py-0">
              <SidebarGroupLabel className="h-5 px-3 text-[10px] uppercase tracking-wider text-sidebar-foreground/50">
                Pinned apps
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {pinnedApps.map((app) => (
                    <SidebarMenuItem key={app.id}>
                      <SidebarMenuButton
                        className={navButtonClass}
                        disabled={!app.hostname || app.status !== "active"}
                        render={
                          app.hostname && app.status === "active" ? (
                            <a
                              href={`//${app.hostname}`}
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
                        {app.hostname && app.status === "active" ? (
                          <ArrowUpRight
                            className="size-4 text-sidebar-foreground/50"
                            aria-hidden
                          />
                        ) : null}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
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
    await authClient.signOut();
    // Hard refresh clears all client state (query cache, session, etc.).
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
      <nav aria-label="Workspace settings" className="px-3 pb-3">
        <SidebarMenu>
          <SidebarNavLink
            icon={Link2}
            label="AI connections"
            linkProps={{ to: "/settings/connections" }}
          />
          {canManageApps ? (
            <SidebarNavLink
              icon={Settings}
              label="Manage workspace"
              linkProps={{ to: "/admin" }}
            />
          ) : null}
          <SidebarMenuItem>
            <SidebarMenuButton
              className={navButtonClass}
              render={
                <a
                  href="https://everyapp.com"
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              <span className="flex size-6 shrink-0 items-center justify-center">
                <BookOpen className="size-4" />
              </span>
              <span className="truncate">Documentation</span>
              <ExternalLink className="ml-auto size-3.5 opacity-60" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </nav>
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
                    <span className="block truncate text-xs font-medium">
                      {session?.user.name || email}
                    </span>
                    <span className="block truncate text-[11px] text-sidebar-foreground/50">
                      {email}
                    </span>
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" className="w-56">
                  <DropdownMenuItem
                    render={
                      <Link
                        to="/settings/connections"
                        onClick={() => setOpenMobile(false)}
                      />
                    }
                  >
                    <Link2 className="size-4" />
                    AI connections
                  </DropdownMenuItem>
                  {accessProvider && accessLinked === false && (
                    <DropdownMenuItem onClick={() => void connectAccess()}>
                      <Link2 className="size-4" />
                      Connect {accessProvider.label}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Theme</DropdownMenuLabel>
                    <div className="px-1 pb-1">
                      <ThemePreferenceRadio />
                    </div>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => void handleSignOut()}
                  >
                    <LogOut className="size-4" />
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
      </div>
    </UiSidebarFooter>
  );
}
