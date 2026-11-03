import { z } from "zod";
import { formatCount } from "@/client/lib/usage";

// The same range the server enforces (AppCapService).
export const COST_CAP_MIN_USD = 0.01;
export const COST_CAP_MAX_USD = 1_000_000;

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

/** What the dollars field says under it in both dialogs: which calls move a cap at all. */
export const COST_CAP_HELP =
  "Counted only where the provider reports a price: OpenRouter, DataForSEO. Other calls, such as OpenAI or Workers AI, aren't capped.";

/** A stored cap (micro-dollars) as the field shows it: "20", "12.5". */
export function costCapFieldValue(micros: number | null): string {
  return micros === null ? "" : String(Math.round(micros / 10_000) / 100);
}

/** The field's value as the server takes it: dollars. */
export const fieldDollars = (value: string): number => Number(value.trim());

/** The dollars field checked: filled, and in range. The issue goes on the field. */
export function checkCostCapField(
  value: { costUsd: string },
  ctx: z.RefinementCtx,
): void {
  const costUsd = value.costUsd.trim();
  const message =
    costUsd === ""
      ? "Enter dollars per month."
      : costCapFieldSchema.safeParse(costUsd).error?.issues[0]?.message;
  if (message) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["costUsd"], message });
  }
}
