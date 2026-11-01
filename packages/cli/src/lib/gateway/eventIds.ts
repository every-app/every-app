/**
 * The ids of the event bus's rows (docs/design/2026-10-events-out.md,
 * sections 2 and 3), made the way the Gateway makes them, since the CLI
 * writes those rows itself under the Cloudflare login (ADR-0003): an
 * event's id sorts by time (`evt_` and a ULID: 10 Crockford base32
 * characters of milliseconds, then 16 of randomness, uppercase as the
 * Gateway's server/events/ids.ts writes them: one organization's events
 * come from both writers, and a lowercase id sorts after every uppercase
 * one), so a receiver and the delivery log can order events by id; a subscription's
 * and a delivery's id is only unique (`sub_`, `dlv_` and 24 hex
 * characters). The randomness is node:crypto's.
 */
import { randomBytes } from "node:crypto";

/** Crockford's base32 alphabet (no I, L, O or U), the Gateway's own. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** A ULID: the time (milliseconds, 48 bits) in 10 characters, then 80 random bits in 16. */
export function ulid(now = Date.now()): string {
  let time = "";
  let rest = Math.max(0, Math.floor(now));
  for (let index = 0; index < TIME_CHARS; index += 1) {
    time = CROCKFORD[rest % 32]! + time;
    rest = Math.floor(rest / 32);
  }
  // Five bits a character: each random byte's low five bits are uniform.
  const random = [...randomBytes(RANDOM_CHARS)].map((byte) => CROCKFORD[byte % 32]!).join("");
  return `${time}${random}`;
}

/** `evt_` and a ULID: an event's id. */
export const eventId = (now?: number): string => `evt_${ulid(now)}`;

/** `sub_` and 24 hex characters: a subscription's id. */
export const subscriptionId = (): string => `sub_${randomBytes(12).toString("hex")}`;

/** `dlv_` and 24 hex characters: a delivery's id, stable across its retries. */
export const deliveryId = (): string => `dlv_${randomBytes(12).toString("hex")}`;
