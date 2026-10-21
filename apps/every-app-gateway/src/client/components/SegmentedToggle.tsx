import type { ReactNode } from "react";
import { cn } from "cn";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/client/components/ui/toggle-group";

/** `Compact` sits in a menu; `Toolbar` matches the other 40px controls on a row. */
export enum SegmentedToggleSize {
  Compact = "compact",
  Toolbar = "toolbar",
}

// The track has a 1px border and 2px padding, so an item is the track's
// height less 6px.
const ITEM_SIZE_CLASS: Record<SegmentedToggleSize, string> = {
  [SegmentedToggleSize.Compact]: "h-[22px]",
  [SegmentedToggleSize.Toolbar]: "h-[34px] min-w-[34px] px-2",
};

interface SegmentedToggleItem<T extends string> {
  value: T;
  icon: ReactNode;
  label: string;
}

/** A single-choice segmented control. Each item is a toggle with `aria-pressed`. */
export function SegmentedToggle<T extends string>({
  items,
  value,
  onChange,
  showLabels = false,
  size = SegmentedToggleSize.Compact,
}: {
  items: SegmentedToggleItem<T>[];
  value: T;
  onChange: (value: T) => void;
  showLabels?: boolean;
  size?: SegmentedToggleSize;
}) {
  return (
    <ToggleGroup
      size="sm"
      spacing={0.5}
      value={[value]}
      onValueChange={(next) => {
        // A press on the active item empties the group. Keep one item on.
        const picked = items.find((item) => item.value === next[0]);
        if (picked) onChange(picked.value);
      }}
      // A border (not an inset ring) keeps the padding clear, and the larger outer
      // radius keeps the pressed pill concentric with the track.
      className="rounded-lg border border-border bg-muted p-0.5 data-[size=sm]:rounded-lg"
    >
      {items.map((item) => (
        <ToggleGroupItem
          key={item.value}
          value={item.value}
          aria-label={showLabels ? undefined : item.label}
          title={item.label}
          className={cn(
            ITEM_SIZE_CLASS[size],
            "text-muted-foreground aria-pressed:bg-primary/15 aria-pressed:text-primary",
          )}
        >
          {item.icon}
          {showLabels && (
            // Trim the line box to cap height so the text centers optically
            // with the icon instead of riding high on the font's ascender.
            <span className="[text-box:trim-both_cap_alphabetic]">
              {item.label}
            </span>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
