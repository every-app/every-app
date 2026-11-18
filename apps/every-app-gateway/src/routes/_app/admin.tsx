import {
  createFileRoute,
  Outlet,
  Link,
  useChildMatches,
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
  Radio,
  ScrollText,
  ShieldAlert,
  Users,
  UsersRound,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { useSession } from "@/client/hooks/useSession";
import {
  ACTIVE_ORGANIZATION_QUERY_KEY,
  useActiveOrganization,
  type ActiveOrganization,
} from "@/client/hooks/useActiveOrganization";
import { authClient } from "@/client/auth-client";
import { UsageReportsNotice } from "@/client/components/admin/UsageReportsNotice";
import { RenameWorkspaceDialog } from "@/client/components/admin/RenameWorkspaceDialog";
import { EmptyState } from "@/client/components/EmptyState";
import { SkeletonPage } from "@/client/components/SkeletonPresets";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Button } from "@/client/components/ui/button";
import { Page, PageHeader } from "@/client/components/PageHeader";
import { PageTabStrip } from "@/client/components/PageTabStrip";
import { Tabs, TabsContent } from "@/client/components/ui/tabs";
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
  UsageReports = "usage-reports",
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
  {
    value: AdminTab.UsageReports,
    label: "Usage reports",
    to: "/admin/usage-reports",
    icon: Radio,
  },
] as const;

// One administration page; each tab has a URL and inherits the same access gate.
function AdminLayout() {
  // The page in the outlet below: its tab is the active one, so the tab and
  // the page change in the same render.
  const shownPath = useChildMatches({
    select: (matches) => matches[0]?.fullPath,
  });
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
  const isMobile = useIsMobile();

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
    adminTabs.find((tab) => tab.to === shownPath)?.value ?? AdminTab.Users;

  return (
    <Page>
      <PageHeader
        title="Manage workspace"
        actions={
          activeOrganization ? (
            // An icon on a phone, so it stays on the title's line.
            isMobile ? (
              <Button
                variant="outline"
                size="icon"
                aria-label="Rename"
                onClick={() => setRenaming(true)}
              >
                <Pencil />
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setRenaming(true)}>
                <Pencil data-icon="inline-start" />
                Rename
              </Button>
            )
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
      <UsageReportsNotice />
      <Tabs value={activeTab} className="gap-6">
        <PageTabStrip
          label="Manage workspace"
          tabs={adminTabs}
          activeTab={activeTab}
        />
        <TabsContent value={activeTab}>
          <Outlet />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
