import { describe, it, expect } from "vitest";
import {
  resolveDevMode,
  baseHostLabelCount,
  checkMirrorBaseHost,
  classifyHost,
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
  it("names the flag or the env var an unknown value came from", () => {
    expect(() => resolveDevMode("prod", undefined)).toThrow(
      '--mode must be stub or mirror, not "prod"\nstub signs you in as a seeded dev user; mirror uses real login through a local Gateway.',
    );
    expect(() => resolveDevMode(undefined, "prod")).toThrow(
      'EVERYAPP_DEV_MODE must be stub or mirror, not "prod"',
    );
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
    expect(() => checkMirrorBaseHost("everyapp.localhost:8787")).not.toThrow();
    expect(() => checkMirrorBaseHost("example.com")).not.toThrow();
  });
  it("rejects a single-label base host, suggesting a usable one", () => {
    const argv = process.argv;
    process.argv = [argv[0]!, argv[1]!, "dev", "--mode", "mirror", "--base-host", "localhost"];
    try {
      expect(() => checkMirrorBaseHost("localhost")).toThrow(
        expect.objectContaining({
          code: "MIRROR_BASE_HOST",
          message: expect.stringMatching(
            /^Mirror mode needs a two-label base host, like everyapp\.localhost\n/,
          ),
          rerun: "pnpm everyapp dev --mode mirror --base-host everyapp.localhost",
        }),
      );
    } finally {
      process.argv = argv;
    }
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
