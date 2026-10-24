import { describe, expect, it } from "vitest";
import { createCfApi, createFakeCfFetch } from "./cf";
import { createGatewayD1, GATEWAY_D1_NAME } from "./gatewayD1";

const ID = "0123456789abcdef0123456789abcdef";

describe("createGatewayD1", () => {
  it("answers nothing while the database does not exist, then finds it once and queries it", async () => {
    let databases: Array<{ uuid: string; name: string }> = [];
    const fake = createFakeCfFetch([
      {
        method: "GET",
        path: new RegExp(`^/accounts/${ID}/d1/database$`),
        reply: () => ({ result: databases }),
      },
      {
        method: "POST",
        path: new RegExp(`^/accounts/${ID}/d1/database/db-gw/query$`),
        reply: (_m, call) => ({
          result: [
            {
              results: [
                { id: "row1", sql: (call.body as { sql: string }).sql },
              ],
              success: true,
            },
          ],
        }),
      },
    ]);
    const d1 = createGatewayD1(
      createCfApi({ token: "t".repeat(30), accountId: ID, fetch: fake.fetch }),
    );
    expect(await d1.databaseId()).toBeNull();
    expect(await d1.query("SELECT 1")).toEqual([]);
    databases = [
      { uuid: "db-other", name: "every-acme-hello--DB" },
      { uuid: "db-gw", name: GATEWAY_D1_NAME },
    ];
    expect(await d1.databaseId()).toBe("db-gw");
    expect(await d1.query("SELECT id FROM owner_setup_tokens", [1])).toEqual([
      { id: "row1", sql: "SELECT id FROM owner_setup_tokens" },
    ]);
    expect(await d1.databaseId()).toBe("db-gw");
    expect(
      fake.calls.filter((c) =>
        c.path.startsWith(`/accounts/${ID}/d1/database?`),
      ).length,
    ).toBe(3);
    expect(fake.calls.at(-1)?.body).toEqual({
      sql: "SELECT id FROM owner_setup_tokens",
      params: [1],
    });
  });
});
