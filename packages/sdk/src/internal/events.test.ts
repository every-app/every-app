import { describe, expect, it } from "vitest";
import {
  APP_EVENT_DATA_MAX_BYTES,
  EVENT_DATA_MAX_DEPTH,
  EVENT_TYPES,
  appEventNameProblem,
  appEventType,
  checkEventData,
  eventPatternMatches,
  eventPatternProblem,
  eventSubscribed,
  eventTypeInfo,
  formatEventSignature,
  isAppOwnEventType,
  isPrivateEventTargetName,
  parseEventSignature,
} from "./events.js";

describe("the event catalogue", () => {
  it("lists each type once, lowercase and dotted, with a version and a description", () => {
    const names = EVENT_TYPES.map((info) => info.type);
    expect(new Set(names).size).toBe(names.length);
    for (const info of EVENT_TYPES) {
      expect(info.type).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
      expect(info.version).toBeGreaterThanOrEqual(1);
      expect(info.description.length).toBeGreaterThan(10);
      expect(
        info.type === "ping" || info.type.startsWith(`${info.group}.`),
      ).toBe(true);
    }
    expect(eventTypeInfo("member.joined")?.version).toBe(1);
    expect(eventTypeInfo("app.crm.invoice.paid")).toBeUndefined();
  });

  it("tells an app's own event from the gateway's app events", () => {
    expect(appEventType("crm", "invoice.paid")).toBe("app.crm.invoice.paid");
    expect(isAppOwnEventType("app.crm.invoice.paid")).toBe(true);
    expect(isAppOwnEventType("app.crm.done")).toBe(true);
    expect(isAppOwnEventType("app.installed")).toBe(false);
    expect(isAppOwnEventType("member.joined")).toBe(false);
  });
});

describe("subscription patterns", () => {
  it("matches exact types, prefixes and everything", () => {
    expect(eventPatternMatches("member.joined", "member.joined")).toBe(true);
    expect(eventPatternMatches("member.joined", "member.invited")).toBe(false);
    expect(eventPatternMatches("member.*", "member.invited")).toBe(true);
    expect(eventPatternMatches("member.*", "membership.x")).toBe(false);
    expect(eventPatternMatches("app.*", "app.installed")).toBe(true);
    expect(eventPatternMatches("app.*", "app.crm.invoice.paid")).toBe(true);
    expect(eventPatternMatches("app.crm.*", "app.crm.invoice.paid")).toBe(true);
    expect(eventPatternMatches("app.crm.*", "app.crmx.invoice.paid")).toBe(
      false,
    );
    expect(eventPatternMatches("*", "cap.reached")).toBe(true);
  });

  it("never sends a ping to an everything subscription", () => {
    expect(eventPatternMatches("*", "ping")).toBe(false);
    expect(eventPatternMatches("ping", "ping")).toBe(true);
    expect(eventSubscribed(["*", "member.*"], "ping")).toBe(false);
    expect(eventSubscribed(["cap.*"], "cap.warning")).toBe(true);
  });

  it("refuses a pattern that names nothing", () => {
    expect(eventPatternProblem("member.joined")).toBeNull();
    expect(eventPatternProblem("member.*")).toBeNull();
    expect(eventPatternProblem("*")).toBeNull();
    expect(eventPatternProblem("app.crm.*")).toBeNull();
    expect(eventPatternProblem("app.crm.invoice.paid")).toBeNull();
    expect(eventPatternProblem("member.left")).toMatch(/isn't an event type/);
    expect(eventPatternProblem("billing.*")).toMatch(/matches no event type/);
    expect(eventPatternProblem("Member.Joined")).toMatch(
      /isn't an event type or pattern/,
    );
    expect(eventPatternProblem("member.**")).toMatch(
      /isn't an event type or pattern/,
    );
    expect(eventPatternProblem("")).toMatch(/isn't an event type or pattern/);
  });
});

describe("an app's event name", () => {
  it("is lowercase, dotted and bounded", () => {
    expect(appEventNameProblem("invoice.paid")).toBeNull();
    expect(appEventNameProblem("todo_completed")).toBeNull();
    expect(appEventNameProblem("Invoice.Paid")).toMatch(/lowercase/);
    expect(appEventNameProblem("invoice..paid")).toMatch(/lowercase/);
    expect(appEventNameProblem(".paid")).toMatch(/lowercase/);
    expect(appEventNameProblem("")).toMatch(/required/);
    expect(appEventNameProblem(undefined)).toMatch(/required/);
    expect(appEventNameProblem("a".repeat(65))).toMatch(/at most 64/);
  });
});

describe("checkEventData", () => {
  it("takes a plain object within the size and depth", () => {
    expect(checkEventData({ invoiceId: "inv_42", total: 1200 })).toEqual({
      ok: true,
      bytes: 35,
    });
    expect(checkEventData({})).toEqual({ ok: true, bytes: 2 });
  });

  it("refuses anything but an object", () => {
    for (const value of [null, undefined, "x", 1, true, [1, 2]]) {
      expect(checkEventData(value)).toMatchObject({
        ok: false,
        code: "event_data_invalid",
      });
    }
  });

  it("refuses a payload past the size", () => {
    const check = checkEventData({
      note: "x".repeat(APP_EVENT_DATA_MAX_BYTES),
    });
    expect(check).toMatchObject({ ok: false, code: "event_data_too_large" });
    expect(
      checkEventData({ note: "x".repeat(16 * 1024) }, 32 * 1024),
    ).toMatchObject({
      ok: true,
    });
  });

  it("refuses a payload nested too deep", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < EVENT_DATA_MAX_DEPTH; level++) deep = { deep };
    expect(checkEventData(deep)).toMatchObject({
      ok: false,
      code: "event_data_invalid",
      message: expect.stringMatching(/nests at most/),
    });
  });

  it("refuses a key that reads like a credential, at any depth", () => {
    for (const key of [
      "secret",
      "clientSecret",
      "access_token",
      "Password",
      "passwd",
      "Authorization",
      "api_key",
      "apiKey",
      "x-api-key",
      "privateKey",
      "private_key",
      "credentials",
      "cookie",
      "sessionId",
    ]) {
      expect(checkEventData({ [key]: "x" }), key).toMatchObject({
        ok: false,
        code: "event_data_refused",
        key,
      });
    }
    expect(
      checkEventData({ invoice: { customer: { items: [{ token: "t" }] } } }),
    ).toMatchObject({
      ok: false,
      code: "event_data_refused",
      key: "token",
    });
    // A value that looks like a secret is the app's business; keys are the rule.
    expect(checkEventData({ note: "my password is hunter2" })).toMatchObject({
      ok: true,
    });
  });
});

