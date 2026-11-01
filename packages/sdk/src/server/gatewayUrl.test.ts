import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../internal/index.js";
import { gatewayUrl } from "./gatewayUrl.js";

describe("gatewayUrl", () => {
  it("is the Gateway's origin, with a path on it", () => {
    const env = { GATEWAY_URL: "https://everyapp.example.com" };
    expect(gatewayUrl(env)).toBe("https://everyapp.example.com/");
    expect(gatewayUrl(env, "/admin/users")).toBe(
      "https://everyapp.example.com/admin/users",
    );
  });

  it("reads the local launcher everyapp dev sets", () => {
    expect(gatewayUrl({ GATEWAY_URL: "http://localhost:8787" })).toBe(
      "http://localhost:8787/",
    );
  });

  it("drops anything on GATEWAY_URL past its origin", () => {
    expect(
      gatewayUrl({ GATEWAY_URL: "https://everyapp.example.com/x?y" }, "/z"),
    ).toBe("https://everyapp.example.com/z");
  });

  it("throws when nothing set it, or it isn't an http(s) URL", () => {
    expect(() => gatewayUrl({})).toThrow(ConfigurationError);
    expect(() => gatewayUrl({ GATEWAY_URL: "javascript:alert(1)" })).toThrow(
      /not an http\(s\) URL/,
    );
    expect(() => gatewayUrl({ GATEWAY_URL: "not a url" })).toThrow(
      ConfigurationError,
    );
  });
});
