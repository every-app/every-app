/**
 * How the Events tab says things: a webhook's target is its host and path
 * and never its query, a pending delivery that failed reads Failed, an
 * error code reads in plain words with the receiver's answer beside it,
 * the payload is the envelope a receiver got, and the catalogue groups by
 * prefix without the test ping.
 */
import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@every-app/sdk/internal";
import {
  deliveryState,
  describeDeliveryError,
  eventEnvelope,
  groupEventTypes,
  parsePatterns,
  patternsProblem,
  splitPatterns,
  subscriptionTarget,
} from "./events";

describe("a subscription's target", () => {
  it("is a webhook URL's host and path, without its query or the https scheme", () => {
    expect(
      subscriptionTarget({
        sink: "webhook",
        url: "https://hooks.example.com/everyapp?token=abc#x",
        recipients: null,
      }),
    ).toBe("hooks.example.com/everyapp");
    expect(
      subscriptionTarget({
        sink: "webhook",
        url: "http://n8n.internal.example:5678/",
        recipients: null,
      }),
    ).toBe("http://n8n.internal.example:5678");
  });

  it("says whom the email sink mails", () => {
    expect(
      subscriptionTarget({ sink: "email", url: null, recipients: "admins" }),
    ).toBe("Email → owners and admins");
    expect(
      subscriptionTarget({ sink: "email", url: null, recipients: "owners" }),
    ).toBe("Email → owners");
  });
});

describe("a delivery's state", () => {
  it("is Failed for a pending delivery that has an error, Queued before its first attempt", () => {
    expect(
      deliveryState({ status: "pending", attempts: 2, lastError: "timeout" }),
    ).toBe("failed");
    expect(
      deliveryState({ status: "pending", attempts: 0, lastError: null }),
    ).toBe("pending");
    // Redeliver starts the count over; until it is attempted it is queued.
    expect(
      deliveryState({ status: "pending", attempts: 0, lastError: "timeout" }),
    ).toBe("pending");
    expect(
      deliveryState({ status: "dead", attempts: 7, lastError: "status_500" }),
    ).toBe("dead");
  });
});

describe("a delivery's last error", () => {
  it("reads an HTTP status and keeps the receiver's answer beside it", () => {
    expect(describeDeliveryError("status_500: upstream down")).toEqual({
      label: "HTTP 500",
      detail: "upstream down",
    });
  });

  it("says to set EMAIL_FROM when the Gateway can't send mail", () => {
    expect(describeDeliveryError("email_not_configured").label).toContain(
      "EMAIL_FROM",
    );
  });

  it("names a refused target's reason in words", () => {
    expect(describeDeliveryError("target_refused: private_host")).toEqual({
      label: "The Gateway refuses this URL now",
      detail: "private host",
    });
  });
});

describe("the payload", () => {
  it("is the envelope: the stored event with the Gateway and the organization", () => {
    const envelope = eventEnvelope(
      {
        id: "evt_01M5S4KHM0WG4B9YKWMCYDPHVZ",
        type: "member.joined",
        version: 1,
        summary: "jo@acme.com joined as member",
        time: "2026-10-25T09:15:03.412Z",
        actor: { kind: "user", id: "usr_1" },
        data: { role: "member" },
        appRowId: null,
      },
      {
        gateway: "https://apps.acme.com",
        organization: { id: "org_1", slug: "acme", name: "Acme" },
      },
    );
    expect(Object.keys(envelope)).toEqual([
      "id",
      "type",
      "version",
      "summary",
      "time",
      "gateway",
      "organization",
      "actor",
      "data",
    ]);
    expect(envelope.organization).toEqual({
      id: "org_1",
      slug: "acme",
      name: "Acme",
    });
  });
});

describe("the catalogue for the Add dialog", () => {
  const groups = groupEventTypes(EVENT_TYPES);

  it("groups the types by prefix and leaves the test ping out", () => {
    expect(groups.map((group) => group.pattern)).toContain("member.*");
    expect(
      groups.flatMap((group) => group.types).map((info) => info.type),
    ).not.toContain("ping");
    expect(groups.find((group) => group.group === "member")?.types.length).toBe(
      EVENT_TYPES.filter((info) => info.group === "member").length,
    );
  });

  it("splits a subscription's patterns into checkboxes and typed patterns", () => {
    expect(splitPatterns(["*"], groups)).toEqual({
      everything: true,
      selected: [],
      custom: [],
    });
    expect(
      splitPatterns(["member.*", "cap.reached", "app.crm.*"], groups),
    ).toEqual({
      everything: false,
      selected: ["member.*", "cap.reached"],
      custom: ["app.crm.*"],
    });
  });

  it("reads typed patterns by commas or spaces and checks them by the server's rule", () => {
    expect(
      parsePatterns("app.crm.*, app.notes.invoice.paid  app.crm.*"),
    ).toEqual(["app.crm.*", "app.notes.invoice.paid"]);
    expect(patternsProblem(["app.crm.*"])).toBeNull();
    expect(patternsProblem(["Not A Pattern"])).toContain("isn't an event type");
  });
});
