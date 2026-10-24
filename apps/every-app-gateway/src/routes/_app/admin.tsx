import {
  createFileRoute,
  Outlet,
  Link,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  Activity as ActivityIcon,
  AppWindow,
  KeyRound,
  ScrollText,
  ShieldAlert,
  Users,
  UsersRound,
} from "lucide-react";
import { useSession } from "@/client/hooks/useSession";
import { authClient } from "@/client/auth-client";
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

export const Route = createFileRoute("/_app/admin")({
  component: AdminLayout,
});

enum AdminTab {
  Users = "users",
  Groups = "groups",
  Apps = "apps",
  Tokens = "tokens",
  Usage = "usage",
  Activity = "activity",
}

const adminTabs = [
  { value: AdminTab.Users, label: "Users", to: "/admin/users", icon: Users },
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
] as const;

// One administration page; each tab has a URL and inherits the same access gate.
function AdminLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const { data: session, isPending } = useSession();
  const { data: activeMemberRole, isPending: isRolePending } =
    authClient.useActiveMemberRole();

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
      <PageHeader title="Manage workspace" />
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const tab = adminTabs.find((tab) => tab.value === value);
          if (tab) void navigate({ to: tab.to });
        }}
        className="gap-6"
      >
        {/* The tabs scroll sideways on a phone instead of being cut off. */}
        <div className="scrollbar-hidden overflow-x-auto border-b border-border pb-1">
          <TabsList
            variant="line"
            className="h-10 gap-5"
            aria-label="Manage workspace"
          >
            {adminTabs.map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="gap-2 px-1 pb-2"
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
