import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useScrollEdges } from "@/client/hooks/useScrollEdges";
import { TabsList, TabsTrigger } from "@/client/components/ui/tabs";

/** One tab of a page. */
interface PageTab<Value extends string> {
  value: Value;
  label: string;
  icon: LucideIcon;
  /** After the label: a count that needs attention, for example. */
  badge?: ReactNode;
}

/** How far an edge of the tab strip fades while there is more past it. */
const TAB_FADE = "2rem";

/**
 * The tabs under a page's title (Manage workspace, Your connections), inside
 * the page's `Tabs`. They scroll sideways on a phone instead of being cut off.
 * The active tab is scrolled into view, so a tab past the fold still shows,
 * and each edge fades while there are tabs past it. The line is an inset
 * shadow, so the active tab's bar sits on it, and the first tab starts on the
 * page's left edge.
 */
export function PageTabStrip<Value extends string>({
  label,
  tabs,
  activeTab,
}: {
  /** The accessible name of the tab list: the page's title. */
  label: string;
  tabs: readonly PageTab<Value>[];
  activeTab: Value;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(stripRef);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const active = strip?.querySelector<HTMLElement>(
      '[role="tab"][data-active]',
    );
    if (!strip || !active) return;
    strip.scrollLeft =
      active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
  }, [activeTab]);

  const mask =
    edges.before || edges.after
      ? `linear-gradient(to right, ${edges.before ? `transparent, black ${TAB_FADE}` : "black"}, ${edges.after ? `black calc(100% - ${TAB_FADE}), transparent` : "black"})`
      : undefined;

  return (
    <div
      ref={stripRef}
      className="scrollbar-hidden relative overflow-x-auto shadow-[inset_0_-1px_0_var(--border)]"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      <TabsList
        variant="line"
        className="gap-6 p-0 group-data-horizontal/tabs:h-10"
        aria-label={label}
      >
        {tabs.map(({ value, label: tabLabel, icon: Icon, badge }) => (
          <TabsTrigger
            key={value}
            value={value}
            className="h-full gap-2 rounded-none border-0 px-0 group-data-horizontal/tabs:after:bottom-0"
          >
            <Icon className="size-4" aria-hidden />
            {tabLabel}
            {badge}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}
