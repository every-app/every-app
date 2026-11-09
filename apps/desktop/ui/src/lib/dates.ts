/** Group items by local calendar day, keeping their order. */
export function groupByDay<T>(
  items: T[],
  dateOf: (item: T) => string,
): { day: string; date: Date; items: T[] }[] {
  const groups: { day: string; date: Date; items: T[] }[] = [];
  for (const item of items) {
    const date = new Date(dateOf(item));
    const day = date.toDateString();
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, date, items: [item] });
  }
  return groups;
}

/** "Today", "Yesterday", "Tomorrow", else "Thu, Oct 29" (with the year if not this one). */
export function dayLabel(date: Date, now = new Date()): string {
  const days = Math.round(
    (startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  if (days === 1) return "Tomorrow";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
