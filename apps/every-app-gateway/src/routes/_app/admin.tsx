import {
  createFileRoute,
  Outlet,
  Link,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Activity as ActivityIcon,
  AppWindow,
  KeyRound,
  LogIn,
  Pencil,
  Plug,
  ScrollText,
  ShieldAlert,
  Users,
  UsersRound,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/client/hooks/useSession";
import {
  ACTIVE_ORGANIZATION_QUERY_KEY,
  useActiveOrganization,
  type ActiveOrganization,
} from "@/client/hooks/useActiveOrganization";
import { authClient } from "@/client/auth-client";
import { RenameWorkspaceDialog } from "@/client/components/admin/RenameWorkspaceDialog";
import { EmptyState } from "@/client/components/EmptyState";
import { SkeletonPage } from "@/client/components/SkeletonPresets";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Button } from "@/client/components/ui/button";
import { Page, PageHeader } from "@/client/components/PageHeader";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/client/components/ui/tabs";
import { renameOrganization } from "@/serverFunctions/organizations";

export const Route = createFileRoute("/_app/admin")({
  component: AdminLayout,
});

enum AdminTab {
  Users = "users",
  SignIn = "sign-in",
  Groups = "groups",
  Apps = "apps",
  Tokens = "tokens",
  Providers = "providers",
  Usage = "usage",
  Activity = "activity",
  Events = "events",
}

const adminTabs = [
  { value: AdminTab.Users, label: "Users", to: "/admin/users", icon: Users },
  {
    value: AdminTab.SignIn,
    label: "Sign-in",
    to: "/admin/sign-in",
    icon: LogIn,
  },
  {
    value: AdminTab.Groups,
    label: "Groups",
    to: "/admin/groups",
    icon: UsersRound,
  },
  { value: AdminTab.Apps, label: "Apps", to: "/admin/apps", icon: AppWindow },
  {
    value: AdminTab.Tokens,
    label: "Tokens",
    to: "/admin/tokens",
    icon: KeyRound,
  },
  {
    value: AdminTab.Providers,
    label: "Providers",
    to: "/admin/providers",
    icon: Plug,
  },
  {
    value: AdminTab.Usage,
    label: "Usage",
    to: "/admin/usage",
    icon: ActivityIcon,
  },
  {
    value: AdminTab.Activity,
    label: "Activity",
    to: "/admin/activity",
    icon: ScrollText,
  },
  {
    value: AdminTab.Events,
    label: "Events",
    to: "/admin/events",
    icon: Webhook,
  },
] as const;

// One administration page; each tab has a URL and inherits the same access gate.
function AdminLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending } = useSession();
  const { data: activeMemberRole, isPending: isRolePending } =
    authClient.useActiveMemberRole();
  // The workspace's name for Rename; the same query the sidebar's switcher
  // reads, so a rename shows there at once.
  const { data: activeOrganization } = useActiveOrganization({
    enabled: Boolean(session?.user),
  });
  const [renaming, setRenaming] = useState(false);

  // Show loading while checking session
  if (isPending || isRolePending) {
    return <SkeletonPage />;
  }

  const hasAdminAccess =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";

  if (!session || !hasAdminAccess) {
    return (
      <StatusScreen>
        <EmptyState
          variant="plain"
          size="lg"
          icon={ShieldAlert}
          title="You don't have access to this page"
          description="Only owners and admins can manage the workspace."
          action={
            <Button nativeButton={false} render={<Link to="/" />}>
              Go home
            </Button>
          }
        />
      </StatusScreen>
    );
  }

  const activeTab =
    adminTabs.find((tab) => tab.to === pathname)?.value ?? AdminTab.Users;

  return (
    <Page>
      <PageHeader
        title="Manage workspace"
        actions={
          activeOrganization ? (
            <Button variant="outline" onClick={() => setRenaming(true)}>
              <Pencil data-icon="inline-start" />
              Rename
            </Button>
          ) : null
        }
      />
      {renaming && activeOrganization ? (
        <RenameWorkspaceDialog
          name={activeOrganization.name}
          onClose={() => setRenaming(false)}
          onSubmit={async (name) => {
            const renamed = await renameOrganization({ data: { name } });
            // The sidebar's switcher reads the gateway's query: seed it with
            // the name the server wrote, so it shows the instant the dialog
            // closes, then refetch to be sure.
            // The switcher's menu lists Better Auth's organizations,
            // refetched by notifying its $listOrg signal (what its own
            // /organization/update would do, were it open).
            queryClient.setQueryData<ActiveOrganization>(
              ACTIVE_ORGANIZATION_QUERY_KEY,
              (old) => (old ? { ...old, name: renamed.name } : old),
            );
            setRenaming(false);
            authClient.$store.notify("$listOrg");
            toast.success("Workspace renamed");
            await queryClient.invalidateQueries({
              queryKey: ACTIVE_ORGANIZATION_QUERY_KEY,
            });
          }}
        />
      ) : null}
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const tab = adminTabs.find((tab) => tab.value === value);
          if (tab) void navigate({ to: tab.to });
        }}
        className="gap-6"
      >
        {/* The tabs scroll sideways on a phone instead of being cut off. The
            line is an inset shadow, so the active tab's bar sits on it, and
            the first tab starts on the page's left edge. */}
        <div className="scrollbar-hidden overflow-x-auto shadow-[inset_0_-1px_0_var(--border)]">
          <TabsList
            variant="line"
            className="gap-6 p-0 group-data-horizontal/tabs:h-10"
            aria-label="Manage workspace"
          >
            {adminTabs.map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-full gap-2 rounded-none border-0 px-0 group-data-horizontal/tabs:after:bottom-0"
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {adminTabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            {activeTab === tab.value ? <Outlet /> : null}
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  );
}
