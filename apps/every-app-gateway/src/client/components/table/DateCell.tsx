// The date cell every table uses: a day, with the full timestamp on hover.

/** The class of a date column, for its `cellClassName`. */
export const DATE_CELL = "whitespace-nowrap text-muted-foreground tabular-nums";

/**
 * A day, or `fallback` for a missing date such as "never used". `withTime`
 * adds the time of day, for a log where many rows share a day.
 */
export function DateCell({
  value,
  fallback = "Never",
  withTime = false,
}: {
  value: Date | string | number | null | undefined;
  fallback?: string;
  withTime?: boolean;
}) {
  if (value === null || value === undefined || value === "") {
    return <>{fallback}</>;
  }
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: withTime ? "short" : undefined,
      })}
    </time>
  );
}

/**
 * The sort key of a date column. `missing` places an empty date: 0 for "never
 * used" (oldest), Infinity for "never expires" (latest).
 */
export function dateSortValue(
  value: Date | string | number | null | undefined,
  missing: number,
): number {
  return value === null || value === undefined || value === ""
    ? missing
    : new Date(value).getTime();
}
