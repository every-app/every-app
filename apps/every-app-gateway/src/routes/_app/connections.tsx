import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Bot, CircleUserRound } from "lucide-react";
import { Page, PageHeader } from "@/client/components/PageHeader";
import { PageTabStrip } from "@/client/components/PageTabStrip";
import { Badge } from "@/client/components/ui/badge";
import { Tabs, TabsContent } from "@/client/components/ui/tabs";
import { useConnectedAccounts } from "@/client/hooks/useConnectedAccounts";

/**
 * Your connections: everything the signed-in person has connected, a tab
 * each with its own URL. Accounts, where it opens: the accounts they
 * connected inside an app, with a count on its tab of the ones that need
 * Reconnect, and the apps signed in on their devices. Agents: the AI apps
 * on the Gateway's /mcp, with the steps to connect another.
 */
export const Route = createFileRoute("/_app/connections")({
  component: ConnectionsLayout,
});

enum ConnectionsTab {
  Accounts = "accounts",
  Agents = "agents",
}

const TABS = [
  {
    value: ConnectionsTab.Accounts,
    label: "Accounts",
    to: "/connections/accounts",
    icon: CircleUserRound,
  },
  {
    value: ConnectionsTab.Agents,
    label: "Agents",
    to: "/connections/agents",
    icon: Bot,
  },
] as const;

function ConnectionsLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  // An account that needs Reconnect is counted on its tab, so it isn't
  // missed from the Agents tab.
  const { data: accounts } = useConnectedAccounts();
  const toReconnect = (accounts?.connections ?? []).filter(
    (account) => account.needsReconnect,
  ).length;

  const activeTab =
    TABS.find((tab) => tab.to === pathname)?.value ?? ConnectionsTab.Accounts;

  return (
    <Page>
      <PageHeader title="Your connections" />
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const tab = TABS.find((tab) => tab.value === value);
          if (tab) void navigate({ to: tab.to });
        }}
        className="gap-6"
      >
        <PageTabStrip
          label="Your connections"
          tabs={TABS.map((tab) =>
            tab.value === ConnectionsTab.Accounts && toReconnect > 0
              ? {
                  ...tab,
                  badge: (
                    <Badge variant="warning">
                      {toReconnect}
                      <span className="sr-only"> to reconnect</span>
                    </Badge>
                  ),
                }
              : tab,
          )}
          activeTab={activeTab}
        />
        {TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            {activeTab === tab.value ? <Outlet /> : null}
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  );
}
