/**
 * `everyapp events test <id>`: queue a `ping` for one subscription (the
 * rows the Gateway's own test writes: the event and its one delivery, due
 * now), then wait for the delivery row to settle, since the CLI never calls
 * a receiver itself: the Gateway's per-minute sweep sends it, signed like
 * every delivery. Up to 90 seconds; then EVENT_TEST_TIMEOUT, the ping left
 * queued. It says delivered (with the receiver's status code) or failed
 * (with the code or the error the Gateway kept), and a failed one stays
 * queued for its retries. `--no-wait` returns once it is queued.
 */
import chalk from "chalk";
import { EveryAppError } from "@/lib/errors";
import {
  deliveryState,
  operatorActor,
  findSubscription,
  queuePing,
  subscriptionDisabled,
  TEST_WAIT_MS,
  waitForDelivery,
  type Delivery,
  type DeliveryWait,
  type Subscription,
} from "@/lib/gateway/events";
import { CLI } from "@/lib/output/command";
import { plural } from "@/lib/output/text";
import { elapsed } from "@/lib/output/time";
import { connect, deliveryData, named, targetOf, type EventsFlags, type EventsOptions } from "./shared";

export interface TestFlags extends EventsFlags {
  "no-wait"?: boolean;
}

export type TestOptions = EventsOptions<TestFlags> & { wait?: DeliveryWait };

const STEP = "events.test";

/**
 * How an attempt went, after the target: what a webhook answered (the
 * status code, else the Gateway's error code and the answer's start), or,
 * for the email sink, whose stored code is the number of recipients mailed
 * and never an HTTP status, how many were mailed or the error.
 */
function outcomeOf(target: string, delivery: Delivery, sink: Subscription["sink"]): string {
  const error = delivery.lastError?.split("\n")[0]?.slice(0, 200);
  const code = delivery.lastStatusCode !== null && delivery.lastStatusCode > 0 ? delivery.lastStatusCode : null;
  if (sink === "email") {
    return `${target}, ${code !== null ? `${plural(code, "recipient")} mailed` : (error ?? "no answer")}`;
  }
  if (code !== null) return `${target} answered HTTP ${code}${error ? ` (${error})` : ""}`;
  return `${target} answered ${error ?? "no answer"}`;
}

export async function testEvents(options: TestOptions, id: string): Promise<void> {
  const { out, flags } = options;
  const { gateway, organization } = await connect(options);
  const subscription = await findSubscription(gateway.db, organization, id);
  if (!subscription.enabled) throw subscriptionDisabled(subscription, "a test");
  out.emit({ type: "step", step: STEP, status: "start", message: `Queuing a test event for ${named(subscription)}...` });
  const queued = await queuePing(gateway.db, {
    organizationId: organization.id,
    subscription,
    actor: operatorActor(gateway.deployer),
    now: options.now?.(),
  });
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: `Queued ping ${queued.eventId} as delivery ${queued.deliveryId}`,
    data: queued,
  });
  const target = targetOf(subscription);
  const deliveries = `${CLI} events deliveries ${subscription.id}`;
  if (flags["no-wait"]) {
    const message = `Queued a test event for ${named(subscription)}. The Gateway sends it to ${target} within a minute.`;
    out.emit({
      type: "done",
      message,
      display: [message, chalk.dim(`See how it went: ${deliveries}`)].join("\n"),
      data: { outcome: "queued", subscriptionId: subscription.id, ...queued, next: [{ command: deliveries, note: "how it went" }] },
    });
    return;
  }

  const now = options.now ?? Date.now;
  const began = now();
  out.emit({
    type: "step",
    step: "events.deliver",
    status: "start",
    message: "Waiting for the Gateway to send it (it sends queued events every minute)...",
  });
  const settled = await waitForDelivery(gateway.db, organization.id, queued.deliveryId, { now, ...options.wait });
  if (!settled) {
    const waited = elapsed(options.wait?.timeoutMs ?? TEST_WAIT_MS);
    throw new EveryAppError(
      "EVENT_TEST_TIMEOUT",
      `The Gateway hasn't sent the test event in ${waited}\nIt stays queued. The Gateway sends queued events every minute; one installed before events were added sends them hourly at best until it is updated.`,
      {
        fix: `if the Gateway is older than this CLI, update it (${CLI} update)`,
        rerun: deliveries,
        rerunNote: "shows whether it went since",
        data: { subscriptionId: subscription.id, ...queued },
      },
    );
  }
  const state = deliveryState(settled, now());
  const took = elapsed(now() - began);
  if (state === "delivered") {
    out.emit({ type: "step", step: "events.deliver", status: "ok", message: `Delivered in ${took}` });
    const message = `Delivered: ${outcomeOf(target, settled, subscription.sink)}.`;
    out.emit({
      type: "done",
      message,
      display: chalk.green(message),
      data: { outcome: "delivered", subscriptionId: subscription.id, delivery: deliveryData(settled, now()) },
    });
    return;
  }
  out.emit({ type: "step", step: "events.deliver", status: "fail", message: `Failed after ${took}` });
  const retrying = state === "failed";
  const message = `The test event wasn't delivered: ${outcomeOf(target, settled, subscription.sink)}.`;
  const note = retrying
    ? "The Gateway retries it (in a minute, then 5, 30, …). Fix the receiver, then send another test."
    : "It is dead: the Gateway won't try it again.";
  out.emit({
    type: "done",
    message: `${message} ${note}`,
    display: [chalk.yellow(message), chalk.dim(note)].join("\n"),
    data: {
      outcome: "failed",
      subscriptionId: subscription.id,
      delivery: deliveryData(settled, now()),
      next: [{ command: `${CLI} events test ${subscription.id}`, note: "once the receiver is fixed" }],
    },
  });
}
