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
import { preconnectTo } from "@/client/lib/appLaunchPrefetch";
import {
  AppStatusLabel,
  MCP_APP_KIND_LABEL,
  appNeedsSetup,
  appStatus,
  mcpAppUsable,
} from "@/client/lib/appStatus";
import type { UserAccessApp } from "@/types/app";

/**
 * Every card in a layout is the same height: the name is one line, the
 * description at most two, and a status sits beside the name rather than
 * adding a row.
 */
function cardHeightClass(list: boolean) {
  return cn("h-32 md:h-42", list && "md:h-13");
}

interface AppListItemProps {
  app: UserAccessApp;
  pinned: boolean;
  onTogglePin: () => void;
  /** Opens the setup dialog, for an app that needs setup. */
  onOpenSetup: () => void;
  /** Opens the "Use it from your agent" dialog, for an MCP app that is set up. */
  onUseMcp: () => void;
  layout: AppLibraryLayout;
}

/**
 * What a paused card says in place of its description, on phones and to
 * screen readers too (the chip alone can't say it: the body sits under
 * the link overlay, so nothing in it takes a hover).
 */
export const PAUSED_CARD_SENTENCE =
  "Monthly cap reached. An owner or admin can raise it under Manage workspace → Usage.";

/**
 * The app is a normal link; pinning is a separate, keyboard-accessible
 * action. An app that needs setup is no link: the card (its badge
 * included) opens the setup dialog instead. An MCP app has no page: its
 * card carries an "MCP" chip where the open arrow would be and opens the
 * dialog that says how an agent uses it. A paused app (at its monthly
 * cap) opens as it did, since only its provider calls are refused: its
 * one chip says Paused and its description says who raises the cap.
 */
export function AppListItem({
  app,
  pinned,
  onTogglePin,
  onOpenSetup,
  onUseMcp,
  layout,
}: AppListItemProps) {
  const status = appStatus(app);
  const routable = status.opens;
  const needsSetup = appNeedsSetup(app);
  const mcp = mcpAppUsable(app);
  const paused = status.label === AppStatusLabel.Paused;
  const list = layout === AppLibraryLayout.List;
  const pinLabel = `${pinned ? "Unpin" : "Pin"} ${app.name}`;
  const PinIcon = pinned ? PinOff : Pin;
  // Open the connection to the app while the pointer rests on the card
  // (lib/appLaunchPrefetch); an app that opens always has a hostname.
  const { hostname } = app;
  const warm = hostname ? () => preconnectTo(hostname) : undefined;
  // What sits beside the name when there is no arrow, one chip per card:
  // Paused on an app that is at its cap (a state the person acts on, so
  // it comes before the kind), else the kind of an MCP app, else the
  // state of an app that doesn't open.
  // The kind in the badge's soft tint, so it never reads as a state.
  const chip = paused ? (
    <Badge
      variant={status.variant}
      className={cn("shrink-0", list && "md:hidden")}
    >
      {status.label}
    </Badge>
  ) : mcp ? (
    <Badge variant="soft" className={cn("shrink-0", list && "md:hidden")}>
      {MCP_APP_KIND_LABEL}
    </Badge>
  ) : !routable ? (
    <Badge
      variant={status.variant}
      className={cn("shrink-0", list && "md:hidden")}
    >
      {status.label}
    </Badge>
  ) : null;
  const body = (
    <>
      <AppIcon
        app={app}
        className={cn(
          "row-span-2 md:mb-4 md:size-10 md:rounded-lg",
          list && "md:row-span-1 md:mb-0 md:size-8",
        )}
      />
      <div
        className={cn(
          "min-w-0 pr-8",
          list && "md:flex md:items-baseline md:gap-3 md:pr-0 md:pb-0",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            list && "md:max-w-1/2 md:shrink-0",
          )}
        >
          <h3
            className={cn(
              "truncate text-sm font-semibold tracking-tight md:text-base",
              list && "md:text-sm md:leading-5",
            )}
          >
            {app.name}
          </h3>
          {chip ??
            (!list ? (
              <ArrowUpRight
                className="-ml-1 hidden size-3.5 shrink-0 text-muted-foreground md:block"
                aria-hidden
              />
            ) : null)}
        </div>
        <p
          className={cn(
            "mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground",
            list && "md:mt-0 md:line-clamp-none md:truncate md:leading-5",
          )}
        >
          {paused ? PAUSED_CARD_SENTENCE : app.description}
        </p>
      </div>
      <div
        className={cn(
          "absolute top-2 right-2 flex items-center text-xs font-medium md:static md:mt-auto md:w-full",
          list &&
            "md:mt-0 md:w-auto md:gap-2 md:self-center md:justify-end md:pt-0",
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
        {list ? (
          routable && !paused ? (
            <span
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "hidden md:flex md:gap-1 md:text-xs",
              )}
            >
              Open app
              <ArrowUpRight
                className="size-4 text-muted-foreground"
                aria-hidden
              />
            </span>
          ) : mcp && !paused ? (
            <Badge variant="soft" className="hidden md:inline-flex">
              {MCP_APP_KIND_LABEL}
            </Badge>
          ) : (
            <Badge variant={status.variant} className="hidden md:inline-flex">
              {status.label}
            </Badge>
          )
        ) : null}
      </div>
    </>
  );
  const bodyClass = cn(
    "grid min-h-0 flex-1 grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-4 rounded-xl p-5 md:flex md:flex-col md:items-stretch",
    list &&
      "md:grid md:grid-cols-[2rem_minmax(0,1fr)_auto] md:items-center md:gap-x-3 md:px-4 md:py-2",
  );
  const overlayClass =
    "absolute inset-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50";

  return (
    <li>
      <Card
        className={cn(
          "group relative gap-0 py-0 transition-colors motion-reduce:transition-none",
          cardHeightClass(list),
          routable || mcp ? "hover:border-foreground/25" : "bg-card/60",
          needsSetup && "hover:border-foreground/25",
        )}
      >
        <div className={cn(bodyClass, "pointer-events-none")}>{body}</div>
        {routable ? (
          <a
            href={`//${app.hostname}`}
            aria-label={`Open ${app.name}`}
            onPointerEnter={warm}
            onFocus={warm}
            onTouchStart={warm}
            className={overlayClass}
          />
        ) : needsSetup ? (
          <button
            type="button"
            aria-label={`Set up ${app.name}`}
            aria-haspopup="dialog"
            onClick={onOpenSetup}
            className={cn(overlayClass, "cursor-pointer")}
          />
        ) : mcp ? (
          <button
            type="button"
            aria-label={`Use ${app.name} from your agent`}
            aria-haspopup="dialog"
            onClick={onUseMcp}
            className={cn(overlayClass, "cursor-pointer")}
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
          "flex-row items-center gap-4 p-5 md:flex-col md:items-stretch",
          cardHeightClass(list),
          list && "md:flex-row md:items-center md:gap-3 md:px-4 md:py-2",
        )}
      >
        <Skeleton
          className={cn(
            "size-12 shrink-0 rounded-xl md:size-10 md:rounded-lg",
            list && "md:size-8",
          )}
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
