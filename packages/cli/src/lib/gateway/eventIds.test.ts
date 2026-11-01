/**
 * The bus's ids as the Gateway makes them: an event's sorts by time, a
 * subscription's and a delivery's are 24 hex characters after their prefix.
 */
import { describe, expect, it } from "vitest";
import { deliveryId, eventId, subscriptionId, ulid } from "./eventIds";

describe("the event bus's ids", () => {
  it("makes an event id of 26 uppercase Crockford characters that sorts by time", () => {
    const ids = [0, 1, 1_000, Date.parse("2026-10-25T09:00:00Z"), 2 ** 48 - 1].map((ms) => eventId(ms));
    for (const id of ids) expect(id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(ulid(0).slice(0, 10)).toBe("0000000000");
    expect(ulid(Date.parse("2026-10-25T09:00:00Z")).slice(0, 10)).toBe(ulid(Date.parse("2026-10-25T09:00:00Z")).slice(0, 10));
  });

  it("writes the time part as the Gateway does, so its ids and the Gateway's sort together", () => {
    const nine = Date.parse("2026-10-25T09:00:00Z");
    // The Gateway's newEventId (server/events/ids.ts) for these milliseconds.
    expect(ulid(nine).slice(0, 10)).toBe("01M5S4KHM0");
    // The Gateway's id a minute later sorts after the CLI's.
    const cli = eventId(nine);
    const gatewayMinuteLater = "evt_01M5S4NC700000000000000000";
    expect([gatewayMinuteLater, cli].sort()).toEqual([cli, gatewayMinuteLater]);
  });

  it("makes subscription and delivery ids of 24 hex characters, each new", () => {
    expect(subscriptionId()).toMatch(/^sub_[0-9a-f]{24}$/);
    expect(deliveryId()).toMatch(/^dlv_[0-9a-f]{24}$/);
    expect(new Set(Array.from({ length: 50 }, deliveryId)).size).toBe(50);
  });
});
