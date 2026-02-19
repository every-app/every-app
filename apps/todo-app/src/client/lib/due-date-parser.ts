import {
  findBestDateTokenMatch,
  type DateTokenMatch,
} from "@/client/lib/date-token-matcher";
import { WEEKDAY_ALIASES, WEEKDAYS } from "@/client/lib/date-token-constants";
import { formatDateKey, isValidDateKey } from "@/lib/date-key";

export interface DueDateExtractionResult {
  title: string;
  dueDate: string | null;
  matchedText: string | null;
}

export function extractDueDateFromInput(
  rawInput: string,
  now = new Date(),
): DueDateExtractionResult {
  const normalizedInput = rawInput.trim();
  if (!normalizedInput) {
    return { title: "", dueDate: null, matchedText: null };
  }

  const match = findBestDateTokenMatch(normalizedInput);
  if (match) {
    const dueDate = resolveDueDateFromToken(match, now);
    if (dueDate && dueDate.getTime() >= startOfDay(now).getTime()) {
      const cleanedTitle = stripMatchedText(
        normalizedInput,
        match.start,
        match.matchedText,
      );

      return {
        title: cleanedTitle,
        dueDate: formatDateKey(dueDate),
        matchedText: match.matchedText,
      };
    }
  }

  return {
    title: normalizedInput,
    dueDate: null,
    matchedText: null,
  };
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getNextWeekMonday(now: Date): Date {
  const today = startOfDay(now);
  const day = today.getDay();
  const daysUntilNextMonday = (8 - day) % 7 || 7;
  return addDays(today, daysUntilNextMonday);
}

function getUpcomingSaturday(now: Date): Date {
  const today = startOfDay(now);
  const day = today.getDay();
  const daysUntilSaturday = (6 - day + 7) % 7;
  return addDays(today, daysUntilSaturday);
}

function resolveDueDateFromToken(
  match: DateTokenMatch,
  now: Date,
): Date | null {
  switch (match.kind) {
    case "today":
      return startOfDay(now);
    case "tomorrow":
      return addDays(startOfDay(now), 1);
    case "nextWeek":
      return getNextWeekMonday(now);
    case "thisWeekend":
      return getUpcomingSaturday(now);
    case "weekdayOn":
    case "weekdayNext":
    case "weekday":
      return match.weekdayLabel
        ? getNextWeekday(now, match.weekdayLabel)
        : null;
    case "numericOn":
      if (!match.monthText || !match.dayText || !match.yearText) return null;
      return parseNumericDate(match.monthText, match.dayText, match.yearText);
    default:
      return null;
  }
}

function getNextWeekday(now: Date, weekdayLabel: string): Date | null {
  const normalizedWeekday = WEEKDAY_ALIASES[weekdayLabel.toLowerCase()];
  if (!normalizedWeekday) return null;

  const weekdayIndex = WEEKDAYS.indexOf(normalizedWeekday);
  if (weekdayIndex === -1) return null;

  const today = startOfDay(now);
  const day = today.getDay();
  const delta = (weekdayIndex - day + 7) % 7;
  const daysUntilTarget = delta === 0 ? 7 : delta;

  return addDays(today, daysUntilTarget);
}

function parseNumericDate(
  monthText: string,
  dayText: string,
  yearText: string,
) {
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const year = Number.parseInt(yearText, 10);

  if (
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(year) ||
    month < 1 ||
    month > 12
  ) {
    return null;
  }

  const fullYear = yearText.length === 2 ? 2000 + year : year;
  const date = new Date(fullYear, month - 1, day);

  if (
    date.getFullYear() !== fullYear ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function stripMatchedText(
  input: string,
  matchStart: number,
  matchedText: string,
): string {
  const matchEnd = matchStart + matchedText.length;
  const before = input.slice(0, matchStart).trim();
  const after = input.slice(matchEnd).trim();
  return `${before} ${after}`.trim().replace(/\s+/g, " ");
}

export function formatDueDateBadge(dueDate: string): string {
  const [year, month, day] = dueDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function isFutureDueDate(
  dueDate: string | null | undefined,
  now = new Date(),
): boolean {
  if (!dueDate) return false;
  if (!isValidDateKey(dueDate)) return false;
  return dueDate > formatDateKey(startOfDay(now));
}
