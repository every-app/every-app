import { X } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/client/components/ui/button";

interface ConnectionApp {
  rowId: string;
  name: string;
}

/**
 * Apps as chips: the apps a person allowed to use one of their connections
 * (docs/design/2026-11-oauth-one-connection.md), or the apps that list a
 * provider. With `onRemove`, each chip has the button that takes that app's
 * access away. Your connections → Accounts and Manage workspace → Providers
 * list them this way.
 */
export function ConnectionApps<TApp extends ConnectionApp>({
  apps,
  onRemove,
}: {
  apps: readonly TApp[];
  onRemove?: (app: TApp) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-1">
      {apps.map((app) => (
        <li
          key={app.rowId}
          className={cn(
            "flex h-[calc(--spacing(5.25))] items-center rounded-sm bg-muted text-xs font-medium whitespace-nowrap text-foreground",
            onRemove ? "pl-1.5" : "px-1.5",
          )}
        >
          {app.name}
          {onRemove ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-50 hover:opacity-100"
              aria-label={`Remove ${app.name}'s access`}
              onClick={() => onRemove(app)}
            >
              <X aria-hidden />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
