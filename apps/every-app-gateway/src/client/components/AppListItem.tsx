import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/client/components/ui/badge";
import { Card, CardContent } from "@/client/components/ui/card";
import { Skeleton } from "@/client/components/ui/skeleton";
import type { UserAccessApp } from "@/types/app";

interface AppListItemProps {
  app: UserAccessApp;
}

/**
 * One launcher entry. Apps live on their own subdomains behind the gateway
 * perimeter, so an entry is a plain link to `https://<hostname>` — no iframe,
 * no token handshake. The scheme is inherited from the launcher's own origin
 * so local dev gateways (http) keep working.
 */
export function AppListItem({ app }: AppListItemProps) {
  const routable = Boolean(app.hostname) && app.status === "active";

  if (!routable) {
    const label = !app.hostname ? "needs deploy" : app.status;
    return (
      <li title="Deploy this app with `everyapp deploy` to make it reachable.">
        <Card className="h-full opacity-60">
          <AppCardBody
            app={app}
            trailing={<Badge variant="outline">{label}</Badge>}
          />
        </Card>
      </li>
    );
  }

  return (
    <li>
      <a
        href={`//${app.hostname}`}
        className="group block h-full rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Card className="h-full transition-colors group-hover:border-foreground/20">
          <AppCardBody
            app={app}
            trailing={
              <ArrowUpRight
                className="size-4 text-muted-foreground transition-colors group-hover:text-foreground"
                aria-hidden
              />
            }
          />
        </Card>
      </a>
    </li>
  );
}

/** A card shaped like `AppListItem`, while the apps load. */
export function AppListItemSkeleton() {
  return (
    <li>
      <Card className="h-full">
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="min-w-0 flex-1">
              <div className="flex h-5 items-center">
                <Skeleton className="h-3.5 w-28" />
              </div>
              <div className="flex h-4 items-center">
                <Skeleton className="h-3 w-40 max-w-full" />
              </div>
            </div>
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

function AppCardBody({
  app,
  trailing,
}: {
  app: UserAccessApp;
  trailing: ReactNode;
}) {
  return (
    <CardContent className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/5 text-sm font-semibold"
        >
          {appInitial(app.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{app.name}</p>
          {app.hostname ? (
            <p className="truncate text-xs text-muted-foreground">
              {app.hostname}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 self-start">{trailing}</span>
      </div>
      {app.description ? (
        <p className="line-clamp-2 text-muted-foreground">{app.description}</p>
      ) : null}
    </CardContent>
  );
}

/** The first character of the name (a whole emoji, not half of one). */
function appInitial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}
