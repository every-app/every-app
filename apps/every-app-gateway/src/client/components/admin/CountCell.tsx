import { cn } from "cn";

type CountCellProps = {
  count: number;
  /** Singular; an "s" is added unless the count is 1. */
  noun: string;
  onClick: () => void;
  /** What opens, appended after the count: "3 users. Manage access to Notes". */
  "aria-label": string;
  className?: string;
};

/**
 * "3 users": a count that opens the list it counts. Muted text with a hover
 * underline rather than a ghost button, so a column of counts (or of zeros)
 * does not read as a column of labels; no verb at any count, since the
 * dialog it opens says what can be done. For the Apps and Groups tables.
 *
 * The accessible name is the visible text first, then what opens, so a
 * screen reader hears the column's value and voice control can say what it
 * sees (WCAG 2.5.3): an `aria-label` alone would replace the count.
 */
export function CountCell({
  count,
  noun,
  onClick,
  "aria-label": ariaLabel,
  className,
}: CountCellProps) {
  const text = `${count} ${noun}${count === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      aria-label={`${text}. ${ariaLabel}`}
      aria-haspopup="dialog"
      onClick={onClick}
      className={cn(
        "-mx-1 rounded-sm px-1 text-sm text-muted-foreground tabular-nums underline-offset-4 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      {text}
    </button>
  );
}
