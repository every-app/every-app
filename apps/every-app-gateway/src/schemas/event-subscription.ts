import { z } from "zod";
import {
  EVENT_EMAIL_RECIPIENTS,
  EVENT_SECRET_MAX_LENGTH,
  EVENT_SUBSCRIPTION_NAME_MAX,
  EVENT_URL_MAX_LENGTH,
} from "@every-app/sdk/internal";
import {
  DELIVERY_ID_PATTERN,
  SUBSCRIPTION_ID_PATTERN,
} from "@/server/events/ids";

/** What the server functions take for event subscriptions; the service checks the rest. */

const subscriptionIdSchema = z
  .string()
  .regex(SUBSCRIPTION_ID_PATTERN, "Invalid subscription");

const deliveryIdSchema = z
  .string()
  .regex(DELIVERY_ID_PATTERN, "Invalid delivery");

const patternsSchema = z
  .array(z.string().trim().min(1).max(80))
  .max(50, "At most 50 event patterns");

export const createEventSubscriptionSchema = z.object({
  url: z.string().trim().max(EVENT_URL_MAX_LENGTH).optional(),
  email: z.enum(EVENT_EMAIL_RECIPIENTS).optional(),
  events: patternsSchema.optional(),
  name: z.string().max(EVENT_SUBSCRIPTION_NAME_MAX).optional(),
  secret: z.string().max(EVENT_SECRET_MAX_LENGTH).optional(),
  description: z.string().max(500).optional(),
});

export const updateEventSubscriptionSchema = z.object({
  id: subscriptionIdSchema,
  enabled: z.boolean().optional(),
  events: patternsSchema.optional(),
  name: z.string().max(EVENT_SUBSCRIPTION_NAME_MAX).optional(),
  description: z.string().max(500).nullable().optional(),
});

export const eventSubscriptionActionSchema = z.object({
  id: subscriptionIdSchema,
});

export const listEventDeliveriesSchema = z.object({
  subscriptionId: subscriptionIdSchema.optional(),
  status: z.enum(["pending", "delivered", "dead"]).optional(),
  before: z.string().max(80).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const redeliverEventSchema = z.object({ deliveryId: deliveryIdSchema });
