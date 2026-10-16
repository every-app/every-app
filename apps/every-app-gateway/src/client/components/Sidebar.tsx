import { Link } from "@tanstack/react-router";
import type { LinkOptions } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import {
  AppWindow,
  BookOpen,
  Building2,
  ExternalLink,
  House,
  KeyRound,
  Link2,
  LogOut,
  PlugZap,
  User,
  Users,
} from "lucide-react";
import { authClient } from "@/client/auth-client";
import { useSession } from "@/client/hooks/useSession";
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
  "relative text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground data-active:before:absolute data-active:before:inset-y-1 data-active:before:left-0 data-active:before:w-[3px] data-active:before:rounded-r-full data-active:before:bg-primary";

type NavItem = LinkOptions & {
  label: string;
  icon: ComponentType<{ className?: string }>;
};

type NavGroup = { label: string; items: NavItem[] };

const appsNavGroup: NavGroup = {
  label: "Apps",
  items: [
    {
      to: "/",
      label: "Home",
      icon: House,
      // Without exact matching, "/" is a prefix of every route and Home
      // would render active everywhere.
      activeOptions: { exact: true, includeSearch: false },
    },
  ],
};

const adminNavGroup: NavGroup = {
  label: "Admin",
  items: [
    { to: "/admin/users", label: "Users", icon: Users },
    { to: "/admin/apps", label: "Apps", icon: AppWindow },
    { to: "/admin/tokens", label: "Tokens", icon: KeyRound },
  ],
};

const settingsNavGroup: NavGroup = {
  label: "Settings",
  items: [
    { to: "/settings/connections", label: "Connected AI apps", icon: PlugZap },
    { to: "/organizations", label: "Organizations", icon: Building2 },
  ],
};

function SidebarNavLink({
  icon: Icon,
  label,
  linkProps,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  linkProps: LinkOptions;
}) {
  const { setOpenMobile } = useSidebar();
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
          >
            <Icon className="size-4" />
            <span>{label}</span>
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
  // Same check as the admin layout's gate.
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const canManageOrganizationApps =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  const navGroups = canManageOrganizationApps
    ? [appsNavGroup, adminNavGroup, settingsNavGroup]
    : [appsNavGroup, settingsNavGroup];

  return (
    <UiSidebar variant="inset" collapsible="offcanvas" className="md:!p-0">
      {/* The top inset keeps the header clear of the status bar in the
          installed app, where the page runs under it. */}
      <SidebarHeader className="gap-0 px-3 pb-1 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]">
        <Link
          to="/"
          onClick={() => setOpenMobile(false)}
          className="flex items-center gap-1 pb-2 text-base font-semibold text-sidebar-foreground"
        >
          <img
            src="/transparent-logo.png"
            alt=""
            className="-my-1 size-8 rounded-md"
          />
          Every App
        </Link>
        <OrganizationSwitcher
          signedIn={signedIn}
          onCloseDrawer={() => setOpenMobile(false)}
        />
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label="Main navigation">
          {navGroups.map((group) => (
            <SidebarGroup key={group.label} className="py-1">
              <SidebarGroupLabel className="h-7 uppercase tracking-wider text-sidebar-foreground/40">
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const { icon, label, ...linkProps } = item;
                    return (
                      <SidebarNavLink
                        key={label}
                        icon={icon}
                        label={label}
                        linkProps={linkProps}
                      />
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <AccountFooter />
    </UiSidebar>
  );
}

function AccountFooter() {
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
    <UiSidebarFooter className="gap-0 border-t border-sidebar-border pb-safe">
      <SidebarMenu>
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
            <BookOpen className="size-4" />
            <span>Docs</span>
            <ExternalLink className="ml-auto size-3.5 opacity-60" />
          </SidebarMenuButton>
        </SidebarMenuItem>
        {email ? (
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    className={navButtonClass}
                    aria-label="Open account menu"
                  />
                }
              >
                <User className="size-4" />
                <span className="truncate">{email}</span>
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
                  <PlugZap className="size-4" />
                  Connected AI apps
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
    </UiSidebarFooter>
  );
}
