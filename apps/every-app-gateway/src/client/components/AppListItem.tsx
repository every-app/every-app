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
  appNeedsSetup,
  appStatus,
} from "@/client/lib/appStatus";
import type { UserAccessApp } from "@/types/app";

/**
 * Every card in a layout is the same height: the name is one line, the
 * description at most two (one on a phone's row), and a status sits beside
 * the name rather than adding a row.
 */
function cardHeightClass(list: boolean) {
  return cn("h-16 md:h-42", list && "md:h-13");
}

/**
 * Under `md` the cards are rows of one grouped list (the `ul` draws the
 * surface), so a card drops its own frame there.
 */
const PHONE_ROW = "max-md:rounded-none max-md:border-0 max-md:shadow-none";

/** The `ul` of app cards: one grouped surface under `md`, its rows divided. */
export const APP_LIST_PHONE_SURFACE =
  "max-md:gap-0 max-md:divide-y max-md:divide-border max-md:overflow-hidden max-md:rounded-xl max-md:border max-md:border-border max-md:bg-card max-md:shadow-xs";

interface AppListItemProps {
  app: UserAccessApp;
  pinned: boolean;
  onTogglePin: () => void;
  /** Opens the setup dialog, for an app that needs setup. */
  onOpenSetup: () => void;
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
 * What a deploying card says in place of its description: what is
 * happening, that the launcher polls, and that opening the app (the card
 * is a link) finishes the deploy once the Gateway can reach the Worker.
 */
export const DEPLOYING_CARD_SENTENCE =
  "Deploying. This page checks every few seconds; opening the app finishes it as soon as the Gateway can reach it.";

/** What a card says once a deploy has been binding for ten minutes. */
export const STALLED_CARD_SENTENCE =
  "Still deploying after 10 minutes. Open the app to finish it; if it won't open, run everyapp status in the app's folder, then deploy again.";

/**
 * The app is a normal link; pinning is a separate, keyboard-accessible
 * action. An app that needs setup is no link: the card (its badge
 * included) opens the setup dialog instead. A paused app (at its monthly
 * cap) opens as it did, since only its provider calls are refused: its
 * one chip says Paused and its description says who raises the cap. A
 * deploying app is a link too, since a visit is what makes it live: its
 * chip says Deploying (or Deploy stalled after ten minutes) and its
 * description says the page is checking.
 */
export function AppListItem({
  app,
  pinned,
  onTogglePin,
  onOpenSetup,
  layout,
}: AppListItemProps) {
  const status = appStatus(app);
  const routable = status.opens;
  const needsSetup = appNeedsSetup(app);
  const paused = status.label === AppStatusLabel.Paused;
  const deploying =
    status.label === AppStatusLabel.Deploying ||
    status.label === AppStatusLabel.Stalled;
  const sentence =
    status.label === AppStatusLabel.Paused
      ? PAUSED_CARD_SENTENCE
      : status.label === AppStatusLabel.Deploying
        ? DEPLOYING_CARD_SENTENCE
        : status.label === AppStatusLabel.Stalled
          ? STALLED_CARD_SENTENCE
          : null;
  const list = layout === AppLibraryLayout.List;
  const pinLabel = `${pinned ? "Unpin" : "Pin"} ${app.name}`;
  const PinIcon = pinned ? PinOff : Pin;
  // Open the connection to the app while the pointer rests on the card
  // (lib/appLaunchPrefetch); an app that opens always has a hostname.
  const { hostname } = app;
  const warm = hostname ? () => preconnectTo(hostname) : undefined;
  // What sits beside the name when there is no arrow: Paused on an app that
  // is at its cap, Deploying on one still deploying, else the state of an app
  // that doesn't open.
  const chip =
    paused || deploying || !routable ? (
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
          "row-span-2 size-10 rounded-lg md:mb-4",
          list && "md:row-span-1 md:mb-0 md:size-8",
        )}
      />
      <div
        className={cn(
          "min-w-0 pr-12 md:pr-8",
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
            "mt-0.5 line-clamp-1 text-xs leading-5 text-muted-foreground md:mt-1 md:line-clamp-2 md:leading-relaxed",
            list && "md:mt-0 md:line-clamp-none md:truncate md:leading-5",
          )}
        >
          {sentence ?? app.description}
        </p>
      </div>
      <div
        className={cn(
          // Centered on a phone's row by a translate, which only applies
          // there: any translate makes this the pin's containing block,
          // and the grid card pins it to the card's own corner.
          "absolute top-1/2 right-2 flex items-center text-xs font-medium max-md:-translate-y-1/2 md:static md:mt-auto md:w-full",
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
    "grid min-h-0 flex-1 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 px-4 py-3 md:flex md:flex-col md:items-stretch md:rounded-xl md:p-5",
    list &&
      "md:grid md:grid-cols-[2rem_minmax(0,1fr)_auto] md:items-center md:gap-x-3 md:px-4 md:py-2",
  );
  const overlayClass =
    "absolute inset-0 outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 md:rounded-xl";

  return (
    <li>
      <Card
        className={cn(
          "group relative gap-0 py-0 transition-colors motion-reduce:transition-none",
          PHONE_ROW,
          cardHeightClass(list),
          routable
            ? "hover:border-foreground/25"
            : "bg-card/60 max-md:bg-muted/60",
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
          "flex-row items-center gap-3 px-4 py-3 md:flex-col md:items-stretch md:gap-4 md:p-5",
          PHONE_ROW,
          cardHeightClass(list),
          list && "md:flex-row md:items-center md:gap-3 md:px-4 md:py-2",
        )}
      >
        <Skeleton
          className={cn("size-10 shrink-0 rounded-lg", list && "md:size-8")}
        />
        <div
          className={cn(
            "flex-1 space-y-2 md:space-y-3",
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
