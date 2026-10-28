import { describe, expect, it } from "vitest";
import { gatewayOrigin, isLoopbackGateway } from "./index";

describe("the linked dev Gateway URL", () => {
  it("is https, or http on this machine alone", () => {
    expect(gatewayOrigin("https://apps.example.com/some/path")).toBe("https://apps.example.com");
    expect(gatewayOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(gatewayOrigin("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    for (const bad of ["http://gateway.lan", "http://apps.example.com", "ftp://apps.example.com", "apps.example.com"]) {
      expect(() => gatewayOrigin(bad), bad).toThrow(expect.objectContaining({ code: "INVALID_GATEWAY_URL" }));
    }
    expect(isLoopbackGateway("http://localhost:3000")).toBe(true);
    expect(isLoopbackGateway("https://apps.example.com")).toBe(false);
  });
});
