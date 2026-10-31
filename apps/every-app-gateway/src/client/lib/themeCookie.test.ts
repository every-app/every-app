import { describe, expect, it } from "vitest";
import {
  readThemeCookie,
  readThemeCookieScript,
  themeCookieDomain,
  themeCookieString,
} from "./themeCookie";

describe("readThemeCookie", () => {
  it("reads the pick among other cookies", () => {
    expect(readThemeCookie("a=1; everyapp-theme=dark; b=2")).toBe("dark");
    expect(readThemeCookie("everyapp-theme=system")).toBe("system");
  });

  it("is null without the cookie, or with a value it doesn't know", () => {
    expect(readThemeCookie("")).toBeNull();
    expect(readThemeCookie("everyapp-theme=sepia")).toBeNull();
    expect(readThemeCookie("my-everyapp-theme=dark")).toBeNull();
  });

  it("agrees with the no-flash script", () => {
    const run = (cookie: string) =>
      new Function("document", `${readThemeCookieScript} return p;`)({
        cookie,
      });
    expect(run("a=1; everyapp-theme=light")).toBe("light");
    expect(run("my-everyapp-theme=dark")).toBeNull();
  });
});

describe("themeCookieDomain", () => {
  it("is the Gateway host on it and on its subdomains", () => {
    expect(themeCookieDomain("everyapp.team", "everyapp.team")).toBe(
      "everyapp.team",
    );
    expect(themeCookieDomain("crm.everyapp.team", "EveryApp.team")).toBe(
      "everyapp.team",
    );
    expect(themeCookieDomain("crm.localhost", "localhost")).toBe("localhost");
  });

  it("is null on any other host, or without a Gateway host", () => {
    expect(themeCookieDomain("crm.example.com", "everyapp.team")).toBeNull();
    expect(themeCookieDomain("noteveryapp.team", "everyapp.team")).toBeNull();
    expect(themeCookieDomain("crm.everyapp.team", null)).toBeNull();
  });
});

describe("themeCookieString", () => {
  it("shares the pick across the Gateway host for a year", () => {
    expect(themeCookieString("dark", "everyapp.team", true)).toBe(
      "everyapp-theme=dark; Domain=everyapp.team; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(themeCookieString("light", "everyapp.localhost", false)).toBe(
      "everyapp-theme=light; Domain=everyapp.localhost; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });

  it("leaves Domain off on a one-label host", () => {
    expect(themeCookieString("light", "localhost", false)).toBe(
      "everyapp-theme=light; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });
});
