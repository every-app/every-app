import { ArrowUpRight, Pin, PinOff } from "lucide-react";
import { cn } from "cn";
import { AppIcon } from "@/client/components/AppIcon";
import { Badge } from "@/client/components/ui/badge";
import { Button, buttonVariants } from "@/client/components/ui/button";
import { Card } from "@/client/components/ui/card";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/client/components/ui/tooltip";
import { AppLibraryLayout } from "@/client/hooks/useAppLibrary";
import type { UserAccessApp } from "@/types/app";

interface AppListItemProps {
  app: UserAccessApp;
  pinned: boolean;
  onTogglePin: () => void;
  layout: AppLibraryLayout;
}

/** The app is a normal link; pinning is a separate, keyboard-accessible action. */
export function AppListItem({
  app,
  pinned,
  onTogglePin,
  layout,
}: AppListItemProps) {
  const routable = Boolean(app.hostname) && app.status === "active";
  const list = layout === AppLibraryLayout.List;
  const label = !app.hostname ? "Needs deploy" : app.status;
  const pinLabel = `${pinned ? "Unpin" : "Pin"} ${app.name}`;
  const PinIcon = pinned ? PinOff : Pin;
  const body = (
    <>
      <AppIcon
        app={app}
        className={cn(
          "row-span-2 md:mb-5",
          list && "md:row-span-1 md:mb-0 md:size-8",
        )}
      />
      <div
        className={cn(
          "min-w-0 pr-8",
          list && "md:flex md:items-baseline md:gap-3 md:pr-0",
        )}
      >
        <h3
          className={cn(
            "text-sm font-semibold tracking-tight md:text-base",
            list &&
              "md:max-w-1/2 md:shrink-0 md:truncate md:text-sm md:leading-5",
          )}
        >
          {app.name}
        </h3>
        <p
          className={cn(
            "mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground md:mt-2",
            list && "md:mt-0 md:line-clamp-none md:truncate md:leading-5",
          )}
        >
          {app.description}
        </p>
      </div>
      <div
        className={cn(
          "absolute top-2 right-2 flex items-center text-xs font-medium md:static md:mt-auto md:w-full md:justify-between md:border-t md:border-border md:pt-4",
          list &&
            "md:mt-0 md:w-auto md:gap-2 md:self-center md:justify-end md:border-0 md:pt-0",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={pinLabel}
                aria-pressed={pinned}
                onClick={onTogglePin}
                className={cn(
                  "pointer-events-auto relative z-10 size-11 text-muted-foreground md:absolute md:top-3 md:right-3 md:size-8",
                  list && "md:static",
                  pinned && "bg-muted text-foreground",
                )}
              />
            }
          >
            <PinIcon className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>{pinLabel}</TooltipContent>
        </Tooltip>
        {routable ? (
          <span
            className={cn(
              list && buttonVariants({ variant: "outline", size: "sm" }),
              "hidden w-full items-center justify-between md:flex",
              list && "md:w-auto md:justify-center md:gap-1 md:text-xs",
            )}
          >
            Open app
            <ArrowUpRight
              className="size-4 text-muted-foreground"
              aria-hidden
            />
          </span>
        ) : (
          <Badge variant="outline" className="hidden md:inline-flex">
            {label}
          </Badge>
        )}
      </div>
      {!routable ? (
        <Badge variant="outline" className="col-start-2 mt-2 md:hidden">
          {label}
        </Badge>
      ) : null}
    </>
  );
  const bodyClass = cn(
    "grid min-h-32 grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-4 rounded-xl p-5 md:flex md:min-h-60 md:flex-col md:items-stretch md:p-6",
    list &&
      "md:grid md:min-h-12 md:grid-cols-[2rem_minmax(0,1fr)_auto] md:items-center md:gap-x-3 md:px-4 md:py-2",
  );

  return (
    <li className="h-full">
      <Card
        className={cn(
          "group relative h-full gap-0 py-0 transition-colors motion-reduce:transition-none",
          routable ? "hover:border-foreground/25" : "bg-card/60",
        )}
      >
        <div className={cn(bodyClass, "pointer-events-none")}>{body}</div>
        {routable ? (
          <a
            href={`//${app.hostname}`}
            aria-label={`Open ${app.name}`}
            className="absolute inset-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
          />
        ) : null}
      </Card>
    </li>
  );
}

export function AppListItemSkeleton({ layout }: { layout: AppLibraryLayout }) {
  const list = layout === AppLibraryLayout.List;
  return (
    <li>
      <Card
        className={cn(
          "min-h-32 flex-row items-center gap-4 p-5 md:min-h-60 md:flex-col md:items-stretch md:p-6",
          list &&
            "md:min-h-12 md:flex-row md:items-center md:gap-3 md:px-4 md:py-2",
        )}
      >
        <Skeleton
          className={cn("size-12 shrink-0 rounded-xl", list && "md:size-8")}
        />
        <div
          className={cn(
            "flex-1 space-y-3",
            list && "md:flex md:min-w-0 md:items-center md:gap-3 md:space-y-0",
          )}
        >
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-3/4" />
        </div>
        <Skeleton
          className={cn("hidden h-3 w-16 md:block", list && "md:ml-auto")}
        />
      </Card>
    </li>
  );
}
