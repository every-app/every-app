import { WEEKDAY_TOKEN } from "@/client/lib/date-token-constants";

type DateTokenKind =
  | "today"
  | "tomorrow"
  | "nextWeek"
  | "thisWeekend"
  | "weekdayOn"
  | "weekdayNext"
  | "weekday"
  | "numericOn";

export interface DateTokenMatch {
  start: number;
  end: number;
  matchedText: string;
  kind: DateTokenKind;
  weekdayLabel?: string;
  monthText?: string;
  dayText?: string;
  yearText?: string;
}

const MATCHERS: Array<{
  kind: DateTokenKind;
  regex: RegExp;
  parse: (match: RegExpExecArray) => Omit<DateTokenMatch, "start" | "end">;
}> = [
  {
    kind: "today",
    regex: /\b(today)\b/gi,
    parse: (match) => ({ matchedText: match[1], kind: "today" }),
  },
  {
    kind: "tomorrow",
    regex: /\b(tom|tomorrow)\b/gi,
    parse: (match) => ({ matchedText: match[1], kind: "tomorrow" }),
  },
  {
    kind: "nextWeek",
    regex: /\b(next week)\b/gi,
    parse: (match) => ({ matchedText: match[1], kind: "nextWeek" }),
  },
  {
    kind: "thisWeekend",
    regex: /\b(this weekend)\b/gi,
    parse: (match) => ({ matchedText: match[1], kind: "thisWeekend" }),
  },
  {
    kind: "weekdayOn",
    regex: new RegExp(`\\b(on\\s+(${WEEKDAY_TOKEN}))\\b`, "gi"),
    parse: (match) => ({
      matchedText: match[1],
      kind: "weekdayOn",
      weekdayLabel: match[2],
    }),
  },
  {
    kind: "weekdayNext",
    regex: new RegExp(`\\b(next\\s+(${WEEKDAY_TOKEN}))\\b`, "gi"),
    parse: (match) => ({
      matchedText: match[1],
      kind: "weekdayNext",
      weekdayLabel: match[2],
    }),
  },
  {
    kind: "weekday",
    regex: new RegExp(`\\b(${WEEKDAY_TOKEN})\\b`, "gi"),
    parse: (match) => ({
      matchedText: match[1],
      kind: "weekday",
      weekdayLabel: match[1],
    }),
  },
  {
    kind: "numericOn",
    regex: /\b(on\s+(\d{1,2})-(\d{1,2})-(\d{2,4}))\b/gi,
    parse: (match) => ({
      matchedText: match[1],
      kind: "numericOn",
      monthText: match[2],
      dayText: match[3],
      yearText: match[4],
    }),
  },
];

export function findDateTokenMatches(input: string): DateTokenMatch[] {
  if (!input.trim()) return [];

  const candidates: Array<
    DateTokenMatch & { length: number; priorityIndex: number }
  > = [];

  MATCHERS.forEach((matcher, priorityIndex) => {
    matcher.regex.lastIndex = 0;
    let match: RegExpExecArray | null = matcher.regex.exec(input);

    while (match) {
      if (match[1]) {
        const matchedText = match[1];
        const start = match.index;
        const end = start + matchedText.length;
        const parsed = matcher.parse(match);

        candidates.push({
          ...parsed,
          start,
          end,
          length: matchedText.length,
          priorityIndex,
        });
      }

      match = matcher.regex.exec(input);
    }
  });

  const sorted = candidates.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    if (a.start !== b.start) return a.start - b.start;
    return a.priorityIndex - b.priorityIndex;
  });

  const accepted: DateTokenMatch[] = [];
  for (const candidate of sorted) {
    const overlaps = accepted.some(
      (existing) =>
        candidate.start < existing.end && candidate.end > existing.start,
    );
    if (!overlaps) {
      accepted.push(candidate);
    }
  }

  return accepted.sort((a, b) => a.start - b.start);
}

export function findBestDateTokenMatch(input: string): DateTokenMatch | null {
  const matches = findDateTokenMatches(input);
  if (matches.length === 0) return null;

  return matches.reduce((best, current) => {
    const bestLength = best.end - best.start;
    const currentLength = current.end - current.start;
    if (currentLength > bestLength) return current;
    if (currentLength < bestLength) return best;
    return current.start < best.start ? current : best;
  });
}
