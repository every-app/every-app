import { describe, expect, it } from "vitest";
import { sameInstallation } from "./installation";

describe("sameInstallation", () => {
  it("lets a loopback redirect change its port", () => {
    expect(
      sameInstallation(
        "http://localhost:51001/callback",
        "http://localhost:51999/callback",
      ),
    ).toBe(true);
    expect(
      sameInstallation("http://127.0.0.1:1/cb?x=1", "http://127.0.0.1/cb?x=1"),
    ).toBe(true);
    expect(
      sameInstallation("http://[::1]:8080/cb", "http://[::1]:9090/cb"),
    ).toBe(true);
  });

  it("holds a loopback redirect's scheme, host, path and query", () => {
    for (const other of [
      "http://127.0.0.1:51999/callback",
      "http://localhost:51999/other",
      "http://localhost:51999/callback?x=1",
      "https://localhost:51999/callback",
    ]) {
      expect(
        sameInstallation("http://localhost:51001/callback", other),
        other,
      ).toBe(false);
    }
  });

  it("compares any other redirect exactly", () => {
    expect(
      sameInstallation(
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.ai/api/mcp/auth_callback",
      ),
    ).toBe(true);
    for (const other of [
      "https://claude.ai:8443/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback/",
      "http://localhost/api/mcp/auth_callback",
    ]) {
      expect(
        sameInstallation("https://claude.ai/api/mcp/auth_callback", other),
        other,
      ).toBe(false);
    }
    expect(sameInstallation("not a url", "http://localhost/cb")).toBe(false);
  });
});
