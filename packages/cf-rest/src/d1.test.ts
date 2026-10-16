import { describe, expect, it } from "vitest";
import { createCloudflareRest } from "./index";
import {
  ACCOUNT_ID,
  API,
  envelope,
  mockFetch,
  noSleep,
} from "./test/mockFetch";

function client(fetch: typeof globalThis.fetch) {
  return createCloudflareRest({
    apiToken: "t",
    accountId: ACCOUNT_ID,
    fetch,
    sleep: noSleep,
  });
}

describe("D1", () => {
  it("creates a database with an optional location hint, and deletes it", async () => {
    const { fetch, requests } = mockFetch(
      envelope({ uuid: "db-1", name: "acme--todo" }),
    );
    const cf = client(fetch);
    await expect(cf.d1.create("acme--todo")).resolves.toEqual({
      uuid: "db-1",
      name: "acme--todo",
    });
    await cf.d1.create("acme--todo", { primaryLocationHint: "weur" });
    await cf.d1.get("db-1");
    await cf.d1.delete("db-1");
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST ${API}/d1/database`,
      `POST ${API}/d1/database`,
      `GET ${API}/d1/database/db-1`,
      `DELETE ${API}/d1/database/db-1`,
    ]);
    expect(await requests[0]!.json()).toEqual({ name: "acme--todo" });
    expect(await requests[1]!.json()).toEqual({
      name: "acme--todo",
      primary_location_hint: "weur",
    });
  });

  it("finds a database by its exact name, not the search's other matches", async () => {
    const { fetch, requests } = mockFetch(
      envelope([
        { uuid: "db-2", name: "acme--todo--cache" },
        { uuid: "db-1", name: "acme--todo" },
      ]),
      envelope([{ uuid: "db-2", name: "acme--todo--cache" }]),
    );
    const cf = client(fetch);
    await expect(cf.d1.findByName("acme--todo")).resolves.toEqual({
      uuid: "db-1",
      name: "acme--todo",
    });
    await expect(cf.d1.findByName("acme--todo")).resolves.toBeNull();
    expect(requests[0]!.url).toBe(
      `${API}/d1/database?name=acme--todo&per_page=1000`,
    );
  });

  it("queries with parameters and returns the statement's result", async () => {
    const { fetch, requests } = mockFetch(
      envelope([{ results: [{ id: 1 }], success: true, meta: { changes: 0 } }]),
    );
    await expect(
      client(fetch).d1.query<{ id: number }>(
        "db-1",
        "SELECT id FROM t WHERE a = ? AND b = ?",
        ["x", 2],
      ),
    ).resolves.toEqual({
      results: [{ id: 1 }],
      success: true,
      meta: { changes: 0 },
    });
    expect(`${requests[0]!.method} ${requests[0]!.url}`).toBe(
      `POST ${API}/d1/database/db-1/query`,
    );
    expect(await requests[0]!.json()).toEqual({
      sql: "SELECT id FROM t WHERE a = ? AND b = ?",
      params: ["x", 2],
    });
  });

  it("returns a result for each of several statements joined with ;", async () => {
    const sql =
      "CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x'); SELECT a FROM t";
    const joined = mockFetch(
      envelope([
        { results: [], success: true },
        { results: [], success: true, meta: { changes: 1 } },
        { results: [{ a: "x" }], success: true },
      ]),
    );
    const results = await client(joined.fetch).d1.queryAll<{ a: string }>(
      "db-1",
      sql,
    );
    expect(results.map((result) => result.results)).toEqual([
      [],
      [],
      [{ a: "x" }],
    ]);
    expect(await joined.requests[0]!.json()).toEqual({ sql, params: [] });

    // query() is for one statement and never drops the results after it.
    const several = mockFetch(
      envelope([
        { results: [], success: true },
        { results: [{ a: "x" }], success: true },
      ]),
    );
    await expect(
      client(several.fetch).d1.query("db-1", "DELETE FROM t; SELECT a FROM t"),
    ).rejects.toThrow(/2 results for one statement/);
    const none = mockFetch(envelope([]));
    await expect(
      client(none.fetch).d1.query("db-1", "SELECT 1"),
    ).rejects.toThrow(/0 results for one statement/);
  });

  it("batches statements and expects a result for each", async () => {
    const statements = [
      { sql: "INSERT INTO t (a) VALUES (?)", params: ["x"] },
      { sql: "SELECT count(*) AS n FROM t" },
    ];
    const ok = mockFetch(
      envelope([
        { results: [], success: true },
        { results: [{ n: 1 }], success: true },
      ]),
    );
    await expect(
      client(ok.fetch).d1.batch("db-1", statements),
    ).resolves.toHaveLength(2);
    expect(await ok.requests[0]!.json()).toEqual({ batch: statements });

    const short = mockFetch(envelope([{ results: [], success: true }]));
    await expect(
      client(short.fetch).d1.batch("db-1", statements),
    ).rejects.toThrow(/1 results for 2 statements/);
  });

  it("fails on a statement that didn't succeed, and on a SQL error envelope", async () => {
    const failed = mockFetch(envelope([{ results: [], success: false }]));
    await expect(
      client(failed.fetch).d1.query("db-1", "SELECT 1"),
    ).rejects.toThrow(/did not succeed/);
    const sqlError = mockFetch(
      envelope(null, {
        status: 400,
        errors: [{ code: 7500, message: "no such table: t: SQLITE_ERROR" }],
      }),
    );
    await expect(
      client(sqlError.fetch).d1.query("db-1", "SELECT * FROM t"),
    ).rejects.toMatchObject({ status: 400, code: 7500 });
  });
});
