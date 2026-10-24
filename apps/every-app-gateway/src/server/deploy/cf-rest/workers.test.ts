import { describe, expect, it } from "vitest";
import { createCloudflareRest } from "./index";
import { ACCOUNT_ID, API, mockFetch, noSleep } from "./test/mockFetch";

function client(fetch: typeof globalThis.fetch) {
  return createCloudflareRest({
    apiToken: "t",
    accountId: ACCOUNT_ID,
    fetch,
    sleep: noSleep,
  });
}

function page(names: string[], totalPages?: number): Response {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      result: names.map((name) => ({ id: `id-${name}`, name })),
      ...(totalPages ? { result_info: { total_pages: totalPages } } : {}),
    }),
  );
}

describe("account Workers", () => {
  it("lists every page", async () => {
    const { fetch, requests } = mockFetch(page(["a", "b"], 2), page(["c"], 2));
    await expect(client(fetch).workers.list()).resolves.toEqual([
      { id: "id-a", name: "a" },
      { id: "id-b", name: "b" },
      { id: "id-c", name: "c" },
    ]);
    expect(requests.map((r) => r.url)).toEqual([
      `${API}/workers/workers?page=1&per_page=100`,
      `${API}/workers/workers?page=2&per_page=100`,
    ]);
  });

  it("stops at a short page when Cloudflare gives no page count", async () => {
    const { fetch, requests } = mockFetch(page(["a"]));
    await expect(client(fetch).workers.list()).resolves.toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("gets and deletes by name", async () => {
    const { fetch, requests } = mockFetch(page([]));
    const cf = client(fetch);
    await cf.workers.get("every-app-gateway");
    await cf.workers.delete("old-app");
    await cf.workers.delete("old-app", { force: true });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${API}/workers/workers/every-app-gateway`,
      `DELETE ${API}/workers/workers/old-app`,
      `DELETE ${API}/workers/workers/old-app?force=true`,
    ]);
  });
});
