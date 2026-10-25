/** Formatting for the Admin, Usage view. */
import {
  CAPABILITIES,
  isCapabilityId,
  providerLabel,
} from "@every-app/sdk/internal";

const count = new Intl.NumberFormat("en-US");

/**
 * What a usage row's target is called: the registry's name for an AI
 * provider ("OpenRouter") or a capability ("DataForSEO"), the id itself
 * for one this gateway doesn't know.
 */
export function usageTargetLabel(kind: string, target: string): string {
  if (kind === "ai") return providerLabel(target);
  if (kind === "capability" && isCapabilityId(target)) {
    return CAPABILITIES[target].label;
  }
  return target;
}

/** A count with thousands separators: 1,240. */
export function formatCount(value: number): string {
  return count.format(value);
}

/**
 * A provider cost kept in USD millionths, as dollars: four decimals under
 * a dollar ($0.0025), two from there ($12.34), and a plain $0.00 for none.
 */
export function formatCostMicros(micros: number): string {
  if (micros === 0) return "$0.00";
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`;
}

/** How far into a monthly cap an app is: "1,240 of 5,000". */
export function formatCapProgress(calls: number, cap: number): string {
  return `${formatCount(calls)} of ${formatCount(cap)}`;
}

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** A dollar cap kept in USD millionths, in dollars and cents: "$1,250.00". */
export function formatCostCap(micros: number): string {
  return dollars.format(micros / 1_000_000);
}

/** How far into a monthly dollar cap an app is: "$4.20 of $20.00". */
export function formatCostCapProgress(micros: number, cap: number): string {
  return `${formatCostCap(micros)} of ${formatCostCap(cap)}`;
}

const MONTH = /^(\d{4})-(\d{2})$/;

/** "October 2026" for "2026-10". */
export function monthLabel(month: string): string {
  const match = MONTH.exec(month);
  if (!match) return month;
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, 1),
  ).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** This UTC month and the 11 before it, newest first. */
export function monthOptions(
  now = new Date(),
): { value: string; label: string }[] {
  const year = now.getUTCFullYear();
  const index = now.getUTCMonth();
  return Array.from({ length: 12 }, (_, back) => {
    const value = new Date(Date.UTC(year, index - back, 1))
      .toISOString()
      .slice(0, 7);
    return { value, label: monthLabel(value) };
  });
}
