import { z } from "zod";
import { formatCount } from "@/client/lib/usage";

// The same range the server enforces (AppCapService).
export const CAP_MIN = 1;
export const CAP_MAX = 1_000_000_000;

/** The number field of both cap dialogs: a whole number of calls in range. */
export const capFieldSchema = z
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
