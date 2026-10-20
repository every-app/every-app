import { describe, expect, it } from "vitest";
import type { MigrationCliRunner } from "./localCli";
import { migratePostgres } from "./postgres";

const URL = "postgres://app:p%40ss%2Fword@db.example.net:5432/app";

function stub(result: Awaited<ReturnType<MigrationCliRunner>>) {
  const calls: Parameters<MigrationCliRunner>[0][] = [];
  const run: MigrationCliRunner = async (call) => {
    calls.push(call);
    return result;
  };
  return { calls, run };
}

describe("migratePostgres", () => {
  it("runs drizzle-kit migrate with the URL in its environment only", async () => {
    const { calls, run } = stub({ exitCode: 0, stdout: "", stderr: "" });
    await migratePostgres({ cwd: "/app", databaseUrl: URL, run });
    await migratePostgres({ cwd: "/app", databaseUrl: URL, config: "drizzle/pg.config.ts", run });
    expect(calls).toEqual([
      { args: ["migrate"], cwd: "/app", env: { POSTGRES_DATABASE_URL: URL } },
      {
        args: ["migrate", "--config", "drizzle/pg.config.ts"],
        cwd: "/app",
        env: { POSTGRES_DATABASE_URL: URL },
      },
    ]);
  });

  it("reports a failure without the URL or the password, encoded or not", async () => {
    const { run } = stub({
      exitCode: 1,
      stdout: "",
      stderr: `PostgresError: password p@ss/word rejected for ${URL} (p%40ss%2Fword)`,
    });
    const error = await migratePostgres({ cwd: "/app", databaseUrl: URL, run }).catch(
      (caught: unknown) => caught as Error & { code: string },
    );
    expect(error).toMatchObject({ code: "MIGRATION_FAILED" });
    expect(error!.message).toContain("PostgresError: password *** rejected for *** (***)");
    expect(error!.message).not.toMatch(/p@ss|p%40ss|db\.example\.net/);
  });

  it("refuses a URL it can't read before running anything", async () => {
    const { calls, run } = stub({ exitCode: 0, stdout: "", stderr: "" });
    await expect(
      migratePostgres({ cwd: "/app", databaseUrl: "https://db.example.net", run }),
    ).rejects.toMatchObject({ code: "DATABASE_URL_INVALID" });
    expect(calls).toEqual([]);
  });
});
