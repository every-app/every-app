import { describe, it, expect } from "vitest";
import {
  resolveDevMode,
  baseHostLabelCount,
  checkMirrorBaseHost,
  classifyHost,
  DevModeError,
} from "./mode";

describe("resolveDevMode", () => {
  it("defaults to stub", () => {
    expect(resolveDevMode(undefined, undefined)).toBe("stub");
  });
  it("reads the env var when no flag", () => {
    expect(resolveDevMode(undefined, "mirror")).toBe("mirror");
  });
  it("flag wins over env", () => {
    expect(resolveDevMode("stub", "mirror")).toBe("stub");
    expect(resolveDevMode("mirror", "stub")).toBe("mirror");
  });
  it("is case-insensitive", () => {
    expect(resolveDevMode("MIRROR", undefined)).toBe("mirror");
  });
  it("throws on an unknown value", () => {
    expect(() => resolveDevMode("prod", undefined)).toThrow(DevModeError);
  });
});

describe("baseHostLabelCount", () => {
  it.each([
    ["localhost", 1],
    ["localhost:8787", 1],
    ["everyapp.localhost", 2],
    ["everyapp.localhost:8787", 2],
    ["fix-ui.everyapp.localhost", 3],
    ["example.com", 2],
    ["", 0],
  ])("%s -> %i", (host, count) => {
    expect(baseHostLabelCount(host)).toBe(count);
  });
});

describe("checkMirrorBaseHost", () => {
  it("passes a two-label base host", () => {
    expect(checkMirrorBaseHost("everyapp.localhost:8787")).toBeNull();
    expect(checkMirrorBaseHost("example.com")).toBeNull();
  });
  it("rejects a single-label base host with guidance", () => {
    const msg = checkMirrorBaseHost("localhost:8787");
    expect(msg).toContain("two-label base host");
    expect(msg).toContain("everyapp.localhost");
  });
});

describe("classifyHost", () => {
  const base = "everyapp.localhost";
  it("recognizes the base host itself as the launcher", () => {
    expect(classifyHost("everyapp.localhost", base)).toEqual({ kind: "launcher" });
    expect(classifyHost("everyapp.localhost:8787", base)).toEqual({ kind: "launcher" });
  });
  it("recognizes a single-label subdomain as an app", () => {
    expect(classifyHost("todo.everyapp.localhost:8787", base)).toEqual({
      kind: "app",
      appLabel: "todo",
    });
  });
  it("rejects a wrong base host", () => {
    expect(classifyHost("localhost:8787", base)).toEqual({ kind: "invalid" });
    expect(classifyHost("todo.example.com", base)).toEqual({ kind: "invalid" });
  });
  it("rejects a deeper nested host (not a direct subdomain)", () => {
    expect(classifyHost("a.b.everyapp.localhost", base)).toEqual({ kind: "invalid" });
  });
});
