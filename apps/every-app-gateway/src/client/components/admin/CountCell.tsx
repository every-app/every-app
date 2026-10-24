import { cn } from "cn";

/**
 * A count in a table cell that opens what it counts ("3 members", "0 apps"):
 * a button that reads as the muted text around it, with an underline on
 * hover and a ring on keyboard focus, so it is a label first and a way in
 * second. The noun is singular; the cell adds the "s". Give `aria-label`
 * the whole sentence when the row alone does not say what the count is of.
 */
export function CountCell({
  count,
  noun,
  onClick,
  "aria-label": ariaLabel,
  className,
}: {
  count: number;
  noun: string;
  onClick: () => void;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "-mx-1 rounded-sm px-1 text-sm text-muted-foreground tabular-nums underline-offset-4 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {count} {noun}
      {count === 1 ? "" : "s"}
    </button>
  );
}
