/**
 * `everyapp events …`: the Gateway's event bus from a terminal
 * (docs/design/2026-10-events-out.md, section 8): an organization's
 * subscriptions (a signed webhook, or mail to its owners and admins), a test
 * ping, the delivery log and a redeliver, and the catalogue. Each handler
 * here is what the route map loads; the work is in the files beside it,
 * and the rows are written straight into the Gateway's D1 under the
 * Cloudflare login (lib/gateway/events.ts), which the Gateway reads on the
 * next event. Nothing is built, uploaded or deployed.
 */
import { runCommand } from "@/lib/output/run";
import { addEvents, type AddFlags } from "./add";
import { listDeliveriesOf, redeliverOne, type DeliveriesFlags } from "./deliveries";
import { listEvents, listTypes } from "./list";
import { removeEvents, setEnabled } from "./manage";
import { testEvents, type TestFlags } from "./ping";
import type { EventsFlags } from "./shared";

export async function add(flags: AddFlags, url?: string): Promise<void> {
  await runCommand(flags, (out) => addEvents({ flags, out }, url));
}

export async function list(flags: EventsFlags): Promise<void> {
  await runCommand(flags, (out) => listEvents({ flags, out }));
}

export async function remove(flags: EventsFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => removeEvents({ flags, out }, id));
}

export async function enable(flags: EventsFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => setEnabled({ flags, out }, id, true));
}

export async function disable(flags: EventsFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => setEnabled({ flags, out }, id, false));
}

export async function test(flags: TestFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => testEvents({ flags, out }, id));
}

export async function deliveries(flags: DeliveriesFlags, subscriptionId?: string): Promise<void> {
  await runCommand(flags, (out) => listDeliveriesOf({ flags, out }, subscriptionId));
}

export async function redeliverDelivery(flags: EventsFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => redeliverOne({ flags, out }, id));
}

export async function types(flags: { json?: boolean; verbose?: boolean }): Promise<void> {
  await runCommand(flags, async (out) => listTypes({ out }));
}