describe("the signature header", () => {
  it("round-trips t and v1", () => {
    const header = formatEventSignature(1761350400, "ab".repeat(32));
    expect(header).toBe(`t=1761350400,v1=${"ab".repeat(32)}`);
    expect(parseEventSignature(header)).toEqual({
      timestamp: 1761350400,
      v1: ["ab".repeat(32)],
    });
  });

  it("takes several v1 values (a rotation) and refuses malformed headers", () => {
    expect(
      parseEventSignature(`t=1, v1=${"a".repeat(64)}, v1=${"B".repeat(64)}`),
    ).toEqual({ timestamp: 1, v1: ["a".repeat(64), "b".repeat(64)] });
    expect(parseEventSignature("")).toBeNull();
    expect(parseEventSignature(null)).toBeNull();
    expect(parseEventSignature("v1=abc")).toBeNull();
    expect(parseEventSignature("t=12")).toBeNull();
    expect(parseEventSignature(`t=x,v1=${"a".repeat(64)}`)).toBeNull();
  });
});

describe("isPrivateEventTargetName", () => {
  it("knows the local and private name classes, and a bare label", () => {
    for (const host of [
      "localhost",
      "box.localhost",
      "n8n.local",
      "a.localdomain",
      "hooks.internal",
      "box.intranet",
      "n8n.lan",
      "hooks.acme.corp",
      "x.private",
      "printer.home.arpa",
      "abc.onion",
      "n8n",
    ]) {
      expect(isPrivateEventTargetName(host), host).toBe(true);
    }
  });

  it("lets a public hostname through, even one that merely contains a suffix", () => {
    for (const host of [
      "hooks.example.com",
      "corp.example.com",
      "localhost.example.com",
      "lan.example.org",
      "my-internal-tools.example.com",
    ]) {
      expect(isPrivateEventTargetName(host), host).toBe(false);
    }
  });
});
