import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent, redactLogFields, REDACTED } from "./log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redactLogFields", () => {
  it("never logs credential headers or token, secret, password or code keys", () => {
    expect(
      redactLogFields({
        cookie: "session=abc",
        Authorization: "Bearer epat_x",
        "set-cookie": "a=b",
        accessToken: "t",
        client_secret: "s",
        newPassword: "p",
        code: "c",
        app: "todo",
        status: 200,
      }),
    ).toEqual({
      cookie: REDACTED,
      Authorization: REDACTED,
      "set-cookie": REDACTED,
      accessToken: REDACTED,
      client_secret: REDACTED,
      newPassword: REDACTED,
      code: REDACTED,
      app: "todo",
      status: 200,
    });
  });

  it("redacts nested values and arrays", () => {
    expect(
      redactLogFields({
        headers: { cookie: "x", accept: "*/*" },
        list: [{ token: "t", id: 1 }],
      }),
    ).toEqual({
      headers: { cookie: REDACTED, accept: "*/*" },
      list: [{ token: REDACTED, id: 1 }],
    });
  });
});

describe("logEvent", () => {
  it("writes one redacted JSON line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvent("proxy", { app: "todo", authorization: "Bearer x" });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      evt: "proxy",
      app: "todo",
      authorization: REDACTED,
    });
  });
});
