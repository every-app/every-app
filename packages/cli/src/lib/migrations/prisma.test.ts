import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migratePrismaPostgres, type PrismaRunner } from "./prisma";

const URL = "postgres://app:p%40ss%2Fword@db.example.net:5432/app";

function stub(result: Awaited<ReturnType<PrismaRunner>>) {
  const calls: Parameters<PrismaRunner>[0][] = [];
  const run: PrismaRunner = async (call) => {
    calls.push(call);
    return result;
  };
  return { calls, run };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("migratePrismaPostgres", () => {
  it("runs prisma migrate deploy with the URL in its environment only", async () => {
    const { calls, run } = stub({ exitCode: 0, stdout: "", stderr: "" });
    await migratePrismaPostgres({ cwd: "/app", databaseUrl: URL, run });
    await migratePrismaPostgres({
      cwd: "/app",
      databaseUrl: URL,
      config: "prisma/pg.config.ts",
      run,
    });
    expect(calls).toEqual([
      { args: ["migrate", "deploy"], cwd: "/app", env: { POSTGRES_DATABASE_URL: URL } },
      {
        args: ["migrate", "deploy", "--config", "prisma/pg.config.ts"],
        cwd: "/app",
        env: { POSTGRES_DATABASE_URL: URL },
      },
    ]);
  });

  it("names Prisma's error code and never the URL or the password, encoded or not", async () => {
    const { run } = stub({
      exitCode: 1,
      stdout: `Loaded Prisma config from prisma.config.ts.\nDatasource "db": PostgreSQL database "app" at ${URL}\n`,
      stderr: `Error: P1000: Authentication failed against database server, the provided database credentials for \`app\` (p@ss/word, p%40ss%2Fword) are not valid.`,
    });
    const error = await migratePrismaPostgres({ cwd: "/app", databaseUrl: URL, run }).catch(
      (caught: unknown) => caught as Error & { code: string },
    );
    expect(error).toMatchObject({ code: "MIGRATION_FAILED" });
    expect(error!.message).toContain(
      "Error: P1000: Authentication failed against database server, the provided database credentials for `app` (***, ***) are not valid.",
    );
    expect(error!.message).toContain("prisma.config.ts");
    expect(error!.message).not.toMatch(/p@ss|p%40ss|postgres:\/\//);
  });

  it("reports a database whose schema Prisma didn't write (P3005)", async () => {
    const { run } = stub({
      exitCode: 1,
      stdout: "",
      stderr:
        "Error: P3005\n\nThe database schema is not empty. Read more about how to baseline an existing production database: https://pris.ly/d/migrate-baseline",
    });
    await expect(migratePrismaPostgres({ cwd: "/app", databaseUrl: URL, run })).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      message: expect.stringContaining("(Error: P3005)"),
    });
  });

  it("refuses a URL it can't read before running anything", async () => {
    const { calls, run } = stub({ exitCode: 0, stdout: "", stderr: "" });
    await expect(
      migratePrismaPostgres({ cwd: "/app", databaseUrl: "https://db.example.net", run }),
    ).rejects.toMatchObject({ code: "DATABASE_URL_INVALID" });
    expect(calls).toEqual([]);
  });

  it("asks for the app's own Prisma CLI when it isn't installed", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-prisma-"));
    dirs.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), "{}");
    await expect(migratePrismaPostgres({ cwd, databaseUrl: URL })).rejects.toMatchObject({
      code: "PRISMA_MISSING",
      message: expect.stringContaining("add prisma to devDependencies"),
    });
  });

  it("runs the app's own Prisma CLI with this Node", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-prisma-"));
    dirs.push(cwd);
    // A stand-in `prisma` package whose bin prints what it got and fails.
    const pkg = path.join(cwd, "node_modules", "prisma");
    fs.mkdirSync(path.join(pkg, "build"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "prisma", version: "7.10.1", bin: { prisma: "build/index.js" } }),
    );
    fs.writeFileSync(
      path.join(pkg, "build", "index.js"),
      [
        "const url = process.env.POSTGRES_DATABASE_URL;",
        "console.error(`Error: P1001: args=${process.argv.slice(2).join(' ')} url=${url} hide=${process.env.PRISMA_HIDE_UPDATE_MESSAGE}`);",
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    await expect(
      migratePrismaPostgres({ cwd, databaseUrl: URL, config: "prisma.config.ts" }),
    ).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      message: expect.stringContaining(
        "Error: P1001: args=migrate deploy --config prisma.config.ts url=*** hide=1",
      ),
    });
  });
});
