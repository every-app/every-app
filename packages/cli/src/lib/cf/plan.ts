/**
 * Whether the account subscribes to Workers Paid, from `cf accounts
 * subscriptions get`. Every App needs it, but the response's shape hasn't
 * been checked against a live account, so this only ever informs a
 * warning: "yes" when a live subscription names Workers Paid, else
 * "can't tell".
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

const ENDED = /cancel|expired|failed/i;

/** True on Workers Paid; null when it can't be told (Free, or unreadable). */
export async function hasWorkersPaid(cf: CfRunner): Promise<true | null> {
  let subscriptions;
  try {
    subscriptions = await runCfJson(
      cf,
      { plane: "account", args: ["accounts", "subscriptions", "get"] },
      SubscriptionsOutput,
    );
  } catch {
    return null;
  }
  const paid = subscriptions.some((subscription) => {
    const names = [
      subscription.rate_plan?.id,
      subscription.rate_plan?.public_name,
      subscription.product?.name,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      /workers/i.test(names) &&
      /paid|standard|bundled|unbound/i.test(names) &&
      !ENDED.test(subscription.state ?? "")
    );
  });
  return paid ? true : null;
}
