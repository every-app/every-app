import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkGatewayHasOwner,
  GatewayUnreachableError,
} from "./gateway";

describe("checkGatewayHasOwner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns false from a successful { hasOwner: false } response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json({ hasOwner: false })),
    );

    await expect(
      checkGatewayHasOwner("https://gateway.example.com"),
    ).resolves.toBe(false);
  });

  it("throws GatewayUnreachableError for a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ error: "not ready" }, { status: 500 }),
      ),
    );

    await expect(
      checkGatewayHasOwner("https://gateway.example.com"),
    ).rejects.toBeInstanceOf(GatewayUnreachableError);
  });

  it("throws GatewayUnreachableError for a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("network unavailable");
      }),
    );

    await expect(
      checkGatewayHasOwner("https://gateway.example.com"),
    ).rejects.toMatchObject({
      url: "https://gateway.example.com",
      message: expect.stringContaining(
        "Could not reach your Gateway at https://gateway.example.com",
      ),
    });
  });
});
