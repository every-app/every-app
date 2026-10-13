import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({
    server: (handler: unknown) => ({ serverHandler: handler }),
  }),
}));

import { publicErrorMiddleware } from "./publicError";

type Handler = (input: { next: () => Promise<unknown> }) => Promise<unknown>;
const handler = (publicErrorMiddleware as unknown as { serverHandler: Handler })
  .serverHandler;

describe("publicErrorMiddleware", () => {
  it("hides an unexpected error and logs only its name, message and stack", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    // Like Better Auth's APIError: response headers ride on the error.
    const thrown = Object.assign(new Error("boom"), {
      headers: { "set-cookie": "session=secret-session-token" },
      body: { token: "reset-token-123" },
    });

    await expect(
      handler({ next: () => Promise.reject(thrown) }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    const output = consoleError.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("server_fn.unhandled_error");
    expect(output).toContain("boom");
    expect(output).not.toContain("secret-session-token");
    expect(output).not.toContain("reset-token-123");
    consoleError.mockRestore();
  });
});
