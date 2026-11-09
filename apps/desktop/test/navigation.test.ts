import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { externalUrl, isAppUrl, navigationDecision, redirectAllowed, windowOpenDecision } from "../src/main/navigation";
import { validArgs } from "../src/main/ipcValidation";

const rendererFile = "/Applications/Every App.app/Contents/Resources/app.asar/out/renderer/index.html";
const page = pathToFileURL(rendererFile).toString();
const packaged = { rendererFile };
const dev = { rendererFile, devUrl: "http://localhost:5173/" };

describe("navigation guard", () => {
  it("allows only the app's own page when packaged", () => {
    expect(isAppUrl(page, packaged)).toBe(true);
    expect(isAppUrl(`${page}#/meetings/1`, packaged)).toBe(true);
    expect(isAppUrl(`${page}?x=1`, packaged)).toBe(true);
    expect(isAppUrl("file:///etc/passwd", packaged)).toBe(false);
    expect(isAppUrl(pathToFileURL(rendererFile.replace("index.html", "other.html")).toString(), packaged)).toBe(false);
    expect(isAppUrl("file:///Applications/Every App.app/Contents/Resources/app.asar/out/renderer/../renderer/index.html", packaged)).toBe(true);
    expect(isAppUrl("file://evil.example/Applications/Every App.app/Contents/Resources/app.asar/out/renderer/index.html", packaged)).toBe(false);
    expect(isAppUrl("http://localhost:5173/", packaged)).toBe(false);
    expect(isAppUrl("https://example.com/", packaged)).toBe(false);
    expect(isAppUrl("not a url", packaged)).toBe(false);
    expect(isAppUrl("", packaged)).toBe(false);
  });

  it("allows the floating recorder's page only when it's listed", () => {
    const pill = pathToFileURL(rendererFile.replace("index.html", "pill.html")).toString();
    expect(isAppUrl(pill, packaged)).toBe(false);
    const withPill = { rendererFile, otherPages: [rendererFile.replace("index.html", "pill.html")] };
    expect(isAppUrl(pill, withPill)).toBe(true);
    expect(isAppUrl(page, withPill)).toBe(true);
    expect(isAppUrl(pathToFileURL(rendererFile.replace("index.html", "other.html")).toString(), withPill)).toBe(false);
  });

  it("allows the dev server's origin in a dev run, and nothing near it", () => {
    expect(isAppUrl("http://localhost:5173/", dev)).toBe(true);
    expect(isAppUrl("http://localhost:5173/some/route", dev)).toBe(true);
    expect(isAppUrl("http://localhost:5174/", dev)).toBe(false);
    expect(isAppUrl("http://localhost:5173.evil.example/", dev)).toBe(false);
    expect(isAppUrl("http://localhost:5173@evil.example/", dev)).toBe(false);
    expect(isAppUrl("https://localhost:5173/", dev)).toBe(false);
  });

  it("sends https navigations to the browser and drops the rest", () => {
    expect(navigationDecision(page, packaged)).toEqual({ allow: true });
    expect(navigationDecision("https://talk.example.com/meetings/1", packaged)).toEqual({ allow: false, openExternal: "https://talk.example.com/meetings/1" });
    for (const url of ["http://example.com/", "file:///etc/passwd", "javascript:alert(1)", "everyapp://scribe/record", "data:text/html,hi", "x-apple.systempreferences:foo", "https://"]) {
      expect(navigationDecision(url, packaged), url).toEqual({ allow: false, openExternal: undefined });
    }
  });

  it("refuses redirects off the app's page, without opening them", () => {
    expect(redirectAllowed(page, packaged)).toBe(true);
    expect(redirectAllowed("https://example.com/", packaged)).toBe(false);
    expect(redirectAllowed("http://localhost:5173/x", dev)).toBe(true);
    expect(redirectAllowed("http://evil.example/", dev)).toBe(false);
  });

  it("opens only https links from window.open", () => {
    expect(windowOpenDecision("https://zoom.us/j/1")).toEqual({ openExternal: "https://zoom.us/j/1" });
    for (const url of ["http://zoom.us/j/1", "file:///Applications/Calculator.app", "smb://host/share", "javascript:1"]) {
      expect(windowOpenDecision(url).openExternal, url).toBeUndefined();
    }
    expect(externalUrl("HTTPS://Example.COM/a")).toBe("https://example.com/a");
  });
});

describe("IPC argument checks", () => {
  it("validates the settings and permission channels", () => {
    expect(validArgs("settings:get", [])).toBe(true);
    expect(validArgs("settings:get", [1])).toBe(false);
    expect(validArgs("settings:set", [{ theme: "dark" }])).toBe(true);
    expect(validArgs("settings:set", [{ theme: "neon" }])).toBe(false);
    expect(validArgs("settings:set", [{ theme: "dark" }, "extra"])).toBe(false);
    expect(validArgs("settings:set", [])).toBe(false);
    expect(validArgs("permissions:get", [])).toBe(true);
    for (const kind of ["mic", "systemAudio", "notifications"]) {
      expect(validArgs("permissions:request", [kind])).toBe(true);
      expect(validArgs("permissions:openSettings", [kind])).toBe(true);
    }
    expect(validArgs("permissions:request", ["camera"])).toBe(false);
    expect(validArgs("permissions:openSettings", ["x-apple.systempreferences:evil"])).toBe(false);
    expect(validArgs("helper:requestPermission", ["notifications"])).toBe(false);
    expect(validArgs("nope" as never, [])).toBe(false);
  });
});
