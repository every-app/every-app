import { X } from "lucide-react";
import { Button } from "@/client/components/ui/button";

interface ConnectionApp {
  rowId: string;
  name: string;
}

/**
 * The apps a person allowed to use one of their connections
 * (docs/design/2026-11-oauth-one-connection.md), each with the button that
 * takes its access away. Your connections → Accounts and Manage workspace →
 * Providers both list them this way.
 */
export function ConnectionApps<TApp extends ConnectionApp>({
  apps,
  onRemove,
}: {
  apps: readonly TApp[];
  onRemove: (app: TApp) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-1">
      {apps.map((app) => (
        <li
          key={app.rowId}
          className="flex h-[calc(--spacing(5.25))] items-center rounded-sm bg-muted pl-1.5 text-xs font-medium whitespace-nowrap text-foreground"
        >
          {app.name}
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-50 hover:opacity-100"
            aria-label={`Remove ${app.name}'s access`}
            onClick={() => onRemove(app)}
          >
            <X aria-hidden />
          </Button>
        </li>
      ))}
    </ul>
  );
}
