import { useMatches } from "@tanstack/react-router";
import { cn } from "cn";

/**
 * The build this gateway runs: short commit and build time, with a `*` when
 * the tree was dirty (vite.config.ts). An operator matches a screen to a
 * commit with it, so it shows on every host and never hides on hover.
 */
export function BuildStamp({ className }: { className?: string }) {
  return (
    <div
      className={cn("truncate font-mono text-[10px] select-none", className)}
      title="Gateway build"
    >
      {__GATEWAY_BUILD__}
    </div>
  );
}

/**
 * The stamp in the bottom-right corner of the pages without a sidebar:
 * sign-in, setup, the 404. Under the app shell the sidebar carries it, so it
 * never prints over a page's content.
 */
export function FloatingBuildStamp() {
  const inAppShell = useMatches({
    select: (matches) => matches.some((match) => match.routeId === "/_app"),
  });
  if (inAppShell) return null;
  return (
    <BuildStamp className="pointer-events-none fixed right-2 bottom-1.5 z-50 hidden text-muted-foreground opacity-70 md:block" />
  );
}
