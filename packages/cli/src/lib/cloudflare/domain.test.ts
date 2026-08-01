import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvesThroughCloudflare } from "./domain";

describe("resolvesThroughCloudflare", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns true when Cloudflare DoH returns a successful A answer", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ Status: 0, Answer: [{ name: "todo.example.com" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolvesThroughCloudflare("todo.example.com")).resolves.toBe(
      true,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://cloudflare-dns.com/dns-query?name=todo.example.com&type=A",
    );
    expect(init).toMatchObject({
      headers: {
        accept: "application/dns-json",
      },
    });
  });

  it("returns false when Cloudflare DoH has no answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ Status: 0, Answer: [] })),
    );

    await expect(resolvesThroughCloudflare("todo.example.com")).resolves.toBe(
      false,
    );
  });

  it("returns false when Cloudflare DoH reports an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ Status: 3, Answer: [{ name: "todo.example.com" }] }),
      ),
    );

    await expect(resolvesThroughCloudflare("todo.example.com")).resolves.toBe(
      false,
    );
  });

  it("fails closed when the Cloudflare DoH request cannot be made", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("network unavailable");
      }),
    );

    await expect(resolvesThroughCloudflare("todo.example.com")).resolves.toBe(
      false,
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Could not verify DNS through Cloudflare DoH"),
    );
  });

  it("fails closed when Cloudflare DoH returns a non-OK response", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ Status: 0, Answer: [{ name: "todo.example.com" }] }, 503),
      ),
    );

    await expect(resolvesThroughCloudflare("todo.example.com")).resolves.toBe(
      false,
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Cloudflare DoH returned HTTP 503"),
    );
  });

  it("fails closed when Cloudflare DoH returns malformed JSON", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("not-json")),
    );

    await expect(resolvesThroughCloudflare("todo.example.com")).resolves.toBe(
      false,
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Could not verify DNS through Cloudflare DoH"),
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
