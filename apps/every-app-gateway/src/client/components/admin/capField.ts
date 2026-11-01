import { z } from "zod";
import { formatCount } from "@/client/lib/usage";

// The same range the server enforces (AppCapService).
export const CAP_MIN = 1;
export const CAP_MAX = 1_000_000_000;
export const COST_CAP_MIN_USD = 0.01;
export const COST_CAP_MAX_USD = 1_000_000;

/** The number field of both cap dialogs: a whole number of calls in range. */
const capFieldSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, "Enter a whole number of calls.")
  .refine(
    (value) => {
      const cap = Number(value);
      return cap >= CAP_MIN && cap <= CAP_MAX;
    },
    `Enter a number from ${CAP_MIN} to ${formatCount(CAP_MAX)}.`,
  );

/** The dollars field of both cap dialogs: dollars and cents in range. */
const costCapFieldSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "Enter dollars, with at most two decimals.")
  .refine(
    (value) => {
      const usd = Number(value);
      return usd >= COST_CAP_MIN_USD && usd <= COST_CAP_MAX_USD;
    },
    `Enter an amount from $${COST_CAP_MIN_USD} to $${formatCount(COST_CAP_MAX_USD)}.`,
  );

/**
 * What the dollars field says under it in both dialogs: which calls move
 * a dollar cap at all.
 */
export const COST_CAP_HELP =
  "Counted only where the provider reports a price: OpenRouter, DataForSEO. Other calls count toward the call cap alone.";

/** A stored dollar cap (micro-dollars) as the field shows it: "20", "12.5". */
export function costCapFieldValue(micros: number | null): string {
  return micros === null ? "" : String(Math.round(micros / 10_000) / 100);
}

/** A field's value as the server takes it: blank is null. */
export const fieldNumber = (value: string): number | null =>
  value.trim() === "" ? null : Number(value.trim());

/**
 * Both cap fields of a dialog checked together: at least one filled
 * (`requireOne`), each filled one in range. Issues go on the field.
 */
export function checkCapFields(
  value: { cap: string; costUsd: string },
  ctx: z.RefinementCtx,
): void {
  const cap = value.cap.trim();
  const costUsd = value.costUsd.trim();
  if (cap === "" && costUsd === "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cap"],
      message: "Enter a number of calls, dollars, or both.",
    });
    return;
  }
  for (const [path, schema, field] of [
    ["cap", capFieldSchema, cap],
    ["costUsd", costCapFieldSchema, costUsd],
  ] as const) {
    if (field === "") continue;
    const result = schema.safeParse(field);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: result.error.issues[0]?.message ?? "Enter a number.",
      });
    }
  }
}
