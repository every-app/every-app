import { describe, expect, it } from "vitest";
import {
  isOneLabelBelow,
  normalizeHostname,
  zoneCandidates,
} from "./hostnames";

describe("normalizeHostname", () => {
  it("takes a hostname out of a URL, lowercased, without a trailing dot", () => {
    expect(normalizeHostname("https://Apps.Example.com/sign-in?x=1")).toBe(
      "apps.example.com",
    );
    expect(normalizeHostname("apps.example.com.")).toBe("apps.example.com");
    expect(normalizeHostname(undefined)).toBeUndefined();
  });

  it("refuses what isn't a hostname with a dot in it", () => {
    for (const input of ["localhost", "apps..example.com", "-apps.example.com", "apps_example.com", ""]) {
      expect(() => normalizeHostname(input)).toThrow(/isn't a hostname/);
    }
  });
});

describe("isOneLabelBelow", () => {
  it("accepts exactly one label below the parent", () => {
    expect(isOneLabelBelow("todo.apps.example.com", "apps.example.com")).toBe(true);
    expect(isOneLabelBelow("todo-acme.apps.example.com", "apps.example.com")).toBe(true);
  });

  it("refuses the parent itself, deeper names and look-alikes", () => {
    for (const host of [
      "apps.example.com",
      "a.todo.apps.example.com",
      "todoapps.example.com",
      "todo.apps.example.com.evil.net",
      ".apps.example.com",
    ]) {
      expect(isOneLabelBelow(host, "apps.example.com"), host).toBe(false);
    }
  });
});

describe("zoneCandidates", () => {
  it("lists the name and its parents down to two labels, longest first", () => {
    expect(zoneCandidates("todo.apps.example.co.uk")).toEqual([
      "todo.apps.example.co.uk",
      "apps.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
    expect(zoneCandidates("example.com")).toEqual(["example.com"]);
  });
});
