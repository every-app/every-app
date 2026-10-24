import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEALTH_PROBE_REUSE_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  resetHealthForTests,
  serveHealth,
  type HealthDatabase,
} from "./health";

function database(
  first: () => Promise<unknown>,
): HealthDatabase & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    prepare: (query) => {
      queries.push(query);
      return { first };
    },
  };
}

const request = (method = "GET") =>
  new Request("https://example.com/health", { method });

afterEach(() => {
  resetHealthForTests();
  vi.useRealTimers();
});

describe("GET /health", () => {
  it("answers 200 ok after one SELECT 1, uncached, and HEAD the same without a body", async () => {
    const db = database(async () => ({ 1: 1 }));
    const get = await serveHealth(request(), db);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/json");
    expect(get.headers.get("cache-control")).toBe("no-store");
    await expect(get.json()).resolves.toEqual({ status: "ok" });
    expect(db.queries).toEqual(["SELECT 1"]);

    resetHealthForTests();
    const head = await serveHealth(request("HEAD"), db);
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");
  });

  it("answers 503 with three words when the database throws or takes too long", async () => {
    vi.useFakeTimers();
    const broken = database(async () => {
      throw new Error("D1_ERROR: no such table");
    });
    const down = await serveHealth(request(), broken, () => 0);
    expect(down.status).toBe(503);
    expect(down.headers.get("cache-control")).toBe("no-store");
    await expect(down.json()).resolves.toEqual({
      status: "error",
      database: "down",
    });

    resetHealthForTests();
    const slow = database(() => new Promise(() => undefined));
    const pending = serveHealth(request(), slow, () => 0);
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);
    const timedOut = await pending;
    expect(timedOut.status).toBe(503);
    await expect(timedOut.json()).resolves.toEqual({
      status: "error",
      database: "down",
    });
  });

  it("answers 503 when prepare itself throws or the binding is missing", async () => {
    const broken: HealthDatabase = {
      prepare: () => {
        throw new Error("no binding");
      },
    };
    const down = await serveHealth(request(), broken);
    expect(down.status).toBe(503);
    await expect(down.json()).resolves.toEqual({
      status: "error",
      database: "down",
    });

    resetHealthForTests();
    const missing = await serveHealth(
      request(),
      undefined as unknown as HealthDatabase,
    );
    expect(missing.status).toBe(503);
  });

  it("refuses other methods with 405 and an Allow header, without touching the database", async () => {
    const db = database(async () => ({ 1: 1 }));
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const response = await serveHealth(request(method), db);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(db.queries).toEqual([]);
  });

  it("shares one probe between concurrent requests and reuses its answer for a few seconds", async () => {
    let release: (value: unknown) => void = () => undefined;
    const db = database(() => new Promise((resolve) => (release = resolve)));
    let now = 1_000;
    const clock = () => now;

    const burst = Promise.all(
      Array.from({ length: 5 }, () => serveHealth(request(), db, clock)),
    );
    await Promise.resolve();
    expect(db.queries).toHaveLength(1);
    release({ 1: 1 });
    for (const response of await burst) expect(response.status).toBe(200);

    // Within the reuse window: no new query.
    now += HEALTH_PROBE_REUSE_MS - 1;
    expect((await serveHealth(request(), db, clock)).status).toBe(200);
    expect(db.queries).toHaveLength(1);

    // Past it: probed again, and a failure now is reported.
    now += 1;
    const failing = database(async () => {
      throw new Error("down");
    });
    expect((await serveHealth(request(), failing, clock)).status).toBe(503);
    expect(failing.queries).toHaveLength(1);
  });
});
