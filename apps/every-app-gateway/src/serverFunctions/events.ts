import { createServerFn } from "@tanstack/react-start";
import { EVENT_TYPES } from "@every-app/sdk/internal";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { EventSubscriptionService } from "@/server/events/subscriptions";
import {
  createEventSubscriptionSchema,
  eventSubscriptionActionSchema,
  listEventDeliveriesSchema,
  redeliverEventSchema,
  updateEventSubscriptionSchema,
} from "@/schemas/event-subscription";

// Events out (docs/design/2026-10-events-out.md) are an owner's or admin's
// to manage, like groups and app access: every function below is scoped
// to the acting organization by the middleware, and nothing lists a
// signing secret after the one answer that made it.

/** The organization's subscriptions, with each one's last delivery. */
export const listEventSubscriptions = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => EventSubscriptionService.list(context.org));

/** Add a webhook or email subscription; the generated secret comes back once. */
export const createEventSubscription = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => createEventSubscriptionSchema.parse(data))
  .handler(async ({ data, context }) =>
    EventSubscriptionService.add(context.org, data),
  );

export const updateEventSubscription = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => updateEventSubscriptionSchema.parse(data))
  .handler(async ({ data, context }) =>
    EventSubscriptionService.update(context.org, data.id, data),
  );

/** Remove a subscription; a built-in one is disabled instead. */
export const deleteEventSubscription = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => eventSubscriptionActionSchema.parse(data))
  .handler(async ({ data, context }) =>
    EventSubscriptionService.remove(context.org, data.id),
  );

/** Send a ping to one subscription and report the first attempt. */
export const testEventSubscription = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => eventSubscriptionActionSchema.parse(data))
  .handler(async ({ data, context }) =>
    EventSubscriptionService.test(context.org, data.id),
  );

/** A page of deliveries: one subscription's, or all with a status filter. */
export const listEventDeliveries = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => listEventDeliveriesSchema.parse(data ?? {}))
  .handler(async ({ data, context }) =>
    EventSubscriptionService.deliveries(context.org, data),
  );

/** Queue a failed or dead delivery again, and attempt it now. */
export const redeliverEvent = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => redeliverEventSchema.parse(data))
  .handler(async ({ data, context }) =>
    EventSubscriptionService.redeliver(context.org, data.deliveryId),
  );

/** The catalogue, for the Add dialog: type, version, description, group. */
export const listEventTypes = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async () => ({ types: [...EVENT_TYPES] }));
