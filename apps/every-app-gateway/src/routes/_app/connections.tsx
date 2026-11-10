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
 * Connections: everything the signed-in person has connected, a tab each
 * with its own URL. Agents: the AI apps on the Gateway's /mcp and the native
 * apps signed in on a device, with the steps to connect another. Accounts:
 * the accounts they connected inside an app.
 */
export const Route = createFileRoute("/_app/connections")({
  component: ConnectionsLayout,
});

enum ConnectionsTab {
  Agents = "agents",
  Accounts = "accounts",
}

const TABS = [
  {
    value: ConnectionsTab.Agents,
    label: "Agents",
    to: "/connections",
    icon: Bot,
  },
  {
    value: ConnectionsTab.Accounts,
    label: "Accounts",
    to: "/connections/accounts",
    icon: CircleUserRound,
  },
] as const;

function ConnectionsLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  // An account that stopped working is counted on its tab, so it isn't
  // missed from the Agents tab.
  const { data: accounts } = useConnectedAccounts();
  const toReconnect = (accounts?.connections ?? []).filter(
    (account) => account.status === "expired",
  ).length;

  const activeTab =
    TABS.find((tab) => tab.to === pathname)?.value ?? ConnectionsTab.Agents;

  return (
    <Page>
      <PageHeader title="Connections" />
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const tab = TABS.find((tab) => tab.value === value);
          if (tab) void navigate({ to: tab.to });
        }}
        className="gap-6"
      >
        <PageTabStrip
          label="Connections"
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
