import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { clientAddressKey } from "@/server/auth-rate-limit";

// Registrations count under the sign-in limits' address key.
describe("clientAddressKey", () => {
  it("counts an IPv4 address as is, also when mapped into IPv6", () => {
    expect(clientAddressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("counts an IPv6 address by its /64, however it is written", () => {
    const key = "2001:db8:aa:1::/64";
    for (const address of [
      "2001:db8:aa:1::1",
      "2001:0db8:00aa:0001:ffff:ffff:ffff:ffff",
      "2001:DB8:AA:1:1234::",
    ]) {
      expect(clientAddressKey(address), address).toBe(key);
    }
    expect(clientAddressKey("2001:db8::7")).toBe("2001:db8:0:0::/64");
    expect(clientAddressKey("::1")).toBe("0:0:0:0::/64");
  });
});
