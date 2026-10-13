import { describe, expect, it } from "vitest";
import { CfError } from "./errors";
import { FakeCf } from "./fakeCf";

describe("FakeCf", () => {
  it("records calls, including file contents, and replays scripted output", async () => {
    const cf = new FakeCf().on(["d1", "query"], { stdout: '[{"results":[]}]' });

    const result = await cf.run({
      args: (files) => [
        "d1",
        "query",
        "db-id",
        "--body",
        `@${files["q.json"]}`,
      ],
      plane: "account",
      mode: "json",
      files: { "q.json": { sql: "SELECT 1" } },
    });

    expect(result.stdout).toBe('[{"results":[]}]');
    expect(cf.calls).toEqual([
      {
        args: ["d1", "query", "db-id", "--body", "@/fake-cf-files/q.json"],
        plane: "account",
        cwd: undefined,
        mode: "json",
        local: false,
        env: {},
        files: { "q.json": '{"sql":"SELECT 1"}' },
      },
    ]);
  });

  it("succeeds with empty output for unscripted calls", async () => {
    const cf = new FakeCf();
    await expect(
      cf.run({ args: ["auth", "whoami"], plane: "account", mode: "json" }),
    ).resolves.toEqual({ stdout: "", stderr: "", stoppedByWatchdog: false });
  });

  it("throws the CfError the real runner would for a failed call", async () => {
    const cf = new FakeCf().on((args) => args.includes("--local"), {
      exitCode: 1,
      stderr:
        '┌ Error\n│ Expected a D1 database ID, but received <database>="DB".\n└\n',
    });

    const error = await cf
      .run({
        args: ["d1", "migrations", "apply", "DB", "--local"],
        plane: "project",
        cwd: "/app",
        mode: "json",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CfError);
    expect(error).toMatchObject({ kind: "d1_id_rejected", exitCode: 1 });
  });
});
