import { describe, expect, it } from "vitest";
import { createCloudflareRest } from "./index";
import { CloudflareApiError, isCloudflareNotFound } from "./errors";
import {
  ACCOUNT_ID,
  API,
  envelope,
  mockFetch,
  noSleep,
} from "./test/mockFetch";

function client(fetch: typeof globalThis.fetch, maxAttempts = 3) {
  return createCloudflareRest({
    apiToken: "token-1",
    accountId: ACCOUNT_ID,
    fetch,
    maxAttempts,
    sleep: noSleep,
  });
}

describe("the transport", () => {
  it("sends the token and asks for JSON", async () => {
    const { fetch, requests } = mockFetch(envelope([]));
    await client(fetch).dispatchNamespaces.list();
    expect(requests[0]!.url).toBe(`${API}/workers/dispatch/namespaces`);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer token-1");
    expect(requests[0]!.headers.get("Accept")).toBe("application/json");
  });

  it("refuses a missing token or a malformed account id", () => {
    expect(() =>
      createCloudflareRest({ apiToken: "", accountId: ACCOUNT_ID }),
    ).toThrow(/token/);
    expect(() =>
      createCloudflareRest({ apiToken: "t", accountId: "acme" }),
    ).toThrow(/account id/);
  });

  it("URL-encodes path segments", async () => {
    const { fetch, requests } = mockFetch(envelope(null));
    await client(fetch).dispatchNamespaces.delete("a/b c");
    expect(requests[0]!.url).toBe(
      `${API}/workers/dispatch/namespaces/a%2Fb%20c`,
    );
  });

  it("maps an error envelope to a CloudflareApiError with code, message and status", async () => {
    const { fetch } = mockFetch(
      envelope(null, {
        status: 404,
        errors: [
          {
            code: 10007,
            message: "This Worker does not exist on your account.",
          },
        ],
      }),
    );
    const error = await client(fetch)
      .dispatchScripts.get("apps", "acme--todo")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 10007,
      context: "Get dispatch script apps/acme--todo",
      message:
        "Get dispatch script apps/acme--todo: [10007] This Worker does not exist on your account.",
    });
    expect(isCloudflareNotFound(error)).toBe(true);
  });

  it("raises success:false even on a 200", async () => {
    const { fetch } = mockFetch(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10021, message: "bad" }],
          result: null,
        }),
        { status: 200 },
      ),
    );
    await expect(client(fetch).dispatchNamespaces.list()).rejects.toMatchObject(
      {
        status: 200,
        code: 10021,
      },
    );
  });

  it("keeps a non-JSON error body in the message", async () => {
    const { fetch } = mockFetch(
      new Response("<html>bad gateway</html>", { status: 502 }),
    );
    await expect(
      client(fetch, 1).dispatchNamespaces.list(),
    ).rejects.toMatchObject({
      status: 502,
      code: undefined,
      message: "List dispatch namespaces: <html>bad gateway</html>",
    });
  });

  it("refuses a successful answer that isn't an envelope", async () => {
    const { fetch } = mockFetch(
      new Response(JSON.stringify([1]), { status: 200 }),
    );
    await expect(client(fetch).dispatchNamespaces.list()).rejects.toThrow(
      /not a Cloudflare API envelope/,
    );
  });

  it("does not count an unknown route or a bad identifier as a missing object", async () => {
    for (const code of [7000, 7003]) {
      const { fetch } = mockFetch(
        envelope(null, {
          status: 404,
          errors: [{ code, message: "No route" }],
        }),
      );
      const error = await client(fetch)
        .dispatchNamespaces.get("apps")
        .catch((e: unknown) => e);
      expect(isCloudflareNotFound(error)).toBe(false);
    }
    const { fetch } = mockFetch(
      envelope(null, {
        status: 404,
        errors: [{ code: 100119, message: "gone" }],
      }),
    );
    const error = await client(fetch)
      .dispatchNamespaces.get("apps")
      .catch((e: unknown) => e);
    expect(isCloudflareNotFound(error)).toBe(true);
  });

  it("retries 429 and 5xx on a GET, honouring Retry-After", async () => {
    const slept: number[] = [];
    const { fetch, requests } = mockFetch(
      new Response("", { status: 429, headers: { "Retry-After": "2" } }),
      new Response("", { status: 503 }),
      envelope([{ namespace_id: "n", namespace_name: "apps" }]),
    );
    const cf = createCloudflareRest({
      apiToken: "t",
      accountId: ACCOUNT_ID,
      fetch,
      random: () => 0.5,
      retryBaseMs: 100,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await expect(cf.dispatchNamespaces.list()).resolves.toHaveLength(1);
    expect(requests).toHaveLength(3);
    expect(slept).toEqual([2000, 200]);
  });

  it("does not retry a POST that failed with a 5xx: it may have been applied", async () => {
    const { fetch, requests } = mockFetch(
      envelope(null, {
        status: 500,
        errors: [{ code: 10013, message: "internal" }],
      }),
      envelope({ uuid: "db", name: "x" }),
    );
    await expect(client(fetch).d1.create("x")).rejects.toMatchObject({
      status: 500,
    });
    expect(requests).toHaveLength(1);
  });

  it("retries a POST on 429, which Cloudflare sends before doing anything", async () => {
    const { fetch, requests } = mockFetch(
      new Response("", { status: 429 }),
      envelope({ uuid: "db", name: "x" }),
    );
    await expect(client(fetch).d1.create("x")).resolves.toEqual({
      uuid: "db",
      name: "x",
    });
    expect(requests).toHaveLength(2);
  });

  it("gives up after maxAttempts and reports status 0 when nothing answered", async () => {
    const { fetch, requests } = mockFetch(new TypeError("fetch failed"));
    const error = await client(fetch, 3)
      .dispatchNamespaces.list()
      .catch((e: unknown) => e);
    expect(requests).toHaveLength(3);
    expect(error).toMatchObject({ status: 0, code: undefined });
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it("does not resend a POST that never got an answer", async () => {
    const { fetch, requests } = mockFetch(new TypeError("fetch failed"));
    await expect(client(fetch, 3).d1.query("db", "SELECT 1")).rejects.toThrow(
      /may have been applied/,
    );
    expect(requests).toHaveLength(1);
  });
});
