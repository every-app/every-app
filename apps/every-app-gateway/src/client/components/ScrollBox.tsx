import { useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { useScrollOverflow } from "@/client/hooks/useScrollOverflow";

/**
 * A bordered scroll box that says when it hides something: a fade at the
 * edge with more past it, and "N more below" while rows sit under the
 * fold. Both come from the real scroll state (never a static mask), so a
 * list that ends exactly at the edge still shows a cue, and one that fits
 * shows none. Rows are the `li` elements inside.
 */
export function ScrollBox({
  className,
  children,
  /** What changes the rows: the box measures again when it changes. */
  deps = [],
}: {
  className?: string;
  children: ReactNode;
  deps?: readonly unknown[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { canScrollUp, canScrollDown, hiddenBelow } = useScrollOverflow(
    ref,
    deps,
  );

  return (
    // min-w-0: a grid or flex item, so the rows truncate instead of widening
    // the dialog.
    <div className="relative min-w-0">
      <div
        ref={ref}
        data-slot="scroll-box"
        className={cn(
          "relative overflow-y-auto overscroll-contain rounded-lg border border-border",
          className,
        )}
      >
        {children}
      </div>
      {canScrollUp ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-px top-px h-8 rounded-t-lg bg-linear-to-b from-background to-transparent"
        />
      ) : null}
      {canScrollDown ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-px bottom-px flex h-14 items-end justify-center rounded-b-lg bg-linear-to-t from-background via-background/80 to-transparent pb-1.5"
        >
          {hiddenBelow > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
              {hiddenBelow} more below
              <ChevronDown className="size-3" />
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
