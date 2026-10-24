import { describe, it, expect } from "vitest";
import {
  resolveDevMode,
  baseHostLabelCount,
  checkMirrorBaseHost,
  classifyHost,
  isBrowserRequest,
  isDevHost,
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

describe("isDevHost", () => {
  it.each([
    "localhost:8787",
    "my-app.localhost:8787",
    "todo.fix-ui.everyapp.localhost",
    "127.0.0.1:8787",
    "[::1]:8787",
    "192.168.1.5:8787",
  ])("takes %s, a name for this machine", (host) => {
    expect(isDevHost(host)).toBe(true);
  });

  it.each(["my-app.attacker.example:8787", "attacker.example", "", "   "])(
    "refuses %s: a DNS-rebinding page's own name pointed at 127.0.0.1",
    (host) => {
      expect(isDevHost(host)).toBe(false);
    },
  );

  it("takes the mirror base host and its apps, and nothing beside them", () => {
    expect(isDevHost("everyapp.localhost:8787", "everyapp.localhost")).toBe(true);
    expect(isDevHost("todo.dev.example:8787", "dev.example")).toBe(true);
    expect(isDevHost("dev.example", "dev.example")).toBe(true);
    expect(isDevHost("todo.other.example:8787", "dev.example")).toBe(false);
  });
});

describe("isBrowserRequest", () => {
  it("tells a page's POST from a terminal's by the headers only browsers send", () => {
    expect(isBrowserRequest({})).toBe(false);
    expect(isBrowserRequest({ origin: "https://attacker.example" })).toBe(true);
    expect(isBrowserRequest({ referer: "https://attacker.example/" })).toBe(true);
    expect(isBrowserRequest({ "sec-fetch-mode": "no-cors" })).toBe(true);
    expect(isBrowserRequest({ "sec-fetch-site": "cross-site" })).toBe(true);
  });
});
