import { TriangleAlert } from "lucide-react";
import { ProviderTile } from "@/client/components/ProviderIcon";
import { DateCell } from "@/client/components/table/DateCell";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/client/components/ui/sheet";
import { accessSummary, connectionName } from "@/client/lib/oauthProviders";

/** A connected account as Your connections → Accounts lists it. */
interface Account {
  id: string;
  providerId: string;
  providerName: string;
  label: string | null;
  apps: { rowId: string; id: string; name: string }[];
  scopes: string[];
  needsReconnect: boolean;
  permissions: { listed: number; granted: number; notGranted: string[] } | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * Everything about one connected account, behind its row: when it was
 * connected and last used, each app allowed to use it with the button that
 * takes that app's access away, and every permission it holds in the
 * provider's own names (the row says them in a few words), then the ones
 * its apps list that weren't granted, said plainly: granting part is the
 * person's choice. Reconnect and Disconnect are at the bottom. Render it only while it is open.
 */
export function ConnectedAccountSheet<TAccount extends Account>({
  account,
  isReconnecting,
  onReconnect,
  onRemoveApp,
  onDisconnect,
  onClose,
}: {
  account: TAccount;
  isReconnecting: boolean;
  onReconnect: (account: TAccount, options: { fresh: boolean }) => void;
  onRemoveApp: (access: {
    connection: TAccount;
    app: TAccount["apps"][number];
  }) => void;
  onDisconnect: (account: TAccount) => void;
  onClose: () => void;
}) {
  const name = connectionName(account);
  // The row's few words, unless they are only the count the heading has.
  const words = accessSummary(account);
  const summary =
    account.scopes.length > 0 && !/^\d+ permissions?$/.test(words)
      ? words
      : null;
  const notGranted = account.permissions?.notGranted ?? [];
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="flex-row items-center gap-3 pr-12">
          <ProviderTile id={name.mark} name={name.title} />
          <div className="min-w-0">
            <SheetTitle className="truncate leading-tight">
              {name.title}
            </SheetTitle>
            <SheetDescription className="truncate">
              {name.subtitle ?? (name.mcp ? "MCP server" : "Connected account")}
            </SheetDescription>
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
          {account.needsReconnect ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertDescription className="text-foreground">
                An app can't use this account until you reconnect it.
              </AlertDescription>
            </Alert>
          ) : null}

          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-xs text-muted-foreground">Connected</dt>
              <dd className="mt-0.5">
                <DateCell value={account.createdAt} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last used</dt>
              <dd className="mt-0.5">
                <DateCell value={account.lastUsedAt} />
              </dd>
            </div>
          </dl>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Apps that can use it</h3>
            {account.apps.length > 0 ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {account.apps.map((app) => (
                  <li
                    key={app.rowId}
                    className="flex min-h-11 items-center justify-between gap-3 py-1.5 pr-1.5 pl-3"
                  >
                    <span className="truncate">{app.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground"
                      aria-label={`Remove ${app.name}'s access`}
                      onClick={() => onRemoveApp({ connection: account, app })}
                    >
                      Remove access
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                None yet. An app asks you before it uses this account.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium">
                Permissions
                {account.scopes.length > 1 ? (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    {account.scopes.length}
                  </span>
                ) : null}
              </h3>
              {summary ? (
                <span className="text-xs text-muted-foreground">{summary}</span>
              ) : null}
            </div>
            {account.scopes.length > 0 ? (
              <ul
                aria-label="Permissions"
                className="divide-y divide-border rounded-lg border border-border"
              >
                {account.scopes.map((scope) => (
                  <li
                    key={scope}
                    className="px-3 py-1.5 font-mono text-xs wrap-anywhere"
                  >
                    {scope}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                This connection holds no permissions.
              </p>
            )}
          </section>

          {notGranted.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">
                Not granted
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {notGranted.length}
                </span>
              </h3>
              <p className="text-xs text-muted-foreground">
                Your apps also list these, and {name.title} didn't grant them
                when you connected. Everything else works. Reconnect asks for
                them again.
              </p>
              <ul
                aria-label="Permissions not granted"
                className="divide-y divide-border rounded-lg border border-border text-muted-foreground"
              >
                {notGranted.map((scope) => (
                  <li
                    key={scope}
                    className="px-3 py-1.5 font-mono text-xs wrap-anywhere"
                  >
                    {scope}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <SheetFooter className="flex-row justify-end border-t border-border">
          <Button variant="destructive" onClick={() => onDisconnect(account)}>
            Disconnect
          </Button>
          <Button
            variant={account.needsReconnect ? "default" : "outline"}
            disabled={isReconnecting}
            onClick={() =>
              onReconnect(account, { fresh: !account.needsReconnect })
            }
          >
            Reconnect
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
