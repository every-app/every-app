// The date cell every table uses: a day, with the full timestamp on hover.
// Give its column `cellClassName: "text-xs text-muted-foreground"`.

/** A day, or `fallback` for a missing date such as "never used". */
export function DateCell({
  value,
  fallback = "Never",
}: {
  value: Date | string | number | null | undefined;
  fallback?: string;
}) {
  if (value === null || value === undefined || value === "") {
    return <>{fallback}</>;
  }
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {date.toLocaleDateString()}
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
