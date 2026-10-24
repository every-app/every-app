/**
 * Which Workers plan the account is on, from `cf accounts subscriptions
 * get`. Every App needs Workers Paid. Only an answer that names the plan
 * counts: a live subscription naming Workers Paid, or one naming Workers
 * Free. Anything else is "can't tell", or "unreadable" when cf couldn't
 * answer at all (setup has run live on this; a Paid account reads as Paid).
 */
import { z } from "zod";
import { runCfJson, type CfRunner } from "./runner";

const SubscriptionsOutput = z.array(
  z.looseObject({
    state: z.string().nullish(),
    rate_plan: z
      .looseObject({
        id: z.string().nullish(),
        public_name: z.string().nullish(),
      })
      .nullish(),
    product: z.looseObject({ name: z.string().nullish() }).nullish(),
  }),
);

export enum WorkersPlan {
  Paid = "paid",
  Free = "free",
  /** The subscriptions say neither. */
  Unknown = "unknown",
  /** cf couldn't list them (a token without the permission, say). */
  Unreadable = "unreadable",
}

const ENDED = /cancel|expired|failed/i;

export async function workersPlan(cf: CfRunner): Promise<WorkersPlan> {
  let subscriptions;
  try {
    subscriptions = await runCfJson(
      cf,
      { plane: "account", args: ["accounts", "subscriptions", "get"] },
      SubscriptionsOutput,
    );
  } catch {
    return WorkersPlan.Unreadable;
  }
  const workers = subscriptions
    .filter((subscription) => !ENDED.test(subscription.state ?? ""))
    .map((subscription) =>
      [
        subscription.rate_plan?.id,
        subscription.rate_plan?.public_name,
        subscription.product?.name,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .filter((names) => /workers/i.test(names));
  if (workers.some((names) => /paid|standard|bundled|unbound/i.test(names))) {
    return WorkersPlan.Paid;
  }
  if (workers.some((names) => /free/i.test(names))) return WorkersPlan.Free;
  return WorkersPlan.Unknown;
}
