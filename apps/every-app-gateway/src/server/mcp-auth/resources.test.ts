import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: () => undefined }));
vi.mock("@/db", () => ({ db: {} }));

import {
  appResourceHostname,
  appResourceOrigin,
  isResourceHostname,
} from "./resources";

describe("app resources", () => {
  it("names an app host's origin on the issuer's scheme, lowercased", () => {
    expect(appResourceOrigin("Todo-Acme.Example.com")).toBe(
      "https://todo-acme.example.com",
    );
    expect(appResourceOrigin("todo.localhost", "http:")).toBe(
      "http://todo.localhost",
    );
  });

  it("reads back exactly an origin, nothing more", () => {
    expect(appResourceHostname("https://todo.example.com")).toBe(
      "todo.example.com",
    );
    expect(appResourceHostname("https://todo.example.com/")).toBe(
      "todo.example.com",
    );
    for (const resource of [
      "https://todo.example.com/mcp",
      "https://todo.example.com:8443",
      "https://todo.example.com?x=1",
      "https://u:p@todo.example.com",
      "http://todo.example.com",
      "https://todo.example.com#f",
      "not a url",
    ]) {
      expect(appResourceHostname(resource), resource).toBeNull();
    }
    expect(appResourceHostname("http://localhost", "http:")).toBe("localhost");
  });

  it("takes https anywhere and http on a loopback host only, as the library does", () => {
    expect(isResourceHostname("openseo.apps.example.com", "https:")).toBe(true);
    expect(isResourceHostname("openseo.apps.example.com", "http:")).toBe(false);
    expect(isResourceHostname("localhost", "http:")).toBe(true);
    expect(isResourceHostname("127.0.0.1", "http:")).toBe(true);
    expect(isResourceHostname("[::1]", "http:")).toBe(true);
    expect(isResourceHostname("todo.localhost", "http:")).toBe(false);
    expect(isResourceHostname("bad host", "https:")).toBe(false);
  });
});
